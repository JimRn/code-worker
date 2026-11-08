// Plugin loader: auto-discovers plugins/<name>/plugin.js (each exports
// {name, deps, apply}). Adding a plugin = adding a directory; no core edits.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PLUGINS_DIR = join(rootDir, "plugins");

/** Plugin names = directories under pluginsDir that contain plugin.js, sorted.
 * Symlink dirs are followed; dirs missing plugin.js are reported, not hidden. */
export function listPluginNames(dir = DEFAULT_PLUGINS_DIR) {
  if (!existsSync(dir)) return [];
  const names = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (!d.isDirectory() && !statSync(full).isDirectory()) continue;
    if (existsSync(join(full, "plugin.js"))) names.push(d.name);
    else console.warn(`[plugin-loader] ${full}: no plugin.js (ignored)`);
  }
  return names.sort();
}

const cache = new Map(); // pluginsDir -> Map<name, plugin>

/** Drop cached plugin modules (dev: after editing a plugin in-process). */
export function clearPluginCache(dir) {
  if (dir) cache.delete(dir);
  else cache.clear();
}

/** Load one plugin module; rejects with a named error when missing/malformed. */
export async function loadPlugin(name, dir = DEFAULT_PLUGINS_DIR) {
  if (!cache.has(dir)) cache.set(dir, new Map());
  const m = cache.get(dir);
  if (m.has(name)) return m.get(name);
  const file = join(dir, name, "plugin.js");
  if (!existsSync(file)) throw new Error(`Unknown plugin (no plugins/${name}/plugin.js): ${name}. Available: ${listPluginNames(dir).join(", ") || "(none)"}`);
  const mod = await import(pathToFileURL(file).href);
  const plugin = mod.plugin ?? mod.default;
  if (!plugin || typeof plugin.apply !== "function") throw new Error(`Plugin ${name} must export {name, deps, apply}`);
  if (plugin.name && plugin.name !== name) throw new Error(`Plugin ${name}: declared name "${plugin.name}" does not match directory name`);
  if (!Array.isArray(plugin.deps ?? []) || (plugin.deps ?? []).some((d) => typeof d !== "string")) throw new Error(`Plugin ${name}: deps must be an array of strings`);
  plugin.name = plugin.name ?? name;
  plugin.deps = plugin.deps ?? [];
  m.set(name, plugin);
  return plugin;
}
