import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { bootProfile } from "../src/profile.js";
import { startWebServer } from "../src/web/server.js";

test("web settings: redacted read, write-only key, live reconfigure without restart", async () => {
  // OpenAI-compatible stub
  let sawModel = null;
  const stub = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "stub-1" }] })); }
      sawModel = JSON.parse(b).model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok", tool_calls: [] } }] }));
    });
  });
  await new Promise((r) => stub.listen(0, r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

  const ws = mkdtempSync(join(tmpdir(), "cw-set-ws-"));
  const approval = { current: true };
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: approval, home: mkdtempSync(join(tmpdir(), 'cw-home-')) });
  // profile.home is .code-worker relative to cwd; pass mock=false and no env key -> adapter error only on call
  const proj = ctx.require("projects").create("t");
  const { createAgent } = await import("../src/agents.js");
  createAgent(ctx.require("projects"), proj.id, { name: "a1", description: "tester" });
  const server = await startWebServer({ ctx, store, approval }, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // save via API (key write-only)
    const saved = await (await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: stubUrl, model: "stub-1", apiKey: "secret-key" }) })).json();
    assert.equal(saved.hasApiKey, true);
    assert.equal(saved.model, "stub-1");
    // GET never returns the secret
    const view = await (await fetch(`${base}/api/settings`)).json();
    assert.deepEqual(Object.keys(view).sort(), ["baseUrl", "capabilities", "contextWindow", "hasApiKey", "model", "reasoningEffort", "priceCache", "priceInput", "priceOutput"]);
    assert.ok(!JSON.stringify(view).includes("secret-key"));
    // connection test hits the new endpoint
    const t = await (await fetch(`${base}/api/settings/test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(t.ok, true);
    assert.deepEqual(t.models, ["stub-1"]);
    // a turn now uses the new endpoint/model without restart
    const { id } = await (await fetch(`${base}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: proj.id, agent: "a1" }) })).json();
    await fetch(`${base}/api/sessions/${id}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    for (let i = 0; i < 50; i++) {
      const snap = await (await fetch(`${base}/api/sessions/${id}`)).json();
      if (snap.events.some((e) => e.type === "turn/end")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(sawModel, "stub-1");
  } finally {
    server.close(); stub.close();
    await dispose();
  }
});
