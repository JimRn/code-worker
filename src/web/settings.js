// Settings store (mirrors DSH settings-controller + credentials seam):
// settings.json holds non-secret config; credentials.json holds the API key
// WRITE-ONLY — GET never returns the secret value, only hasApiKey.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback);
const atomicWrite = (f, obj, mode) => {
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, f);
};

export class SettingsStore {
  constructor(homeDir) {
    this.dir = homeDir;
    mkdirSync(homeDir, { recursive: true });
    this.settingsFile = join(homeDir, "settings.json");
    this.credsFile = join(homeDir, "credentials.json");
  }
  /** Redacted view for the browser: never contains the secret. */
  describe() {
    const s = readJson(this.settingsFile, {});
    const c = readJson(this.credsFile, {});
    return {
      baseUrl: s.baseUrl ?? "",
      model: s.model ?? "",
      reasoningEffort: s.reasoningEffort ?? "",
      contextWindow: s.contextWindow ?? "",
      priceInput: s.priceInput ?? "",
      priceOutput: s.priceOutput ?? "",
      priceCache: s.priceCache ?? "",
      hasApiKey: Boolean(c.apiKey),
    };
  }
  /** Save config; apiKey is written only when a non-empty value is provided. */
  update({ baseUrl, model, apiKey, reasoningEffort, contextWindow, priceInput, priceOutput, priceCache }) {
    if (baseUrl !== undefined) {
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must be an http(s) URL");
      const s = readJson(this.settingsFile, {});
      s.baseUrl = baseUrl;
      atomicWrite(this.settingsFile, s);
    }
    if (model !== undefined) {
      const s = readJson(this.settingsFile, {});
      s.model = model;
      atomicWrite(this.settingsFile, s);
    }
    if (contextWindow !== undefined) {
      const n = Number(contextWindow);
      if (contextWindow && (!Number.isFinite(n) || n < 4000)) throw new Error("contextWindow must be >= 4000 or empty");
      const s = readJson(this.settingsFile, {});
      if (contextWindow) s.contextWindow = Math.floor(n);
      else delete s.contextWindow;
      atomicWrite(this.settingsFile, s);
    }
    if (reasoningEffort !== undefined) {
      if (reasoningEffort && !["low", "medium", "high"].includes(reasoningEffort)) throw new Error("reasoningEffort must be low/medium/high or empty");
      const s = readJson(this.settingsFile, {});
      if (reasoningEffort) s.reasoningEffort = reasoningEffort;
      else delete s.reasoningEffort;
      atomicWrite(this.settingsFile, s);
    }
    for (const [k, v] of [["priceInput", priceInput], ["priceOutput", priceOutput], ["priceCache", priceCache]]) {
      if (v !== undefined) {
        const n = v === "" ? undefined : Number(v);
        if (v !== "" && (!Number.isFinite(n) || n < 0)) throw new Error(`${k} must be a non-negative number (USD per 1M tokens)`);
        const s2 = readJson(this.settingsFile, {});
        if (n === undefined) delete s2[k]; else s2[k] = n;
        atomicWrite(this.settingsFile, s2);
      }
    }
    if (apiKey) { // empty = leave stored credential untouched (never echo secrets)
      atomicWrite(this.credsFile, { apiKey }, 0o600);
    }
    return this.describe();
  }
  getWorkspace() { return readJson(this.settingsFile, {}).workspace; }
  setWorkspace(path) {
    const s = readJson(this.settingsFile, {});
    s.workspace = path;
    atomicWrite(this.settingsFile, s);
    return path;
  }
  /** Server-side only: real key for the wire. Never exposed via API. */
  getApiKey() { return readJson(this.credsFile, {}).apiKey; }
  getConfig() {
    const s = readJson(this.settingsFile, {});
    return { baseUrl: s.baseUrl, model: s.model, reasoningEffort: s.reasoningEffort, contextWindow: s.contextWindow, priceInput: s.priceInput, priceOutput: s.priceOutput, priceCache: s.priceCache, apiKey: this.getApiKey() };
  }
  /** Model fields for model-config assembly — the single sanctioned path for
   * the stored key (describe()/API reads still never return it). */
  getModelConfig() {
    const s = readJson(this.settingsFile, {});
    return { baseUrl: s.baseUrl, model: s.model, reasoningEffort: s.reasoningEffort, contextWindow: s.contextWindow, priceInput: s.priceInput, priceOutput: s.priceOutput, priceCache: s.priceCache, apiKey: this.getApiKey() };
  }
}
