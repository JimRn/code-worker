import { FileCache } from "../../src/file-cache.js";
export const plugin = { name: "file-cache", deps: [],
  configSchema: { properties: { maxEntries: true } }, apply(ctx, env) {
  ctx.provide("fileCache", new FileCache(env.pluginConfig?.maxEntries ?? 200));
} };
export default plugin;
