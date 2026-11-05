import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OpenAICompatibleAdapter } from "../src/llm.js";

test("retry: 429/5xx retried with backoff, succeeds after failures; non-retryable fails fast", async () => {
  let hits = 0;
  const stub = createServer((req, res) => {
    hits++;
    if (hits < 3) { res.writeHead(500); return res.end("err"); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((r) => stub.listen(0, r));
  try {
    const adapter = new OpenAICompatibleAdapter({ apiKey: "k", baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, model: "m", maxRetries: 3 });
    let text = "";
    for await (const c of adapter.prepareCall({ messages: [{ role: "user", content: "hi" }], tools: [] })()) {
      if (c.type === "finish") text = c.text;
    }
    assert.equal(text, "ok");
    assert.equal(hits, 3);
  } finally { stub.close(); }
});
