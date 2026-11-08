import { CompactionService, installCompaction } from "../../src/features.js";
export const plugin = { name: "compaction", deps: ["llm", "modelConfig", "sessions", "tools?"],
  configSchema: { properties: { contextWindow: true, outputReserve: true, safety: true, pruneBytes: true, keepRecent: true, maxContextChars: true } }, apply(ctx, env) {
  const store = ctx.raw("sessions"); // internal: event/projection registry lives on the store
  store.registerEventType("compaction/summary");
  const svc = new CompactionService(ctx, { ...env.compaction, ...(env.pluginConfig ?? {}) });
  ctx.provide("compaction", svc);
  installCompaction(ctx, svc); // eventized: listens on agent/pre-step, loop knows nothing
  // Own the summary projection fold (reset history, keep summary as system).
  ctx.effect(() => store.registerProjection("compaction/summary", (state, ev) => {
    state.msgs.length = 0; state.systemTexts.length = 0; state.knownCalls.clear();
    state.systemTexts.push(`[Earlier conversation summarized]\n${ev.data.text}`);
    return true;
  }));
} };
export default plugin;
