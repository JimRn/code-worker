import { SessionStore } from "../../src/session.js";
export const plugin = { name: "session", deps: [], apply(ctx, env) {
  const store = new SessionStore(env.home ?? ".code-worker");
  ctx.provide("sessions", store);
  ctx.provide("sessionScope", store.scope);
} };
export default plugin;
