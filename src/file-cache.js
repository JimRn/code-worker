// File cache service: tiny mtime cache for small config-like files read on
// hot paths (project AGENTS.md, skill/agent indexes). Instances are
// per-boot (ctx "fileCache") so state is disposable with the profile.
// Pure-function callers must pass an explicit cache; no module singleton.
import { readFileSync, statSync } from "node:fs";

export class FileCache {
  constructor(maxEntries = 200) {
    this.entries = new Map(); // path -> {mtimeMs, content}
    this.maxEntries = maxEntries;
  }
  read(file) {
    let st;
    try { st = statSync(file); } catch { this.entries.delete(file); return null; }
    const hit = this.entries.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.content;
    const content = readFileSync(file, "utf8");
    this.entries.set(file, { mtimeMs: st.mtimeMs, content });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return content;
  }
  clear() { this.entries.clear(); }
}

/** Back-compat free function: explicit cache, else a fresh (uncached) instance. */
export function cachedRead(file, cache = new FileCache()) {
  return cache.read(file);
}
