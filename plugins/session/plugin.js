import { SessionStore } from "../../src/session.js";
export const plugin = { name: "session", deps: [], apply(ctx, env) {
  ctx.provide("sessions", new SessionStore(env.home ?? ".code-worker/sessions"));
} };
export default plugin;
