import { installAgents } from "../../src/agents.js";
export const plugin = { name: "agents", deps: ["tools", "projects?", "fileCache?"], apply(ctx) {
  installAgents(ctx);
} };
export default plugin;
