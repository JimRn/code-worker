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
import { installOutputs } from "./outputs.js";

/** Dependency-declared plugin entries (inject-style): profile dispatch verifies
 *  each entry's `deps` are already provided before apply (fail loud, named). */
const entry = (deps, apply) => ({ deps, apply });

export const PLUGINS = {
  session: entry([], (ctx, env) => ctx.provide("sessions", new SessionStore(env.home ?? ".code-worker/sessions"))),
  tools: entry([], (ctx) => ctx.provide("tools", new ToolRegistry(ctx))),
  "fs-local": entry([], (ctx, env) => ctx.provide("fs", new LocalFs(env.workspace))),
  "tool-fs": entry(["tools", "fs"], (ctx) => registerFsTools(ctx)),
  "shell-local": entry([], (ctx, env) => ctx.provide("shell", new LocalShell(env.workspace, { timeoutMs: env.shellTimeoutMs }))),
  "tool-bash": entry(["tools", "shell"], (ctx) => registerBashTool(ctx)),
  todo: entry(["tools"], (ctx) => registerTodoTools(ctx)),
  projects: entry([], (ctx, env) => ctx.provide("projects", new ProjectStore(env.projectsDir))),
  settings: entry([], (ctx, env) => ctx.provide("settings", new SettingsStore(env.home ?? ".code-worker"))),
  llm: entry([], (ctx, env) => {
    ctx.provide("modelConfig", env.modelConfig); // mutable ref: Web settings live-update
    const llm = new LlmService();
    ctx.provide("llm", llm);
    if (env.mock) ctx.effect(() => llm.registerAdapter("openai-compatible", new MockAdapter()));
    else ctx.effect(() => llm.registerAdapter("openai-compatible", new OpenAICompatibleAdapter({ config: env.modelConfig })));
  }),
  compaction: entry(["llm"], (ctx, env) => ctx.provide("compaction", new CompactionService(ctx, env.compaction))),
  "project-isolation": entry(["fs", "shell", "projects"], (ctx) => installProjectIsolation(ctx)),
  "title-generator": entry(["llm"], (ctx) => installTitleGenerator(ctx)),
  // skills/agents/outputs resolve projects lazily at call time (optional dep).
  skills: entry(["tools", "projects?"], (ctx) => installSkills(ctx)),
  agents: entry(["tools", "projects?"], (ctx) => installAgents(ctx)),
  outputs: entry(["tools", "projects?"], (ctx) => installOutputs(ctx)),
  "agent-loop": entry(["tools", "llm"], (ctx, env) => ctx.provide("agentLoop", new AgentLoop(ctx, {
    maxSteps: env.maxSteps, toolResultMaxBytes: env.toolResultMaxBytes,
    provider: "openai-compatible", config: env.modelConfig,
  }))),
  "guard-approval": entry(["tools"], (ctx, env) => installApprovalGuard(ctx, { autoApprove: env.approval, guarded: env.guardedTools, timeoutMs: env.approvalTimeoutMs })),
};
