import { LlmService, OpenAICompatibleAdapter, MockAdapter } from "../../src/llm.js";
import { DEFAULT_PROVIDER } from "../../src/model-config.js";
export const plugin = { name: "llm", deps: ["modelConfig"], apply(ctx, env) {
  const modelConfig = ctx.require("modelConfig");
  const llm = new LlmService();
  ctx.provide("llm", llm);
  // Single provider-selection branch: both adapters register under the
  // configured provider name so callers never know which backend is live.
  const name = modelConfig.provider ?? DEFAULT_PROVIDER;
  const adapter = env.mock ? new MockAdapter() : new OpenAICompatibleAdapter({ config: modelConfig });
  ctx.effect(() => llm.registerAdapter(name, adapter));
} };
export default plugin;
