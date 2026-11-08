import { installTitleGenerator } from "../../src/features.js";
export const plugin = { name: "title-generator", deps: ["llm", "modelConfig", "sessions"], apply(ctx) {
  ctx.require("sessions").registerEventType("session/title");
  installTitleGenerator(ctx);
} };
export default plugin;
