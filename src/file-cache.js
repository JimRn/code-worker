// File cache service: tiny mtime cache for small config-like files read on
// hot paths (project AGENTS.md, skill/agent indexes). Per-boot instance is
// provided as ctx "fileCache" so its state is disposable with the profile;
// the module-level default keeps pure-function callers working.
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

export const defaultFileCache = new FileCache();

/** Back-compat free function over the default instance. */
export function cachedRead(file, cache = defaultFileCache) {
  return cache.read(file);
}
