import { installTitleGenerator } from "../../src/features.js";
export const plugin = { name: "title-generator", deps: ["llm", "modelConfig", "sessions"], apply(ctx) {
  const store = ctx.require("sessions");
  store.registerEventType("session/title");
  // Core listLight reads titles through this hook (it never names the event).
  ctx.effect(() => store.registerTitleReader((text) => {
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
      try { const ev = JSON.parse(lines[i]); if (ev.type === "session/title") return ev.data.text; } catch { /* skip */ }
    }
    return null;
  }));
  installTitleGenerator(ctx);
} };
export default plugin;
