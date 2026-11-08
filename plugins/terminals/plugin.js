// terminals plugin: ctx.terminals service (persistent PTY sessions).
import { TerminalService } from "../../src/terminal.js";

export const plugin = {
  name: "terminals",
  deps: [],
  apply(ctx) {
    const svc = new TerminalService();
    ctx.provide("terminals", svc);
    ctx.effect(() => () => svc.closeAll()); // kill every PTY on dispose
  },
};
export default plugin;
