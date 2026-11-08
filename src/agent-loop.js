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
  async runTurn(session, userText, { onText, model, signal } = {}) {
    const ctx = this.ctx;
    const turnModel = model ?? this.currentModel(); // per-turn override (composer picker)
    const compaction = ctx.get("compaction");
    const ctl = new AbortController();
    AgentLoop.controllers.set(session.id, ctl);
    const effectiveSignal = signal ?? ctl.signal;
    effectiveSignal.addEventListener("abort", () => ctl.abort());
    const isolate = ctx.get("isolate") ?? ((_s, fn) => fn());
    let turnState = "RUNNING";
    try {
      return await isolate(session, () => sessionScope.run(session, async () => {
      await session.append("turn/start", {});
      await session.append("user/message", { text: userText });
      const systemText = await ctx.waterfall("system-prompt/assemble", "You are Code Worker, a coding agent. Use tools when needed.");
      // Dedup: only log when changed, so repeated turns don't bloat the log/context.
      const lastSystem = [...session.events].reverse().find((e) => e.type === "system/message");
      if (lastSystem?.data.text !== systemText) await session.append("system/message", { text: systemText });

      for (let step = 0; step <= this.maxSteps; step++) {
        // Final step (step == maxSteps) is text-only: summarize, never leave tools hanging.
        // agent/pre-step (waterfall): listeners may accept/rewrite/reject; reject closes turn w/o step.
        const pre = await ctx.waterfall("agent/pre-step", { messages: session.deriveMessages(), modelSelection: { provider: this.provider, model: turnModel } });
        if (pre?.rejected) break;
        let messages = compaction ? compaction.prune(pre.messages) : pre.messages;
        if (compaction) {
          const tools = ctx.require("tools").schemas();
          await compaction.maybeCompact(session, messages, systemText.length, JSON.stringify(tools).length, this.config?.contextWindow);
        }
        messages = session.deriveMessages();
        await session.append("step/start", { step });
        let result;
        try {
          // Stream: chunks are live-only (assistant/chunk); settlement is one durable message.
          const finalOnly = step === this.maxSteps;
          const bound = ctx.require("llm").prepareCall({ provider: this.provider, model: turnModel, messages, tools: finalOnly ? [] : ctx.require("tools").schemas(), signal: effectiveSignal });
          result = { text: "", toolCalls: [] };
          for await (const chunk of bound()) {
            if (chunk.type === "text_delta") {
              result.text += chunk.text;
              onText?.(chunk.text);
              session.broadcastLive("assistant/chunk", { delta: chunk.text });
            } else if (chunk.type === "reasoning_delta") {
              result.reasoning = (result.reasoning ?? "") + chunk.text;
              session.broadcastLive("assistant/reasoning", { delta: chunk.text });
            } else if (chunk.type === "finish") {
              result = chunk;
            }
          }
        } catch (err) {
          await session.append("assistant/attempt", { error: err.message });
          await session.append("step/end", { step, error: err.message });
          break;
        }
        await session.append("assistant/message", { text: result.text, toolCalls: result.toolCalls, usage: result.usage ?? undefined, reasoning: result.reasoning ?? undefined });
        if (!result.toolCalls?.length) { await session.append("step/end", { step }); break; }
        for (const tc of result.toolCalls) await session.append("tool/call", { callId: tc.id, name: tc.name, args: tc.args });
        // Every tool/call MUST get a tool/result (strict providers 400 unpaired
        // calls forever). Guarantee in finally, even if execution itself throws.
        const done = new Set();
        try {
          const results = await ctx.require("tools").execute(result.toolCalls, { maxBytes: this.toolResultMaxBytes, sessionId: session.id, session, projectId: session.binding?.projectId, binding: session.binding });
          for (const r of results) {
            done.add(r.callId);
            await session.append("tool/result", { callId: r.callId, name: r.name, output: r.output, isError: r.isError ?? false });
          }
        } finally {
          for (const tc of result.toolCalls) {
            if (!done.has(tc.id)) await session.append("tool/result", { callId: tc.id, name: tc.name, output: "Error: tool execution interrupted", isError: true });
          }
        }
        await session.append("step/end", { step });
      }
      await ctx.serial("agent/turn-stopping", { session });
      await session.append("turn/end", {});
      turnState = "COMPLETED";
      await ctx.serial("turn/ended", { session, state: turnState });
      return session.deriveMessages();
      }));
    } catch (err) {
      const cancelled = signal?.aborted || err?.name === "AbortError";
      turnState = cancelled ? "CANCELLED" : "FAILED";
      await session.append(cancelled ? "turn/cancelled" : "turn/failed", { error: err.message, state: turnState });
      await ctx.serial("turn/ended", { session, state: turnState });
      throw err;
    } finally {
      AgentLoop.controllers.delete(session.id);
    }
  }
  /** Cancel a running turn (AbortSignal wired through the LLM fetch). */
  static controllers = new Map();
  async cancel(sessionId) {
    const ctl = AgentLoop.controllers.get(sessionId);
    if (ctl) ctl.abort();
    return Boolean(ctl);
  }
  /** agent.inject(): lands in the next admitted request as a logged user/message. */
  async inject(session, text) { return session.append("user/message", { text: `(injected) ${text}` }); }
}
