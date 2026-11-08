// ask-user plugin (DSH askUser analogue): the agent calls ask_user with a
// structured question; execution suspends until the client answers, then
// the answer is returned as the tool result and the turn continues.
export const plugin = {
  name: "ask-user",
  deps: ["tools"],
  apply(ctx) {
    const pending = new Map(); // callId -> {resolve, req}
    ctx.on("system-prompt/assemble", async (base, next) => next(`${base}\n\n## Asking the user\nWhen a decision blocks progress, call ask_user with a structured question (2-6 options, each with a label and a short description) instead of listing choices in plain text.`), "waterfall");
    ctx.provide("questions", {
      pending,
      notify: null,
    });
    ctx.effect(() => ctx.require("tools").register({
      name: "ask_user",
      description: "Ask the user a structured single-choice question. Use when a decision blocks progress.",
      schema: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array", minItems: 2, maxItems: 6,
            items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
          },
        },
        required: ["question", "options"],
      },
      execute: async ({ question, options }, req) => {
        const callId = req.callId;
        const svc = ctx.get("questions");
        const answer = await new Promise((resolve) => {
          pending.set(callId, { resolve, req, question, options });
          svc.notify?.({ callId, question, options, sessionId: req.sessionId });
          setTimeout(() => { // auto-dismiss as "ignored" after 5 min
            if (pending.delete(callId)) resolve("（用户未在时限内回答）");
          }, 300000);
        });
        return `用户选择：${answer}`;
      },
    }));
  },
};
export default plugin;
