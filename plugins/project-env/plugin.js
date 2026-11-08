// project-env plugin: per-project environment variables (plain + password-type),
// shared by every agent in the project. Plain values join the system prompt
// (model-visible); secrets stay out of prompts/logs and are merged into
// shell/terminal child envs by the consumer plugins.
import { ProjectEnvStore } from "../../src/project-env.js";
import { sessionScopeFrom } from "../../src/session-scope.js";

export const plugin = {
  name: "project-env",
  deps: ["projects"],
  apply(ctx) {
    const projects = ctx.require("projects");
    const storeFor = (projectId) => {
      const dir = projects.projectDir(projectId);
      return new ProjectEnvStore(dir);
    };
    ctx.provide("projectEnv", {
      list: (pid) => storeFor(pid).list(),
      plain: (pid) => storeFor(pid).plain(),
      all: (pid) => storeFor(pid).all(),
      get: (pid, k) => storeFor(pid).get(k),
      set: (pid, k, v, opts) => storeFor(pid).set(k, v, opts),
      delete: (pid, k) => storeFor(pid).delete(k),
    });
    // System prompt: plain (non-secret) env only. Secrets never logged.
    ctx.on("system-prompt/assemble", async (base, next) => {
      const session = sessionScopeFrom(ctx);
      const pid = session?.binding?.projectId;
      if (!pid) return next(base);
      const plain = ctx.require("projectEnv").plain(pid);
      const lines = Object.entries(plain).map(([k, v]) => `${k}=${v}`);
      return next(lines.length ? `${base}\n\n## Project environment (plain vars)\n${lines.join("\n")}` : base);
    }, "waterfall");
  },
};
export default plugin;
