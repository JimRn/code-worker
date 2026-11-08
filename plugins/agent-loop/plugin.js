import { AgentLoop } from "../../src/agent-loop.js";
export const plugin = { name: "agent-loop", deps: ["tools", "llm", "modelConfig", "isolate?"],
  configSchema: { properties: { maxSteps: true, toolResultMaxBytes: true } }, apply(ctx, env) {
  const pc = env.pluginConfig ?? {};
  ctx.provide("agentLoop", new AgentLoop(ctx, {
    maxSteps: pc.maxSteps ?? env.maxSteps, toolResultMaxBytes: pc.toolResultMaxBytes ?? env.toolResultMaxBytes,
    modelConfig: ctx.require("modelConfig"),
  }));
} };
export default plugin;
