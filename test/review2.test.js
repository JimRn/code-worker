import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { startWebServer } from "../src/web/server.js";

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "cw-r2-ws-"));
  const approval = { current: true };
  const ctx0 = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: approval, mock: true, home: mkdtempSync(join(tmpdir(), "cw-r2-home-")),
  });
  const server = await startWebServer({ ...ctx0, approval }, { port: 0, host: "127.0.0.1" });
  return { ...ctx0, server, base: `http://127.0.0.1:${server.address().port}`, ws };
}

test("workspace allowlist: /etc 403, sensitive dir 403, symlink escape 403", async () => {
  const { server, base, dispose, ws } = await boot();
  try {
    const put = (path) => fetch(`${base}/api/workspace`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    assert.equal((await put("/etc")).status, 403);
    assert.equal((await put(join(homedir(), ".ssh"))).status, 403);
    // symlink inside allowed root pointing outside
    const link = join(ws, "evil-link");
    symlinkSync("/etc", link);
    assert.equal((await put(link)).status, 403);
    // inside allowed root is fine
    mkdirSync(join(ws, "ok"));
    assert.equal((await put(join(ws, "ok"))).status, 200);
  } finally { server.close(); await dispose(); }
});

test("settings/test: foreign host rejected (SSRF dead)", async () => {
  const { server, base, dispose } = await boot();
  try {
    const r = await (await fetch(`${base}/api/settings/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "http://169.254.169.254/latest", apiKey: "x" }) })).json();
    assert.equal(r.ok, false);
    assert.match(r.error, /configured host/);
  } finally { server.close(); await dispose(); }
});

test("approval timeout auto-denies (configurable timeoutMs)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-r2-appr-"));
  const approval = { current: false, mode: "per-call", timeoutMs: 100 };
  const { ctx, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: approval, mock: true, home: mkdtempSync(join(tmpdir(), "cw-r2-appr-home-")),
  });
  try {
    const [r] = await ctx.require("tools").execute([{ id: "t1", name: "write_file", args: { path: "x.txt", content: "1" } }]);
    assert.match(r.output, /denied/);
  } finally { await dispose(); }
});
