// Tiny mtime cache for small config-like files read on hot paths
// (project AGENTS.md, skill index). Avoids sync reads every turn.
import { readFileSync, statSync } from "node:fs";

const cache = new Map(); // path -> {mtimeMs, content}

export function cachedRead(file) {
  let st;
  try { st = statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.content;
  const content = readFileSync(file, "utf8");
  cache.set(file, { mtimeMs: st.mtimeMs, content });
  return content;
}
