// Profile loader: dispatch profile.plugins in declared order, loading each
// plugin from plugins/<name>/plugin.js (auto-discovery, no static registry).
// The plugins array is the composition — removing/adding a line changes the
// tree without editing this file or any core module.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "./context.js";
import { DEFAULT_PLUGINS_DIR, listPluginNames, loadPlugin } from "./plugin-loader.js";

/** Per-plugin config: profile.config.plugins[name] is validated against the
 * plugin's declared configSchema (unknown keys fail loud, named). */
export function validatePluginConfig(name, plugin, config) {
  const schema = plugin.configSchema;
  if (config === undefined || config === null) return {};
  if (!schema) throw new Error(`Plugin ${name} declares no configSchema but profile sets config.plugins.${name}`);
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  const unknown = Object.keys(config).filter((k) => !allowed.has(k));
  if (unknown.length) throw new Error(`Plugin ${name}: unknown config key(s) ${unknown.join(", ")} (allowed: ${[...allowed].join(", ") || "(none)"})`);
  return config;
}

export async function bootProfile(profilePath, { workspace, autoApprove = false, mock = false, model, apiKey, baseUrl, home, pluginsDir = DEFAULT_PLUGINS_DIR } = {}) {
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  if (home) profile.home = home; // tests point home at a temp dir
  const cfg = { ...profile.config, workspace: workspace ?? profile.config?.workspace ?? process.cwd() };
  const ctx = new Context();

  // Raw inputs only — each plugin assembles its own services/config from
  // these (e.g. model-config plugin builds ctx "modelConfig").
  const sharedEnv = {
    home: profile.home ?? ".code-worker",
    projectsDir: join(profile.home ?? ".code-worker", "projects"),
    workspace: cfg.workspace,
    mock,
    modelOverrides: { apiKey, baseUrl, model },
    maxSteps: cfg.maxSteps,
    toolResultMaxBytes: cfg.toolResultMaxBytes,
    compaction: cfg.compaction,
    approval: autoApprove,
    guardedTools: cfg.guardedTools ?? ["write_file", "bash"],
    shellTimeoutMs: cfg.shellTimeoutMs ?? 30000,
    approvalTimeoutMs: cfg.approvalTimeoutMs ?? 30000,
  };

  const list = profile.plugins ?? listPluginNames(pluginsDir);
  const dupes = list.filter((n, i) => list.indexOf(n) !== i);
  if (dupes.length) throw new Error(`Profile ${profile.name ?? profilePath}: duplicate plugin(s): ${[...new Set(dupes)].join(", ")}`);
  for (const name of list) {
    const plugin = await loadPlugin(name, pluginsDir);
    for (const dep of plugin.deps ?? []) {
      const optional = dep.endsWith("?");
      const key = optional ? dep.slice(0, -1) : dep;
      if (!ctx.get(key)) {
        if (optional) console.warn(`[profile] Plugin ${name} optional dep ctx.${key} missing (degraded mode)`);
        else throw new Error(`Plugin ${name} requires ctx.${dep} (missing: check profile order)`);
      }
    }
    // Per-plugin config travels on env.pluginConfig for this plugin only.
    const pluginConfig = validatePluginConfig(name, plugin, profile.config?.plugins?.[name]);
    // Capability declaration travels with the plugin (not a core table).
    if (plugin.serviceMethods?.length) ctx.registerMethods(plugin.provides ?? name, plugin.serviceMethods);
    await plugin.apply(ctx, { ...sharedEnv, pluginConfig });
  }

  return { ctx, profile, store: ctx.require("sessions"), dispose: () => ctx.dispose() };
}
