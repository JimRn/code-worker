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

export async function bootProfile(profilePath, { workspace, autoApprove = false, mock = false, model, apiKey, baseUrl } = {}) {
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
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
  // llm seam (ctx.llm)
  const llm = new LlmService();
  ctx.provide("llm", llm);
  // OpenAI-compatible endpoint; DEEPSEEK_* env vars remain as fallback.
  const resolvedModel = model ?? process.env.OPENAI_MODEL ?? process.env.DEEPSEEK_MODEL;
  if (mock) ctx.effect(() => llm.registerAdapter("openai-compatible", new MockAdapter()));
  else ctx.effect(() => llm.registerAdapter("openai-compatible", new OpenAICompatibleAdapter({
    apiKey: apiKey ?? process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY,
    baseUrl: baseUrl ?? process.env.OPENAI_BASE_URL ?? process.env.DEEPSEEK_BASE_URL,
    model: resolvedModel,
  })));
  // agent-loop (ctx.agentLoop)
  ctx.provide("agentLoop", new AgentLoop(ctx, { maxSteps: cfg.maxSteps, toolResultMaxBytes: cfg.toolResultMaxBytes, provider: "openai-compatible", model: resolvedModel }));
  // guard-approval (autoApprove may be boolean or a mutable {current} ref, e.g. Web toggle)
  installApprovalGuard(ctx, { autoApprove });

  return { ctx, profile, store, dispose: () => ctx.dispose() };
}
