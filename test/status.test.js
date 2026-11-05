import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { startWebServer } from "../src/web/server.js";

test("status surface: snapshot exposes title+usage; client renders conn/running states", async () => {
  const html = readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(html, /id="conn"/);
  assert.match(js, /stream\.onopen/);
  assert.match(js, /stream\.onerror/);
  assert.match(js, /turn\/start/);

  const approval = { current: true };
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: mkdtempSync(join(tmpdir(), "cw-st-ws-")), autoApprove: approval, mock: true, home: mkdtempSync(join(tmpdir(), "cw-st-home-")),
  });
  const server = await startWebServer({ ctx, store, approval }, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST" })).json();
    const snap = await (await fetch(`${base}/api/sessions/${id}`)).json();
    assert.ok("title" in snap && "usage" in snap);
    assert.deepEqual(snap.usage, { prompt: 0, completion: 0, total: 0 });
  } finally {
    server.close();
    await dispose();
  }
});
