// AgentLoop: default driver. Turn = 0..N Steps; Step = 1 model request + its tools.
// Sequence: turn/start -> claim -> snapshot model -> assemble prompt+tools -> agent/pre-step
//   -> prepareCall bind -> commit system/user -> freeze -> stream -> tools pipeline -> step/end
//   -> (more tools owed?) -> next step -> agent/turn-stopping (serial) -> turn/end
export class AgentLoop {
  constructor(ctx, { maxSteps = 8, toolResultMaxBytes = 20000, provider = "openai-compatible", model, config } = {}) {
    this.ctx = ctx; this.maxSteps = maxSteps; this.toolResultMaxBytes = toolResultMaxBytes;
    this.provider = provider; this.model = model; this.config = config; // mutable ref: Web settings live-update
  }
  currentModel() { return this.config?.model ?? this.model; }
  async runTurn(session, userText, { onText } = {}) {
    const ctx = this.ctx;
    await session.append("turn/start", {});
    await session.append("user/message", { text: userText });
    const systemText = await ctx.waterfall("system-prompt/assemble", "You are Code Worker, a coding agent. Use tools when needed.");
    await session.append("system/message", { text: systemText });

    for (let step = 0; step < this.maxSteps; step++) {
      // agent/pre-step (waterfall): listeners may accept/rewrite/reject; reject closes turn w/o step.
      const pre = await ctx.waterfall("agent/pre-step", { messages: session.deriveMessages(), modelSelection: { provider: this.provider, model: this.currentModel() } });
      if (pre?.rejected) break;
      await session.append("step/start", { step });
      let result;
      try {
        const bound = ctx.require("llm").prepareCall({ provider: this.provider, model: this.currentModel(), messages: pre.messages, tools: ctx.require("tools").schemas() });
        result = await bound();
      } catch (err) {
        await session.append("assistant/attempt", { error: err.message });
        await session.append("step/end", { step, error: err.message });
        break;
      }
      if (result.text) onText?.(result.text);
      await session.append("assistant/message", { text: result.text, toolCalls: result.toolCalls });
      if (!result.toolCalls?.length) { await session.append("step/end", { step }); break; }
      for (const tc of result.toolCalls) await session.append("tool/call", { callId: tc.id, name: tc.name, args: tc.args });
      const results = await ctx.require("tools").execute(result.toolCalls, { maxBytes: this.toolResultMaxBytes });
      for (const r of results) await session.append("tool/result", { callId: r.callId, name: r.name, output: r.output, isError: r.isError ?? false });
      await session.append("step/end", { step });
    }
    await ctx.serial("agent/turn-stopping", { session });
    await session.append("turn/end", {});
    return session.deriveMessages();
  }
  /** agent.inject(): lands in the next admitted request as a logged user/message. */
  async inject(session, text) { return session.append("user/message", { text: `(injected) ${text}` }); }
}
