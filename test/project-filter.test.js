import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { startWebServer } from "../src/web/server.js";

test("sessions filtered by projectId", async () => {
  const approval = { current: true };
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: mkdtempSync(join(tmpdir(), "cw-pf-ws-")), autoApprove: approval, mock: true, home: mkdtempSync(join(tmpdir(), "cw-pf-home-")),
  });
  const server = await startWebServer({ ctx, store, approval }, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const p = ctx.require("projects").create("filt");
    const mk = async (body) => (await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()).id;
    const inProj = await mk({ projectId: p.id });
    // sessions must be project-scoped: unbound create is rejected
    const rejected = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(rejected.status, 400);
    const all = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(all.sessions.length, 1);
    const filtered = await (await fetch(`${base}/api/sessions?projectId=${p.id}`)).json();
    assert.deepEqual(filtered.sessions.map((s) => s.id), [inProj]);
    assert.equal(filtered.sessions[0].projectId, p.id);
  } finally {
    server.close();
    await dispose();
  }
});
