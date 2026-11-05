import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { startWebServer, lanAddresses } from "../src/web/server.js";

test("web: static + session RPC + turn over SSE", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-web-ws-"));
  const approval = { current: true };
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: approval, mock: true });
  const server = await startWebServer({ ctx, store, approval }, 0);
  const base = `http://localhost:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Code Worker/);
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    assert.ok(id);
    const res = await fetch(`${base}/api/sessions/${id}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "list files", autoApprove: true }) });
    assert.equal(res.status, 202);
    // wait for turn to finish via polling the session snapshot
    for (let i = 0; i < 50; i++) {
      const snap = await (await fetch(`${base}/api/sessions/${id}`)).json();
      if (snap.events.some((e) => e.type === "turn/end")) {
        assert.ok(snap.events.some((e) => e.type === "tool/result"));
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    server.close();
    await dispose();
  }
});

test("web LAN: token auth gates /api; lanAddresses lists non-internal IPv4", async () => {
  assert.ok(Array.isArray(lanAddresses()));
  const ws = mkdtempSync(join(tmpdir(), "cw-web-lan-"));
  const approval = { current: true };
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: approval, mock: true });
  const server = await startWebServer({ ctx, store, approval, token: "s3cret" }, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${base}/api/sessions?token=s3cret`)).status, 200);
    assert.equal((await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer s3cret" } })).status, 200);
    assert.equal((await fetch(`${base}/api/sessions?token=wrong`)).status, 401);
  } finally {
    server.close();
    await dispose();
  }
});
