// Profile loader: dispatch profile.plugins in declared order through the
// plugin registry (src/plugins.js). The plugins array is the composition —
// removing/adding a line changes the tree without editing this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "./context.js";
import { PLUGINS } from "./plugins.js";
import { SettingsStore } from "./web/settings.js";

export async function bootProfile(profilePath, { workspace, autoApprove = false, mock = false, model, apiKey, baseUrl, home } = {}) {
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  if (home) profile.home = home; // tests point home at a temp dir
  const cfg = { ...profile.config, workspace: workspace ?? profile.config?.workspace ?? process.cwd() };
  const ctx = new Context();

  // Consistent env family: OPENAI_* wins as a set, else DEEPSEEK_* (no cross-mixing).
  const envFamily = process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.OPENAI_MODEL ? "OPENAI" : "DEEPSEEK";
  const env = (n) => process.env[`${envFamily}_${n}`];
  const modelConfig = {
    apiKey: apiKey ?? env("API_KEY") ?? undefined,
    baseUrl: baseUrl ?? env("BASE_URL") ?? undefined,
    model: model ?? env("MODEL") ?? undefined,
  };

  // Settings constructed once, up front; seeds model config fallbacks.
  const settings = new SettingsStore(profile.home ?? ".code-worker");
  modelConfig.apiKey ??= settings.getApiKey();
  modelConfig.baseUrl ??= settings.getConfig().baseUrl;
  modelConfig.model ??= settings.getConfig().model;
  modelConfig.reasoningEffort ??= settings.getConfig().reasoningEffort;

  const sharedEnv = {
    home: profile.home ?? ".code-worker",
    projectsDir: join(profile.home ?? ".code-worker", "projects"),
    workspace: cfg.workspace,
    mock,
    modelConfig,
    maxSteps: cfg.maxSteps,
    toolResultMaxBytes: cfg.toolResultMaxBytes,
    compaction: cfg.compaction,
    approval: autoApprove,
    guardedTools: cfg.guardedTools ?? ["write_file", "bash"],
    shellTimeoutMs: cfg.shellTimeoutMs ?? 30000,
    approvalTimeoutMs: cfg.approvalTimeoutMs ?? 30000,
  };

  for (const name of profile.plugins ?? Object.keys(PLUGINS)) {
    const plugin = PLUGINS[name];
    if (!plugin) throw new Error(`Unknown plugin in profile: ${name}`);
    for (const dep of plugin.deps ?? []) {
      const optional = dep.endsWith("?");
      const key = optional ? dep.slice(0, -1) : dep;
      if (!ctx.get(key)) {
        if (optional) console.warn(`[profile] Plugin ${name} optional dep ctx.${key} missing (degraded mode)`);
        else throw new Error(`Plugin ${name} requires ctx.${dep} (missing: check profile order)`);
      }
    }
    await plugin.apply(ctx, sharedEnv);
  }

  return { ctx, profile, store: ctx.require("sessions"), dispose: () => ctx.dispose() };
}
