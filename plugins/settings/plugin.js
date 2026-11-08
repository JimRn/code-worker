import { SettingsStore } from "../../src/web/settings.js";
export const plugin = { name: "settings", deps: [], apply(ctx, env) {
  ctx.provide("settings", new SettingsStore(env.home ?? ".code-worker"));
} };
export default plugin;
