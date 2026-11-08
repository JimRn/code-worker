import { FileCache } from "../../src/file-cache.js";
export const plugin = { name: "file-cache", provides: "fileCache", deps: [], serviceMethods: ["read", "clear"],
  configSchema: { properties: { maxEntries: true } }, apply(ctx, env) {
  ctx.provide("fileCache", new FileCache(env.pluginConfig?.maxEntries ?? 200));
} };
export default plugin;
