// Tools seam: scoped registry + guarded execution pipeline.
// Pipeline (waterfall): tools/pre-execute -> tools/execute -> tools/post-execute
export class ToolRegistry {
  constructor(ctx) {
    this.ctx = ctx; this.tools = new Map();
    // Innermost tools/execute handler: actually invokes the tool (user listeners wrap it via next()).
    ctx.on("tools/execute", async (req) => {
      const tool = this.tools.get(req.name);
      if (!tool) throw new Error(`unknown tool ${req.name}`);
      return tool.execute(req.args);
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
  async execute(calls, { maxBytes = 20000 } = {}) {
    const results = [];
    for (const call of calls) {
      const tool = this.tools.get(call.name);
      if (!tool) { results.push({ callId: call.id, name: call.name, output: `Error: unknown tool ${call.name}`, isError: true }); continue; }
      let req = { name: call.name, args: call.args ?? {}, callId: call.id };
      req = await this.ctx.waterfall("tools/pre-execute", req);
      if (req.denied) { results.push({ callId: call.id, name: call.name, output: `Denied: ${req.denied}`, isError: true }); continue; }
      let output;
      try { output = await this.ctx.waterfall("tools/execute", req); }
      catch (err) { output = `Error: ${err.message}`; }
      const post = await this.ctx.waterfall("tools/post-execute", { ...req, output });
      output = post && typeof post === "object" && "output" in post ? post.output : post;
      // Bound the complete result (incl. wrapper) — tiny/exact/oversized all bounded.
      const text = typeof output === "string" ? output : JSON.stringify(output);
      results.push({ callId: call.id, name: call.name, output: text.slice(0, maxBytes) });
    }
    return results;
  }
}

/** Approval guard: write/bash need auto-approve or --yes; enforced in tools/pre-execute (executor, not schema). */
export function installApprovalGuard(ctx, { autoApprove }) {
  const guarded = new Set(["write_file", "bash"]);
  return ctx.on("tools/pre-execute", async (req, next) => {
    const approved = typeof autoApprove === "object" ? autoApprove.current : autoApprove;
    if (guarded.has(req.name) && !approved) req.denied = `${req.name} requires approval (--yes / CW_AUTO_APPROVE=true / Web approve toggle)`;
    return next(req);
  }, "waterfall");
}
