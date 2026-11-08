import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session.js";

test("usageTotals sums assistant/message usage", async () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "cw-use-")));
  const s = store.create();
  await s.append("assistant/message", { text: "a", usage: { prompt_tokens: 10, completion_tokens: 5 } });
  await s.append("assistant/message", { text: "b" }); // no usage: skipped
  await s.append("assistant/message", { text: "c", usage: { prompt_tokens: 20, completion_tokens: 7 } });
  assert.deepEqual(s.usageTotals(), { prompt: 30, completion: 12, total: 42, cacheRead: 0, cacheWrite: 0, hitRate: 0 });
});
