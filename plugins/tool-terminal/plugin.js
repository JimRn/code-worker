// tool-terminal plugin: model-facing terminal_* tools (guarded).
import { registerTerminalTools } from "../../src/terminal.js";

export const plugin = {
  name: "tool-terminal",
  deps: ["tools", "terminals"],
  apply(ctx) {
    registerTerminalTools(ctx);
  },
};
