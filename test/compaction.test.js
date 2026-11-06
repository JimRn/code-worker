import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { pruneToolResults, estimateChars } from "../src/compaction.js";

test("prune: old tool results truncated, recent kept verbatim", () => {
  const big = "x".repeat(5000);
  const msgs = [
    { role: "user", content: "a" },
    { role: "tool", tool_call_id: "1", content: big },
    { role: "tool", tool_call_id: "2", content: big },
    { role: "tool", tool_call_id: "3", content: big },
  ];
  const out = pruneToolResults(msgs, { maxBytes: 2000, keepLast: 1 });
  assert.ok(out[1].content.length <= 2000 && out[1].content.includes("[pruned]"));
  assert.ok(out[2].content.length <= 2000);
  assert.equal(out[3].content, big); // most recent untouched
  assert.ok(estimateChars(out) < estimateChars(msgs));
});

test("compact: summarizes old turns into a durable event; projection drops pre-summary history", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-cmp-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-cmp-home-")),
  });
  try {
    const session = store.create();
    for (let i = 0; i < 6; i++) {
      await session.append("user/message", { text: `question ${i}` });
      await session.append("assistant/message", { text: `answer ${i}`, toolCalls: [] });
    }
    const before = session.deriveMessages().length;
    const text = await ctx.require("compaction").compact(session);
    assert.ok(text && text.length > 0);
    assert.ok(session.events.some((e) => e.type === "compaction/summary"));
    const after = session.deriveMessages();
    assert.ok(after.length < before);
    assert.match(after[0].content, /summarized/);
    // nothing to compact when history is short
    const s2 = store.create();
    await s2.append("user/message", { text: "hi" });
    assert.equal(await ctx.require("compaction").compact(s2), null);
  } finally {
    await dispose();
  }
});
