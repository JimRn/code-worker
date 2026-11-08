// Tools seam: scoped registry + guarded execution pipeline.
// Pipeline (waterfall): tools/pre-execute -> tools/execute -> tools/post-execute
import { EV } from "./events.js";
export class ToolRegistry {
  constructor(ctx) {
    this.ctx = ctx; this.tools = new Map();
    // Innermost tools/execute handler: actually invokes the tool (user listeners wrap it via next()).
    ctx.on(EV.TOOLS_EXECUTE, async (req) => {
      const tool = this.tools.get(req.name);
      if (!tool) throw new Error(`unknown tool ${req.name}`);
      return tool.execute(req.args, req);
    }, "waterfall");
  }
  register(tool) {
    if (!tool.name || typeof tool.execute !== "function") throw new Error(`Invalid tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return () => this.tools.delete(tool.name);
  }
  list() { return [...this.tools.values()]; }
  /** OpenAI-style schemas for prompt assembly. */
  schemas() {
    return this.list().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.schema ?? { type: "object", properties: {} } },
    }));
  }
  async execute(calls, { maxBytes = 20000, sessionId, session, projectId, binding } = {}) {
    const results = [];
    for (const call of calls) {
      const tool = this.tools.get(call.name);
      if (!tool) { results.push({ callId: call.id, name: call.name, output: `Error: unknown tool ${call.name}`, isError: true }); continue; }
      // Narrow capabilities are injected by the owning plugins via
      // tools/pre-execute (e.g. todo injects req.appendTodo); the registry
      // only assembles the request envelope.
      let req = { name: call.name, args: call.args ?? {}, callId: call.id || `tc-${call.name}-${results.length}`, sessionId, projectId, binding, session };
      req = await this.ctx.waterfall(EV.TOOLS_PRE_EXECUTE, req);
      delete req.session; // listeners may use it; tools never receive the live Session
      if (req.denied) { results.push({ callId: call.id, name: call.name, output: `Denied: ${req.denied}`, isError: true }); continue; }
      let output;
      try { output = await this.ctx.waterfall(EV.TOOLS_EXECUTE, req); }
      catch (err) { output = `Error: ${err.message}`; }
      const post = await this.ctx.waterfall(EV.TOOLS_POST_EXECUTE, { ...req, output });
      output = post && typeof post === "object" && "output" in post ? post.output : post;
      // Bound the complete result (incl. wrapper) — tiny/exact/oversized all bounded.
      const text = typeof output === "string" ? output : JSON.stringify(output);
      results.push({ callId: call.id, name: call.name, output: text.slice(0, maxBytes) });
    }
    return results;
  }
}

/**
 * Approval guard: write/bash need approval; enforced in tools/pre-execute (executor, not schema).
 * autoApprove ref: {current:boolean, mode:"auto"|"per-call", pending:Map, notify?}
 * In per-call mode the executor suspends until the Web UI decides (see server /api/approvals).
 */
export function installApprovalGuard(ctx, { autoApprove, guarded = ["write_file", "bash"], timeoutMs = 30000 }) {
  const guardedSet = new Set(guarded);
  const ref = typeof autoApprove === "object" ? autoApprove : { current: autoApprove };
  ref.pending ??= new Map();
  ref.bySession ??= new Map(); // sessionId -> {current, mode}; Web turns are session-scoped
  // Global ref is the CLI fallback; per-session entries override it.
  const stateFor = (sid) => (sid && ref.bySession.get(sid)) || ref;
  return ctx.on(EV.TOOLS_PRE_EXECUTE, async (req, next) => {
    if (!guardedSet.has(req.name)) return next(req);
    const st = stateFor(req.sessionId);
    if (st.current) return next(req); // auto-approved
    if (st.mode === "per-call") {
      const decision = await new Promise((resolve) => {
        const rawMs = st.timeoutMs ?? timeoutMs;
        const timeoutMsClamped = Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 30000;
        const timer = setTimeout(() => resolve(false), timeoutMsClamped); // timeout -> deny
        ref.pending.set(req.callId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, req });
        ref.notify?.({ callId: req.callId, name: req.name, args: req.args, sessionId: req.sessionId });
      });
      ref.pending.delete(req.callId);
      if (!decision) req.denied = `${req.name} denied by user`;
      return next(req);
    }
    req.denied = `${req.name} requires approval (--yes / CW_AUTO_APPROVE=true / Web approve toggle)`;
    return next(req);
  }, "waterfall", { priority: 20 });
}
