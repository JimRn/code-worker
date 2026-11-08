import { test } from "node:test";
import assert from "node:assert/strict";
import { EV } from "../src/events.js";
import { Context } from "../src/context.js";
import { DEFAULT_PROVIDER } from "../src/model-config.js";
import { LlmService } from "../src/llm.js";

test("EV constants are the wired event names (guard-wrapped listener fires via constant)", async () => {
  const ctx = new Context();
  let hit = 0;
  ctx.on(EV.AGENT_PRE_STEP, async (v, next) => { hit++; return next(v); }, "waterfall");
  await ctx.waterfall("agent/pre-step", {});
  assert.equal(hit, 1);
  for (const v of Object.values(EV)) assert.match(v, /^[\w/-]+$/);
  await ctx.dispose();
});

test("DEFAULT_PROVIDER single-source and single-adapter fallback on rename", async () => {
  assert.equal(DEFAULT_PROVIDER, "openai-compatible");
  const llm = new LlmService();
  llm.registerAdapter("renamed-provider", { prepareCall: () => async function* () { yield { type: "finish", text: "ok", toolCalls: [] }; } });
  const bound = llm.prepareCall({ provider: DEFAULT_PROVIDER, messages: [] });
  let out;
  for await (const c of bound()) out = c;
  assert.equal(out.text, "ok");
});
