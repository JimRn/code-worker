// Compaction (mirrors DSH compaction-basic + compaction-tool-result-pruner):
// 1) Prune: model-free truncation of old tool results (always on, cheap first).
// 2) Summarize: when context exceeds budget, LLM-summarize old turns into one
//    durable compaction/summary event; history after it is what the model sees.
const MARKER = "\n…[pruned]…\n";

/** Truncate tool results older than the last `keepLast` ones. Pure, model-free. */
export function pruneToolResults(messages, { maxBytes = 2000, keepLast = 2 } = {}) {
  const toolIdx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const prunable = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keepLast)));
  return messages.map((m, i) => {
    if (!prunable.has(i) || m.content.length <= maxBytes) return m;
    const half = Math.floor((maxBytes - MARKER.length) / 2);
    return { ...m, content: m.content.slice(0, half) + MARKER + m.content.slice(-half) };
  });
}

/** Rough context estimate (chars; ~4 chars/token). */
export function estimateChars(messages) {
  return messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length), 0);
}

/** Summarize old messages with the LLM (no tools). Returns summary text. */
export async function summarizeMessages(ctx, messages, { prompt = "Summarize this conversation for continued work. Keep facts, decisions, file paths, and open tasks. Be concise." } = {}) {
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 20000);
  const bound = ctx.require("llm").prepareCall({
    provider: ctx.get("modelConfig")?.provider,
    messages: [{ role: "system", content: prompt }, { role: "user", content: transcript }],
    tools: [],
  });
  let text = "";
  for await (const chunk of bound()) if (chunk.type === "finish") text = chunk.text;
  if (!text.trim()) throw new Error("compaction summary is empty");
  return text;
}
