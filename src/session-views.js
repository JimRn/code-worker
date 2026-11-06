// Session views: pure projections over the event log (todo/title/usage/messages).
// Session itself only appends; all derived state lives here.

/** Project model history; after compaction/summary only summary + later events show. */
export function deriveMessages(events) {
  const msgs = [];
  for (const ev of events) {
    if (ev.type === "compaction/summary") {
      msgs.length = 0;
      msgs.push({ role: "system", content: `[Earlier conversation summarized]\n${ev.data.text}` });
      continue;
    }
    if (ev.type === "system/message") msgs.push({ role: "system", content: ev.data.text });
    else if (ev.type === "user/message") msgs.push({ role: "user", content: ev.data.text });
    else if (ev.type === "assistant/message") msgs.push({ role: "assistant", content: ev.data.text, tool_calls: ev.data.toolCalls ?? undefined });
    else if (ev.type === "tool/result") msgs.push({ role: "tool", tool_call_id: ev.data.callId, content: ev.data.output });
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
