import { ProjectStore } from "../../src/projects.js";
export const plugin = { name: "projects", deps: ["fileCache?", "sessions?"], serviceMethods: ["dir", "create", "list", "get", "dirOf", "projectDir", "addRepo", "importRepo", "repoDir", "instructions"], apply(ctx, env) {
  const store = new ProjectStore(env.projectsDir, { cache: ctx.get("fileCache") });
  ctx.provide("projects", store);
  // Session trash placement is a projects concern: the store asks us where a
  // project's dir lives (sessions plugin holds no projects knowledge).
  const sessions = ctx.raw("sessions");
  if (sessions) sessions.projectDirResolver = (id) => store.projectDir(id);
} };
export default plugin;
