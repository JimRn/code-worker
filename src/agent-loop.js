// AgentLoop: default driver. Turn = 0..N Steps; Step = 1 model request + its tools.
// Vertical features live in plugins (compaction, project isolation, title
// generator) and act through events — the loop never calls them directly.
// Model/provider selection comes solely from ctx "modelConfig".
import { sessionScope } from "./session.js";
export class AgentLoop {
  constructor(ctx, { maxSteps = 8, toolResultMaxBytes = 20000, modelConfig, model } = {}) {
    this.ctx = ctx; this.maxSteps = maxSteps; this.toolResultMaxBytes = toolResultMaxBytes;
    this.modelConfig = modelConfig; this.model = model;
  }
  get provider() { return this.modelConfig?.provider ?? "openai-compatible"; }
  currentModel() { return this.modelConfig?.model ?? this.model; }
  async runTurn(session, userText, { onText, model, signal } = {}) {
    const ctx = this.ctx;
    const turnModel = model ?? this.currentModel(); // per-turn override (composer picker)
    const ctl = new AbortController();
    this.controllers.set(session.id, ctl);
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
        const pre = await ctx.waterfall("agent/pre-step", { messages: session.deriveMessages(), modelSelection: { provider: this.provider, model: turnModel }, session, systemChars: systemText.length });
        if (pre?.rejected) break;
        // Plugins (e.g. compaction) rewrite messages through this waterfall;
        // the loop simply sends whatever comes back.
        const messages = pre.messages;
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
      this.controllers.delete(session.id);
    }
  }
  /** Cancel a running turn (AbortSignal wired through the LLM fetch). Per-instance, disposed with the loop. */
  controllers = new Map();
  async cancel(sessionId) {
    const ctl = this.controllers.get(sessionId);
    if (ctl) ctl.abort();
    return Boolean(ctl);
  }
  /** agent.inject(): lands in the next admitted request as a logged user/message. */
  async inject(session, text) { return session.append("user/message", { text: `(injected) ${text}` }); }
}
