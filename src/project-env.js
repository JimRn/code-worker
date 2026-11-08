// Project-level environment variables, shared by all agents of the project.
//
// Storage (per project dir):
//   .env.vars.json    plain values  { KEY: value }
//   .env.secrets.json password-type { KEY: value }  (mode 0600)
//
// Privacy contract:
// - Secret values never reach logs, system prompts, or API reads (write-only:
//   list() reports hasValue, never the value).
// - Plain values are model-visible (injected into the system prompt) and
//   readable, matching model-visible <=> logged.
// - Agents still *use* secrets: shell/terminal execution merges the full env
//   (secrets included) into the child process env, never into the log.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE = 64 * 1024;

const readJson = (f, fallback) => {
  if (!existsSync(f)) return fallback;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; }
};
const atomicWrite = (f, obj, mode) => {
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, f);
};

export function validateKey(key) {
  if (!KEY_RE.test(String(key ?? ""))) throw new Error(`invalid env key: ${key} (use A-Z, 0-9, _)`);
  if (String(key).toUpperCase().startsWith("CW_") || String(key).toUpperCase().startsWith("OPENAI_")) {
    throw new Error(`reserved env key prefix: ${key}`);
  }
}

export class ProjectEnvStore {
  constructor(projectDir) {
    this.dir = projectDir;
    mkdirSync(projectDir, { recursive: true });
    this.varsFile = join(projectDir, ".env.vars.json");
    this.secretsFile = join(projectDir, ".env.secrets.json");
  }
  /** Metadata for the UI: [{key, secret, hasValue}] — never secret values. */
  list() {
    const vars = readJson(this.varsFile, {});
    const secrets = readJson(this.secretsFile, {});
    return [
      ...Object.keys(vars).map((k) => ({ key: k, secret: false, hasValue: true })),
      ...Object.keys(secrets).map((k) => ({ key: k, secret: true, hasValue: Boolean(secrets[k]) })),
    ].sort((a, b) => a.key.localeCompare(b.key));
  }
  /** Plain values only (model-visible, safe to inject into prompts). */
  plain() { return readJson(this.varsFile, {}); }
  /** Full env for child processes: plain + secrets (never logged). */
  all() { return { ...readJson(this.varsFile, {}), ...readJson(this.secretsFile, {}) }; }
  get(key) { return this.all()[key]; }
  set(key, value, { secret = false } = {}) {
    validateKey(key);
    if (typeof value !== "string") throw new Error("env value must be a string");
    if (value.length > MAX_VALUE) throw new Error("env value too large (64KB)");
    const vars = readJson(this.varsFile, {});
    const secrets = readJson(this.secretsFile, {});
    delete vars[key]; delete secrets[key];
    if (secret) secrets[key] = value; else vars[key] = value;
    atomicWrite(this.varsFile, vars);
    atomicWrite(this.secretsFile, secrets, 0o600);
  }
  delete(key) {
    const vars = readJson(this.varsFile, {});
    const secrets = readJson(this.secretsFile, {});
    delete vars[key]; delete secrets[key];
    atomicWrite(this.varsFile, vars);
    atomicWrite(this.secretsFile, secrets, 0o600);
  }
}
