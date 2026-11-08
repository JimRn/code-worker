// ModelConfig provider (P0-4): single assembly point for provider/model.
// Precedence: CLI overrides > OPENAI_*/DEEPSEEK_* env family > stored settings.
// No other module assembles model selection — they only read ctx "modelConfig".
import { ModelConfig, DEFAULT_PROVIDER } from "../../src/model-config.js";

export const plugin = { name: "model-config", deps: ["settings?"],
  configSchema: { properties: { provider: true } }, apply(ctx, env) {
  // Consistent env family: OPENAI_* wins as a set, else DEEPSEEK_*.
  const family = process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.OPENAI_MODEL ? "OPENAI" : "DEEPSEEK";
  const envVal = (n) => process.env[`${family}_${n}`];
  const overrides = env.modelOverrides ?? {};
  const cfg = ctx.raw("settings")?.getConfig?.() ?? {}; // raw: credentials never on the view
  const mc = new ModelConfig({
    provider: env.pluginConfig?.provider ?? DEFAULT_PROVIDER,
    apiKey: overrides.apiKey ?? envVal("API_KEY") ?? cfg.apiKey ?? undefined,
    baseUrl: overrides.baseUrl ?? envVal("BASE_URL") ?? cfg.baseUrl ?? undefined,
    model: overrides.model ?? envVal("MODEL") ?? cfg.model ?? undefined,
    reasoningEffort: cfg.reasoningEffort ?? undefined,
    contextWindow: cfg.contextWindow ?? undefined,
  });
  ctx.provide("modelConfig", mc);
} };
export default plugin;
