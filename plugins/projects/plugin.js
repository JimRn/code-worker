import { ProjectStore } from "../../src/projects.js";
export const plugin = { name: "projects", deps: ["fileCache?"], serviceMethods: ["dir", "create", "list", "get", "dirOf", "projectDir", "addRepo", "importRepo", "repoDir", "instructions"], apply(ctx, env) {
  ctx.provide("projects", new ProjectStore(env.projectsDir, { cache: ctx.get("fileCache") }));
} };
export default plugin;
