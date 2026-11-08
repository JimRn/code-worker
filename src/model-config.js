// ModelConfig service: single source of truth for model/provider selection.
// Plugins only read ctx.require("modelConfig"); no other module hard-codes
// a provider name. Values are mutable so the Web settings page can live-update.
export class ModelConfig {
  constructor({ provider = "openai-compatible", apiKey, baseUrl, model, reasoningEffort, contextWindow } = {}) {
    this.provider = provider;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.contextWindow = contextWindow;
  }
}
