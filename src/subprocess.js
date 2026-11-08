// Subprocess seam: Definition (run argv) / Provider (local child_process).
// Shell seam depends on this, mirroring DSH (shell -> subprocess -> sandbox).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class SubprocessService {
  async run() { throw new Error("abstract"); }
}

export class LocalSubprocess extends SubprocessService {
  constructor({ timeoutMs = 30000 } = {}) { super(); this.timeoutMs = timeoutMs; }
  async run({ file, args = [], cwd, timeoutMs, env }) {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd, timeout: timeoutMs ?? this.timeoutMs, maxBuffer: 200000,
        env: env ? { ...process.env, ...env } : undefined,
      });
      return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
    } catch (err) {
      return `Error (exit ${err.code ?? "?"}): ${(err.stdout ?? "") + (err.stderr ?? err.message)}`.trim();
    }
  }
}
