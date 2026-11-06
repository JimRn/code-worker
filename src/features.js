// Vertical features extracted from AgentLoop (loop slimming):
// project isolation, title generation, compaction service.
import { pruneToolResults, estimateChars, summarizeMessages } from "./compaction.js";
import { sessionScope } from "./session.js";

/** Compaction service: prune (model-free) + summarize when over budget. */
export class CompactionService {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = { maxContextChars: 60000, pruneBytes: 2000, keepRecent: 4, ...opts };
  }
  /** Prune old tool results in place (pure). */
  prune(messages) { return pruneToolResults(messages, { maxBytes: this.opts.pruneBytes, keepLast: this.opts.keepRecent }); }
  /** Compact now: summarize all but recent exchanges into a durable event. */
  async compact(session) {
    const messages = session.deriveMessages();
    const keep = this.opts.keepRecent * 2;
    if (messages.length <= keep) return null;
    const text = await summarizeMessages(this.ctx, messages.slice(0, -keep));
    await session.append("compaction/summary", { text, summarizedCount: messages.length - keep });
    return text;
  }
  /** Auto-compact if over budget; failure degrades to a warning. */
  async maybeCompact(session, messages) {
    if (estimateChars(this.prune(messages)) <= this.opts.maxContextChars) return false;
    try { await this.compact(session); return true; }
    catch (err) { console.error(`[compact] failed, continuing: ${err.message}`); return false; }
  }
}

/** Project isolation plugin: per-turn fs/shell roots + AGENTS.md injection. */
export function installProjectIsolation(ctx) {
  // Inject project instructions into the system prompt every turn.
  ctx.on("system-prompt/assemble", async (base, next) => {
    const session = sessionScope.getStore();
    const projects = ctx.get("projects");
    const extra = session?.binding?.projectId && projects ? projects.instructions(session.binding.projectId).slice(0, 64 * 1024) : "";
    return next(extra ? `${base}\n\n## Project instructions (AGENTS.md)\n${extra}` : base);
  }, "waterfall");
  // Scoped isolation: run fn with fs/shell roots bound to the session's
  // project repo via AsyncLocalStorage (concurrent turns cannot cross).
  ctx.provide("isolate", async (session, fn) => {
    const projects = ctx.get("projects");
    if (!session.binding?.projectId || !projects) return fn();
    const dir = projects.repoDir(session.binding.projectId, session.binding.repo);
    return ctx.require("fs").withRoot(dir, () => ctx.require("shell").withWorkspace(dir, fn));
  });
}

/** Title generator plugin: once per session, after the first turn ends. */
export function installTitleGenerator(ctx) {
  ctx.on("turn/ended", async ({ session }) => {
    if (session.title()) return;
    const firstUser = session.events.find((e) => e.type === "user/message");
    if (!firstUser) return;
    try {
      const bound = ctx.require("llm").prepareCall({
        provider: "openai-compatible",
        messages: [
          { role: "system", content: "Reply with a short session title (max 8 words, no quotes, same language as the user). Title only." },
          { role: "user", content: firstUser.data.text },
        ],
        tools: [],
      });
      let text = "";
      for await (const c of bound()) if (c.type === "finish") text = c.text;
      text = text.trim().replace(/^["'「]|["'」]$/g, "").slice(0, 60);
      if (text) await session.append("session/title", { text });
    } catch { /* best-effort */ }
  }, "serial");
}
