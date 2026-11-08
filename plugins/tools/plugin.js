import { ToolRegistry } from "../../src/tools.js";
export const plugin = { name: "tools", deps: [], apply(ctx) {
  ctx.provide("tools", new ToolRegistry(ctx));
} };
export default plugin;
