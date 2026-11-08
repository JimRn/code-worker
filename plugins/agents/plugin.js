import { installAgents } from "../../src/agents.js";
export const plugin = { name: "agents", deps: ["tools", "projects?"], apply(ctx) {
  installAgents(ctx);
} };
export default plugin;
