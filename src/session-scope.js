// Per-turn live session accessor (ctx service "sessionScope", provided by the
// session plugin). Plugins read the ambient session through here instead of
// importing a module singleton.
export function sessionScopeFrom(ctx) {
  return ctx.get("sessionScope")?.getStore() ?? null;
}
