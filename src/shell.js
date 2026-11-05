// Shell seam: Definition (run) / Provider (local subprocess) / Consumer (tool-bash)
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class ShellService {
  async run() { throw new Error("abstract"); }
}

export class LocalShell extends ShellService {
  constructor(workspace, { timeoutMs = 30000 } = {}) { super(); this.workspace = workspace; this.timeoutMs = timeoutMs; }
  /** Resolve a Spec explicitly (no hidden defaults in run). */
  resolveSpec(request) {
    if (!request?.command) throw new Error("bash: command is required");
    return { command: request.command, shell: request.shell ?? "/bin/sh", timeoutMs: request.timeoutMs ?? this.timeoutMs };
  }
  async run(request) {
    const spec = this.resolveSpec(request);
    try {
      const { stdout, stderr } = await execFileAsync(spec.shell, ["-c", spec.command], { cwd: this.workspace, timeout: spec.timeoutMs, maxBuffer: 200000 });
      return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
    } catch (err) {
      return `Error (exit ${err.code ?? "?"}): ${(err.stdout ?? "") + (err.stderr ?? err.message)}`.trim();
    }
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
