// Session views: pure projections over the event log (todo/title/usage/messages).
// Session itself only appends; all derived state lives here.
//
// Projection handlers live per-SessionStore (store.registerProjection).
// Feature plugins register their fold (e.g. compaction/summary reset) on
// the store at apply time; core keeps only the message shapes. When the
// owning plugin is absent, a summary event projects as an ordinary event
// (documented degradation) — the handler is gone with the plugin.
/** Project model history; after compaction/summary only summary + later events show. */
export function deriveMessages(events, handlers = new Map()) {
  const msgs = [];
  const knownCalls = new Set(); // assistant tool_call ids seen (orphan tool results dropped)
  const systemTexts = []; // system messages hoisted to the front (strict providers reject late system)
  const state = { msgs, systemTexts, knownCalls };
  for (const ev of events) {
    const handler = handlers.get(ev.type);
    if (handler && handler(state, ev)) continue;
    if (ev.type === "system/message") systemTexts.push(ev.data.text); // hoisted below
    else if (ev.type === "user/message") {
      // Vision turns: content as parts (OpenAI image_url format). Text-only
      // turns stay plain strings. Images persist in the log as dataURLs.
      const content = ev.data.images?.length
        ? [{ type: "text", text: ev.data.text }, ...ev.data.images.map((u) => ({ type: "image_url", image_url: { url: u } }))]
        : ev.data.text;
      msgs.push({ role: "user", content });
    }
    else if (ev.type === "assistant/message") {
      // Drop invalid calls (name "None"/empty) persisted by misbehaving providers.
      const calls = (ev.data.toolCalls ?? []).filter((t) => t.name && t.name !== "None");
      for (const t of calls) knownCalls.add(t.id);
      msgs.push({
        // NOTE: content must be "" (not null) when tool_calls present (strict providers 400 on null).
        role: "assistant", content: ev.data.text || "",
        // Wire format (not internal shape): strict providers reject {name,args}.
        tool_calls: calls.length ? calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })) : undefined,
      });
    }
    // Orphan tool results (call id pruned away by compaction) would 400 strict providers.
    else if (ev.type === "tool/result") {
      if (knownCalls.has(ev.data.callId)) msgs.push({ role: "tool", tool_call_id: ev.data.callId, content: ev.data.output });
    }
  }
  // Drop EVERY unpaired tool_call (no result anywhere): strict providers 400
  // histories with tool_calls that have no matching tool result (compaction,
  // interrupted turns, provider flakiness). Assistant stays, tool_calls shrink.
  const resultIds = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const m of msgs) {
    if (m.tool_calls) {
      m.tool_calls = m.tool_calls.filter((t) => resultIds.has(t.id));
      if (!m.tool_calls.length) delete m.tool_calls;
    }
  }
  // System messages first (deduped), then the rest in log order.
  const seen = new Set();
  const system = systemTexts.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; }).map((content) => ({ role: "system", content }));
  return [...system, ...msgs];
}

/** Latest todo list (log-only durable state). */
export function usageTotals(events) {
  let prompt = 0, completion = 0, cacheRead = 0, cacheWrite = 0;
  for (const ev of events) {
    if (ev.type === "assistant/message" && ev.data.usage) {
      const u = ev.data.usage;
      prompt += u.prompt_tokens ?? 0;
      completion += u.completion_tokens ?? 0;
      cacheRead += u.prompt_tokens_details?.cached_tokens ?? u.cache_read_tokens ?? 0;
      cacheWrite += u.completion_tokens_details?.reasoning_tokens != null ? 0 : (u.cache_write_tokens ?? 0);
    }
  }
  const hitRate = prompt > 0 ? (cacheRead / prompt) * 100 : 0;
  return { prompt, completion, total: prompt + completion, cacheRead, cacheWrite, hitRate: Math.round(hitRate * 10) / 10 };
}

/** Per-agent usage rollup for a project: {agentName: totals}. */
export function usageByAgent(sessions) {
  const byAgent = {};
  for (const s of sessions) {
    const name = s.binding?.agent || "default";
    const t = usageTotals(s.events);
    const agg = byAgent[name] ??= { prompt: 0, completion: 0, total: 0, cacheRead: 0, hitRate: 0, turns: 0 };
    agg.prompt += t.prompt; agg.completion += t.completion; agg.total += t.total; agg.cacheRead += t.cacheRead;
    agg.turns += s.events.filter((e) => e.type === "turn/end").length;
    agg.hitRate = agg.prompt > 0 ? Math.round((agg.cacheRead / agg.prompt) * 1000) / 10 : 0;
  }
  return byAgent;
}
