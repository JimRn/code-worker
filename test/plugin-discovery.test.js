import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPluginNames, loadPlugin } from "../src/plugin-loader.js";
import { bootProfile } from "../src/profile.js";

test("plugin discovery: list/load from an external plugins dir without core edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-pdirs-"));
  mkdirSync(join(dir, "hello"), { recursive: true });
  writeFileSync(join(dir, "hello", "plugin.js"), `
export const plugin = { name: "hello", deps: [], apply(ctx) { ctx.provide("hello", { msg: "hi" }); } };
`);
  assert.deepEqual(listPluginNames(dir), ["hello"]);
  const hello = await loadPlugin("hello", dir);
  assert.equal(hello.name, "hello");
  await assert.rejects(() => loadPlugin("nope", dir), /Unknown plugin/);
});

test("compaction is eventized: loop runs without the compaction plugin; with it, agent/pre-step prunes", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-evt-ws-"));
  const plugins = ["session", "tools", "fs-local", "tool-fs", "shell-local", "tool-bash", "settings", "model-config", "llm", "agent-loop", "guard-approval"];
  const profile = { name: "t", home: mkdtempSync(join(tmpdir(), "cw-evt-home-")), plugins };
  const profilePath = join(tmpdir(), `cw-evt-${Date.now()}.json`);
  writeFileSync(profilePath, JSON.stringify(profile));
  const { ctx, store, dispose } = await bootProfile(profilePath, { workspace: ws, autoApprove: true, mock: true, home: profile.home });
  try {
    assert.equal(ctx.get("compaction"), undefined);
    const session = store.create();
    await ctx.require("agentLoop").runTurn(session, "hello"); // no compaction service at all
    assert.ok(session.events.some((e) => e.type === "turn/end"));
  } finally { await dispose(); }

  // With compaction plugin loaded, the same payload through agent/pre-step is pruned.
  const { ctx: ctx2, store: store2, dispose: dispose2 } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-evt-home2-")),
  });
  try {
    const big = "x".repeat(5000);
    const out = await ctx2.waterfall("agent/pre-step", {
      messages: [{ role: "tool", tool_call_id: "1", content: big }, { role: "tool", tool_call_id: "2", content: big }],
      session: store2.create(), systemChars: 0,
    });
    // keepRecent=4 keeps both, so verify pruning logic only after adding many:
    const many = Array.from({ length: 6 }, (_, i) => ({ role: "tool", tool_call_id: String(i), content: big }));
    const out2 = await ctx2.waterfall("agent/pre-step", { messages: many, session: store2.create(), systemChars: 0 });
    assert.ok(out2.messages[0].content.length < big.length);
    void out;
  } finally { await dispose2(); }
});

test("modelConfig is the single source: loop provider follows the service, not a hard-coded literal", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-mc-ws-"));
  const { ctx, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-mc-home-")),
  });
  try {
    const mc = ctx.require("modelConfig");
    assert.equal(ctx.require("agentLoop").provider, mc.provider);
    mc.provider = "custom-provider";
    assert.equal(ctx.require("agentLoop").provider, "custom-provider");
  } finally { await dispose(); }
});
