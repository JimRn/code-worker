// Session views: pure projections over the event log (todo/title/usage/messages).
// Session itself only appends; all derived state lives here.

/** Project model history; after compaction/summary only summary + later events show. */
export function deriveMessages(events) {
  const msgs = [];
  const knownCalls = new Set(); // assistant tool_call ids seen (orphan tool results dropped)
  for (const ev of events) {
    if (ev.type === "compaction/summary") {
      msgs.length = 0;
      knownCalls.clear();
      msgs.push({ role: "system", content: `[Earlier conversation summarized]\n${ev.data.text}` });
      continue;
    }
    if (ev.type === "system/message") msgs.push({ role: "system", content: ev.data.text });
    else if (ev.type === "user/message") msgs.push({ role: "user", content: ev.data.text });
    else if (ev.type === "assistant/message") {
      for (const t of ev.data.toolCalls ?? []) knownCalls.add(t.id);
      msgs.push({
        role: "assistant", content: ev.data.text || null,
        // Wire format (not internal shape): strict providers reject {name,args}.
        tool_calls: ev.data.toolCalls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } })),
      });
    }
    // Orphan tool results (call id pruned away by compaction) would 400 strict providers.
    else if (ev.type === "tool/result") {
      if (knownCalls.has(ev.data.callId)) msgs.push({ role: "tool", tool_call_id: ev.data.callId, content: ev.data.output });
    }
  }
  return msgs;
}

/** Latest todo list (log-only durable state). */
export function todos(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "todo/write") return events[i].data.todos;
  }
  return [];
}

/** Latest generated title, or null. */
export function title(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "session/title") return events[i].data.text;
  }
  return null;
}

/** Sum of token usage across assistant messages. */
export function usageTotals(events) {
  let prompt = 0, completion = 0;
  for (const ev of events) {
    if (ev.type === "assistant/message" && ev.data.usage) {
      prompt += ev.data.usage.prompt_tokens ?? 0;
      completion += ev.data.usage.completion_tokens ?? 0;
    }
  }
  return { prompt, completion, total: prompt + completion };
}
