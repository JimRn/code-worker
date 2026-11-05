import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { bootProfile } from "../src/profile.js";

test("streaming: SSE chunks assembled, tool_calls reassembled, live frames not persisted", async () => {
  // OpenAI-compatible SSE stub: text in 2 chunks, tool_call split across 3 chunks.
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ delta: { content: "Hel" } }] });
    send({ choices: [{ delta: { content: "lo" } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "list_dir", arguments: '{"pa' } }] } }] });
    send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "."}' } }] } }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => stub.listen(0, r));
  const baseUrl = `http://127.0.0.1:${stub.address().port}/v1`;

  const ws = mkdtempSync(join(tmpdir(), "cw-str-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, home: mkdtempSync(join(tmpdir(), "cw-str-home-")),
    baseUrl, model: "stub", apiKey: "k",
  });
  try {
    const session = store.create();
    const live = [];
    session.subscribe((ev) => { if (ev.live) live.push(ev); });
    await ctx.require("agentLoop").runTurn(session, "hi");
    // assembled from chunks
    const assistant = session.events.filter((e) => e.type === "assistant/message");
    assert.equal(assistant[0].data.text, "Hello");
    assert.deepEqual(assistant[0].data.toolCalls, [{ id: "c1", name: "list_dir", args: { path: "." } }]);
    // live chunks were broadcast but never persisted
    assert.ok(live.some((e) => e.type === "assistant/chunk" && e.data.delta === "Hel"));
    assert.ok(!session.events.some((e) => e.type === "assistant/chunk"));
    // tool actually ran and turn completed
    assert.ok(session.events.some((e) => e.type === "turn/end"));
  } finally {
    stub.close();
    await dispose();
  }
});
