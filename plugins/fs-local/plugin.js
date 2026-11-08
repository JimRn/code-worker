import { LocalFs } from "../../src/fs.js";
export const plugin = { name: "fs-local", deps: [], apply(ctx, env) {
  ctx.provide("fs", new LocalFs(env.workspace));
} };
export default plugin;
