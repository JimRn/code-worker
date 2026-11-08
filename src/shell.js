// Shell seam: Definition (run) / Provider (local subprocess) / Consumer (tool-bash)
import { AsyncLocalStorage } from "node:async_hooks";
import { LocalSubprocess } from "./subprocess.js";

export const shellScope = new AsyncLocalStorage();

export class ShellService {
  async run() { throw new Error("abstract"); }
}

export class LocalShell extends ShellService {
  constructor(workspace, { timeoutMs = 30000, subprocess } = {}) {
    super(); this.defaultWorkspace = workspace; this.timeoutMs = timeoutMs;
    this.scope = new AsyncLocalStorage();
    this.subprocess = subprocess ?? new LocalSubprocess({ timeoutMs });
  }
  get workspace() { return this.scope.getStore() ?? this.defaultWorkspace; }
  set workspace(dir) { this.defaultWorkspace = dir; } // boot-time default only
  withWorkspace(dir, fn) { return this.scope.run(dir, fn); }
  /** Resolve a Spec explicitly (no hidden defaults in run). */
  resolveSpec(request) {
    if (!request?.command) throw new Error("bash: command is required");
    return { command: request.command, shell: request.shell ?? "/bin/sh", timeoutMs: request.timeoutMs ?? this.timeoutMs };
  }
  async run(request) {
    const spec = this.resolveSpec(request);
    return this.subprocess.run({ file: spec.shell, args: ["-c", spec.command], cwd: this.workspace, timeoutMs: spec.timeoutMs });
  }
}

export function registerBashTool(ctx) {
  const shell = ctx.require("shell");
  const tools = ctx.require("tools");
  ctx.effect(() => tools.register({
    name: "bash", description: "Run a shell command in the workspace (guarded: needs approval).",
    schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    execute: async ({ command }) => shell.run({ command }),
  }));
}
