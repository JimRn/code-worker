// Profile loader: compose a plugin tree from an ordered profile (personal.json).
// Mirrors DSH: profile bundles apply in order; every registration is a reversible effect.
import { readFileSync } from "node:fs";
import { Context } from "./context.js";
import { SessionStore } from "./session.js";
import { ToolRegistry, installApprovalGuard } from "./tools.js";
import { LocalFs, registerFsTools } from "./fs.js";
import { LocalShell, registerBashTool } from "./shell.js";
import { LlmService, OpenAICompatibleAdapter, MockAdapter } from "./llm.js";
import { AgentLoop } from "./agent-loop.js";
import { SettingsStore } from "./web/settings.js";
import { registerTodoTools } from "./todo.js";
import { ProjectStore } from "./projects.js";

export async function bootProfile(profilePath, { workspace, autoApprove = false, mock = false, model, apiKey, baseUrl, home } = {}) {
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  if (home) profile.home = home; // tests point home at a temp dir
  const cfg = { ...profile.config, workspace: workspace ?? profile.config?.workspace ?? process.cwd() };
  const ctx = new Context();

  // session (ctx.sessions)
  const store = new SessionStore(profile.home ?? ".code-worker/sessions");
  ctx.provide("sessions", store);
  // tools (ctx.tools)
  ctx.provide("tools", new ToolRegistry(ctx));
  // fs seam (ctx.fs) + consumer tools
  ctx.provide("fs", new LocalFs(cfg.workspace));
  registerFsTools(ctx);
  // shell seam (ctx.shell) + consumer tool
  ctx.provide("shell", new LocalShell(cfg.workspace));
  registerBashTool(ctx);
  // todo (model-facing list, durable log-only events)
  registerTodoTools(ctx);
  // projects (project-level management, strict per-project isolation)
  ctx.provide("projects", new ProjectStore());
  // settings (Web settings page): persisted model config, seeded from env/CLI.
  const settings = new SettingsStore(profile.home ?? ".code-worker");
  ctx.provide("settings", settings);
  // Consistent env family: OPENAI_* wins as a set, else DEEPSEEK_* as a set (no cross-mixing).
  const envFamily = process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL || process.env.OPENAI_MODEL ? "OPENAI" : "DEEPSEEK";
  const env = (n) => process.env[`${envFamily}_${n}`]; // strict family, no per-field cross-mixing
  const modelConfig = {
    apiKey: apiKey ?? env("API_KEY") ?? settings.getApiKey(),
    baseUrl: baseUrl ?? env("BASE_URL") ?? settings.getConfig().baseUrl,
    model: model ?? env("MODEL") ?? settings.getConfig().model,
  };
  ctx.provide("modelConfig", modelConfig);
  // llm seam (ctx.llm) — adapter reads modelConfig at call time (live reconfigure).
  const llm = new LlmService();
  ctx.provide("llm", llm);
  if (mock) ctx.effect(() => llm.registerAdapter("openai-compatible", new MockAdapter()));
  else ctx.effect(() => llm.registerAdapter("openai-compatible", new OpenAICompatibleAdapter({ config: modelConfig })));
  // agent-loop (ctx.agentLoop) — model resolved per turn from modelConfig.
  ctx.provide("agentLoop", new AgentLoop(ctx, { maxSteps: cfg.maxSteps, toolResultMaxBytes: cfg.toolResultMaxBytes, provider: "openai-compatible", config: modelConfig, compaction: cfg.compaction }));
  // guard-approval (autoApprove may be boolean or a mutable {current} ref, e.g. Web toggle)
  installApprovalGuard(ctx, { autoApprove });

  return { ctx, profile, store, dispose: () => ctx.dispose() };
}
