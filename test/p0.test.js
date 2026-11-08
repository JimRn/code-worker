import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmService } from "../src/llm.js";
import { wrapService } from "../src/service-definitions.js";

test("LlmService forwards abort signal to adapter", async () => {
  const llm = new LlmService();
  let seenSignal;
  llm.registerAdapter("test", { prepareCall({ signal }) { seenSignal = signal; return async function* () { yield { type: "finish", text: "ok", toolCalls: [] }; }; } });
  const ctl = new AbortController();
  const bound = llm.prepareCall({ provider: "test", messages: [], signal: ctl.signal });
  for await (const c of bound()) { /* drain */ }
  assert.equal(seenSignal, ctl.signal);
});

test("capability view: proxy cannot be escaped via prototype/constructor", () => {
  const view = wrapService("fs", {
    root: "/ws",
    readFile: async () => "x",
    writeFile: async () => "w",
    listDir: async () => "",
    listEntries: async () => [],
    withRoot: (d, fn) => fn(),
    resolve: (p) => p,
    defaultRoot: "/secret",
  });
  assert.equal(Object.getPrototypeOf(view), null);
  assert.equal(view.defaultRoot, undefined);
  assert.equal(view.readFile, view.readFile); // stable bound identity
  assert.equal(Object.getPrototypeOf(view)?.constructor, undefined);
});
