// Plugin loader: auto-discovers plugins/<name>/plugin.js (each exports
// {name, deps, apply}). Adding a plugin = adding a directory; no core edits.
// A plugin module may also export its deps as the same shape; loadPlugin
// fails loud when the directory or export is missing.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PLUGINS_DIR = join(rootDir, "plugins");

/** Plugin names = directories under pluginsDir that contain plugin.js, sorted. */
export function listPluginNames(dir = DEFAULT_PLUGINS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "plugin.js")))
    .map((d) => d.name)
    .sort();
}

const cache = new Map(); // pluginsDir -> Map<name, plugin>

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
  plugin.name = plugin.name ?? name;
  plugin.deps = plugin.deps ?? [];
  m.set(name, plugin);
  return plugin;
}
