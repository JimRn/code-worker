import { registerFsTools } from "../../src/fs.js";
export const plugin = { name: "tool-fs", deps: ["tools", "fs"], apply(ctx) {
  registerFsTools(ctx);
} };
export default plugin;
