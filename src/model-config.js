// ModelConfig service: single source of truth for model/provider selection.
// Plugins only read ctx.require("modelConfig"); no other module hard-codes
// a provider name. Values are mutable so the Web settings page can live-update.
export const DEFAULT_PROVIDER = "openai-compatible"; // sole default authority

export class ModelConfig {
  constructor({ provider = DEFAULT_PROVIDER, apiKey, baseUrl, model, reasoningEffort, contextWindow } = {}) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.contextWindow = contextWindow;
  }
}
