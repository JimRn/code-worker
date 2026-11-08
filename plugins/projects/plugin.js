import { ProjectStore } from "../../src/projects.js";
export const plugin = { name: "projects", deps: ["fileCache?"], apply(ctx, env) {
  ctx.provide("projects", new ProjectStore(env.projectsDir, { cache: ctx.get("fileCache") }));
} };
export default plugin;
