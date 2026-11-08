import { LlmService, OpenAICompatibleAdapter, MockAdapter } from "../../src/llm.js";
export const plugin = { name: "llm", deps: ["modelConfig"], serviceMethods: ["registerAdapter", "prepareCall"], apply(ctx, env) {
  const modelConfig = ctx.require("modelConfig");
  const llm = new LlmService();
  ctx.provide("llm", llm);
  // Single provider-selection branch: both adapters register under the
  // configured provider name so callers never know which backend is live.
  const name = modelConfig.provider;
  const adapter = env.mock ? new MockAdapter() : new OpenAICompatibleAdapter({ config: modelConfig });
  ctx.effect(() => llm.registerAdapter(name, adapter));
} };
export default plugin;
