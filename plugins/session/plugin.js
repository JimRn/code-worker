import { SessionStore } from "../../src/session.js";
export const plugin = { name: "session", deps: [], serviceMethods: ["homeDir", "projectsDir", "create", "open", "listLight", "softDelete", "restore", "listTrash", "projectDir", "registerEventType", "registerProjection", "registerTitleReader"], apply(ctx, env) {
  const store = new SessionStore(env.home ?? ".code-worker");
  ctx.provide("sessions", store);
  ctx.provide("sessionScope", store.scope);
} };
export default plugin;
