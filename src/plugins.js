// Plugin registry: each plugin is data {name, apply(ctx, env)}.
// profile.js dispatches by profile.plugins order — adding a plugin means one
// registry entry + one line in profiles/personal.json, no core edits.
import { SessionStore } from "./session.js";
import { ToolRegistry } from "./tools.js";
import { LocalFs, registerFsTools } from "./fs.js";
import { LocalShell, registerBashTool } from "./shell.js";
import { LlmService, OpenAICompatibleAdapter, MockAdapter } from "./llm.js";
import { AgentLoop } from "./agent-loop.js";
import { SettingsStore } from "./web/settings.js";
import { registerTodoTools } from "./todo.js";
import { ProjectStore } from "./projects.js";
import { installApprovalGuard } from "./tools.js";
import { installProjectIsolation, installTitleGenerator, CompactionService } from "./features.js";
import { installSkills } from "./skills.js";
import { installAgents } from "./agents.js";

export const PLUGINS = {
  session: (ctx, env) => ctx.provide("sessions", new SessionStore(env.home ?? ".code-worker/sessions")),
  tools: (ctx) => ctx.provide("tools", new ToolRegistry(ctx)),
  "fs-local": (ctx, env) => ctx.provide("fs", new LocalFs(env.workspace)),
  "tool-fs": (ctx) => registerFsTools(ctx),
  "shell-local": (ctx, env) => ctx.provide("shell", new LocalShell(env.workspace, { timeoutMs: env.shellTimeoutMs })),
  "tool-bash": (ctx) => registerBashTool(ctx),
  todo: (ctx) => registerTodoTools(ctx),
  projects: (ctx, env) => ctx.provide("projects", new ProjectStore(env.projectsDir)),
  settings: (ctx, env) => ctx.provide("settings", new SettingsStore(env.home ?? ".code-worker")),
  llm: (ctx, env) => {
    ctx.provide("modelConfig", env.modelConfig); // mutable ref: Web settings live-update
    const llm = new LlmService();
    ctx.provide("llm", llm);
    if (env.mock) ctx.effect(() => llm.registerAdapter("openai-compatible", new MockAdapter()));
    else ctx.effect(() => llm.registerAdapter("openai-compatible", new OpenAICompatibleAdapter({ config: env.modelConfig })));
  },
  compaction: (ctx, env) => ctx.provide("compaction", new CompactionService(ctx, env.compaction)),
  "project-isolation": (ctx) => installProjectIsolation(ctx),
  "title-generator": (ctx) => installTitleGenerator(ctx),
  skills: (ctx) => installSkills(ctx),
  agents: (ctx) => installAgents(ctx),
  "agent-loop": (ctx, env) => ctx.provide("agentLoop", new AgentLoop(ctx, {
    maxSteps: env.maxSteps, toolResultMaxBytes: env.toolResultMaxBytes,
    provider: "openai-compatible", config: env.modelConfig,
  })),
  "guard-approval": (ctx, env) => installApprovalGuard(ctx, { autoApprove: env.approval, guarded: env.guardedTools, timeoutMs: env.approvalTimeoutMs }),
};
