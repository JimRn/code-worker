// Vertical features extracted from AgentLoop (loop slimming):
// project isolation, title generation, compaction service.
import { pruneToolResults, estimateChars, summarizeMessages } from "./compaction.js";
import { sessionScope } from "./session.js";

/** Compaction service: prune (model-free) + summarize when over budget. */
export class CompactionService {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    // Token budget: B = C(context) - S(system) - T(tools) - O(output reserve) - R(safety)
    this.opts = {
      contextWindow: 128000, outputReserve: 8000, safety: 4000, pruneBytes: 2000, keepRecent: 4, ...opts,
    };
  }
  /** Rough token estimate (chars/4; CJK-heavy text underestimates, safety margin covers). */
  static estimateTokens(messages, systemChars, toolsChars) {
    return Math.ceil(estimateChars(messages) / 4) + Math.ceil(systemChars / 4) + Math.ceil(toolsChars / 4);
  }
  /** Token-budget check replacing the old fixed char threshold. */
  overBudget(messages, systemChars = 0, toolsChars = 0, contextWindow) {
    const budget = (contextWindow ?? this.opts.contextWindow) - this.opts.outputReserve - this.opts.safety;
    return CompactionService.estimateTokens(messages, systemChars, toolsChars) > budget;
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
  /** Auto-compact if over token budget; failure degrades to a warning. */
  async maybeCompact(session, messages, systemChars = 0, toolsChars = 0, contextWindow) {
    if (!this.overBudget(this.prune(messages), systemChars, toolsChars, contextWindow)) return false;
    try { await this.compact(session); return true; }
    catch (err) { console.error(`[compact] failed, continuing: ${err.message}`); return false; }
  }
}

/** Compaction: eventized — prunes + auto-summarizes through agent/pre-step.
 * The loop sends pre.messages as returned by the waterfall; this listener
 * rewrites them (prune, then maybe compact and re-derive). */
export function installCompaction(ctx, svc) {
  ctx.on("agent/pre-step", async (req, next) => {
    const session = req.session ?? sessionScope.getStore();
    let messages = svc.prune(req.messages ?? []);
    if (session) {
      const toolsChars = ctx.get("tools") ? JSON.stringify(ctx.require("tools").schemas()).length : 0;
      const contextWindow = ctx.get("modelConfig")?.contextWindow;
      const didCompact = await svc.maybeCompact(session, messages, req.systemChars ?? 0, toolsChars, contextWindow);
      if (didCompact) messages = svc.prune(session.deriveMessages());
    }
    return next({ ...req, messages });
  }, "waterfall");
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
        provider: ctx.get("modelConfig")?.provider ?? "openai-compatible",
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
