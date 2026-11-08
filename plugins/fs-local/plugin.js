import { LocalFs } from "../../src/fs.js";
export const plugin = { name: "fs-local", provides: "fs", deps: ["path-policy?"], serviceMethods: ["root", "resolve", "readFile", "writeFile", "listDir", "listEntries", "withRoot"], apply(ctx, env) {
  ctx.provide("fs", new LocalFs(env.workspace, { blocked: ctx.get("pathPolicy")?.blocked }));
} };
export default plugin;
