// AgentLoop: default driver. Turn = 0..N Steps; Step = 1 model request + its tools.
// Vertical features live in plugins (compaction service, project isolation,
// title generator); the loop only orchestrates Turn/Step via ctx services/events.
import { sessionScope } from "./session.js";
export class AgentLoop {
  constructor(ctx, { maxSteps = 8, toolResultMaxBytes = 20000, provider = "openai-compatible", model, config } = {}) {
    this.ctx = ctx; this.maxSteps = maxSteps; this.toolResultMaxBytes = toolResultMaxBytes;
    this.provider = provider; this.model = model; this.config = config; // mutable ref: Web settings live-update
  }
  currentModel() { return this.config?.model ?? this.model; }
  async runTurn(session, userText, { onText, model } = {}) {
    const ctx = this.ctx;
    const turnModel = model ?? this.currentModel(); // per-turn override (composer picker)
    const compaction = ctx.get("compaction");
    const isolate = ctx.get("isolate") ?? ((_s, fn) => fn());
    return isolate(session, () => sessionScope.run(session, async () => {
      await session.append("turn/start", {});
      await session.append("user/message", { text: userText });
      const systemText = await ctx.waterfall("system-prompt/assemble", "You are Code Worker, a coding agent. Use tools when needed.");
      // Dedup: only log when changed, so repeated turns don't bloat the log/context.
      const lastSystem = [...session.events].reverse().find((e) => e.type === "system/message");
      if (lastSystem?.data.text !== systemText) await session.append("system/message", { text: systemText });

      for (let step = 0; step < this.maxSteps; step++) {
        // agent/pre-step (waterfall): listeners may accept/rewrite/reject; reject closes turn w/o step.
        const pre = await ctx.waterfall("agent/pre-step", { messages: session.deriveMessages(), modelSelection: { provider: this.provider, model: turnModel } });
        if (pre?.rejected) break;
        let messages = compaction ? compaction.prune(pre.messages) : pre.messages;
        if (compaction) await compaction.maybeCompact(session, messages);
        messages = session.deriveMessages();
        await session.append("step/start", { step });
        let result;
        try {
          // Stream: chunks are live-only (assistant/chunk); settlement is one durable message.
          const bound = ctx.require("llm").prepareCall({ provider: this.provider, model: turnModel, messages, tools: ctx.require("tools").schemas() });
          result = { text: "", toolCalls: [] };
          for await (const chunk of bound()) {
            if (chunk.type === "text") {
              result.text += chunk.delta;
              onText?.(chunk.delta);
              session.broadcastLive("assistant/chunk", { delta: chunk.delta });
            } else if (chunk.type === "finish") {
              result = chunk;
            }
          }
        } catch (err) {
          await session.append("assistant/attempt", { error: err.message });
          await session.append("step/end", { step, error: err.message });
          break;
        }
        await session.append("assistant/message", { text: result.text, toolCalls: result.toolCalls, usage: result.usage ?? undefined });
        if (!result.toolCalls?.length) { await session.append("step/end", { step }); break; }
        for (const tc of result.toolCalls) await session.append("tool/call", { callId: tc.id, name: tc.name, args: tc.args });
        const results = await ctx.require("tools").execute(result.toolCalls, { maxBytes: this.toolResultMaxBytes, sessionId: session.id, session });
        for (const r of results) await session.append("tool/result", { callId: r.callId, name: r.name, output: r.output, isError: r.isError ?? false });
        await session.append("step/end", { step });
      }
      await ctx.serial("agent/turn-stopping", { session });
      await session.append("turn/end", {});
      await ctx.serial("turn/ended", { session });
      return session.deriveMessages();
    }));
  }
  /** agent.inject(): lands in the next admitted request as a logged user/message. */
  async inject(session, text) { return session.append("user/message", { text: `(injected) ${text}` }); }
}
