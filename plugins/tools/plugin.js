import { ToolRegistry } from "../../src/tools.js";
export const plugin = { name: "tools", deps: [], serviceMethods: ["register", "list", "schemas", "execute"], apply(ctx) {
  ctx.provide("tools", new ToolRegistry(ctx));
} };
export default plugin;
