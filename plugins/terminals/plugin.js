// terminals plugin: ctx.terminals service (persistent PTY sessions).
import { TerminalService } from "../../src/terminal.js";

export const plugin = {
  name: "terminals",
  deps: [],
  apply(ctx) {
    ctx.provide("terminals", new TerminalService());
  },
};
