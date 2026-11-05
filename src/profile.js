// Profile loader: compose a plugin tree from an ordered profile (personal.json).
// Mirrors DSH: profile bundles apply in order; every registration is a reversible effect.
import { readFileSync } from "node:fs";
import { Context } from "./context.js";
import { SessionStore } from "./session.js";
import { ToolRegistry, installApprovalGuard } from "./tools.js";
import { LocalFs, registerFsTools } from "./fs.js";
import { LocalShell, registerBashTool } from "./shell.js";
import { LlmService, DeepSeekAdapter, MockAdapter } from "./llm.js";
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
  if (mock) ctx.effect(() => llm.registerAdapter("deepseek", new MockAdapter()));
  else ctx.effect(() => llm.registerAdapter("deepseek", new DeepSeekAdapter({
    apiKey: apiKey ?? process.env.DEEPSEEK_API_KEY,
    baseUrl: baseUrl ?? process.env.DEEPSEEK_BASE_URL,
    model: model ?? process.env.DEEPSEEK_MODEL,
  })));
  // agent-loop (ctx.agentLoop)
  ctx.provide("agentLoop", new AgentLoop(ctx, { maxSteps: cfg.maxSteps, toolResultMaxBytes: cfg.toolResultMaxBytes, provider: "deepseek", model: model ?? process.env.DEEPSEEK_MODEL }));
  // guard-approval
  installApprovalGuard(ctx, { autoApprove });

  return { ctx, profile, store, dispose: () => ctx.dispose() };
}
