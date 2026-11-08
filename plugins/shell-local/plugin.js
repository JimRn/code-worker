import { LocalShell } from "../../src/shell.js";
export const plugin = { name: "shell-local", provides: "shell", deps: [], serviceMethods: ["workspace", "resolveSpec", "run", "withWorkspace"],
  configSchema: { properties: { timeoutMs: true } }, apply(ctx, env) {
  ctx.provide("shell", new LocalShell(env.workspace, { timeoutMs: env.pluginConfig?.timeoutMs }));
} };
export default plugin;
