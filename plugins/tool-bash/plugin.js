import { registerBashTool } from "../../src/shell.js";
export const plugin = { name: "tool-bash", deps: ["tools", "shell"], apply(ctx) {
  registerBashTool(ctx);
} };
export default plugin;
