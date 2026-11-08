// Policy store: user-editable governance config persisted to policies.json
// (<home>/policies.json) and live-applied to the pathPolicy / guard-approval
// sets through the ctx "policies" service. Editing here is the source of
// truth; profile config is only the boot-time default.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback);
const atomicWrite = (f, obj) => { const tmp = `${f}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 2)); renameSync(tmp, f); };

export function validatePolicyInput({ blockedDirs, guardedTools } = {}) {
  const check = (arr, label) => {
    if (arr === undefined) return undefined;
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string" || !x.trim() || x.length > 100)) {
      throw new Error(`${label} must be an array of short strings`);
    }
    return [...new Set(arr.map((x) => x.trim()))];
  };
  return { blockedDirs: check(blockedDirs, "blockedDirs"), guardedTools: check(guardedTools, "guardedTools") };
}

export class PolicyStore {
  constructor(homeDir) {
    this.dir = homeDir;
    mkdirSync(homeDir, { recursive: true });
    this.file = join(homeDir, "policies.json");
  }
  get() { return readJson(this.file, { blockedDirs: [], guardedTools: [] }); }
  set(patch) {
    const next = validatePolicyInput(patch);
    const cur = this.get();
    const merged = { ...cur };
    if (next.blockedDirs !== undefined) merged.blockedDirs = next.blockedDirs;
    if (next.guardedTools !== undefined) merged.guardedTools = next.guardedTools;
    atomicWrite(this.file, merged);
    return merged;
  }
}
