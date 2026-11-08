import { LocalShell } from "../../src/shell.js";
export const plugin = { name: "shell-local", deps: [],
  configSchema: { properties: { timeoutMs: true } }, apply(ctx, env) {
  ctx.provide("shell", new LocalShell(env.workspace, { timeoutMs: env.pluginConfig?.timeoutMs ?? env.shellTimeoutMs }));
} };
export default plugin;
