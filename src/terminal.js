// Terminal seam (mirrors DSH terminal/terminal-bash): persistent PTY sessions.
// Definition: TerminalService (open/send/read/close, branded ids, owner-scoped).
// Provider: LocalPtyBackend (node-pty bash). Consumer: terminal_* tools.
import pty from "node-pty";
import { randomUUID } from "node:crypto";

/** Service Definition. */
export class TerminalService {
  constructor() { this.sessions = new Map(); } // id -> {backend, owner, output, listeners}
  async open(owner, { cwd, shell = "bash" } = {}) {
    const id = `term-${randomUUID().slice(0, 8)}`;
    const backend = new LocalPtyBackend(shell);
    const session = await backend.spawn({ cwd });
    this.sessions.set(id, { backend, session, owner, output: session.motd, listeners: new Set() });
    return id;
  }
  require(id, owner) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Terminal not found: ${id}`);
    if (owner && s.owner !== owner) throw new Error("Terminal owned by another session");
    return s;
  }
  async send(id, owner, text) {
    const s = this.require(id, owner);
    s.session.write(text + "\n");
    // Wait until output pauses (idle) or timeout.
    return new Promise((resolve) => {
      const before = s.output.length;
      const timer = setTimeout(() => resolve(s.output.slice(before)), 800);
      const check = setInterval(() => {
        if (s.output.length !== before) { clearTimeout(timer); clearInterval(check); resolve(s.output.slice(before)); }
      }, 100);
      setTimeout(() => { clearInterval(check); }, 5000);
    });
  }
  read(id, owner) {
    const s = this.require(id, owner);
    return s.output.slice(-8000);
  }
  async close(id, owner) {
    const s = this.require(id, owner);
    this.sessions.delete(id);
    await s.session.close("closed by user");
  }
  /** Kill every PTY (plugin dispose path; no owner check — host teardown). */
  async closeAll() {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => s.session.close("host disposed").catch(() => {})));
  }
}

/** Provider: local bash over node-pty. */
export class LocalPtyBackend {
  constructor(shell = "bash") { this.shell = shell; }
  async spawn({ cwd }) {
    const proc = pty.spawn(this.shell, [], { name: "xterm-256color", cols: 120, rows: 40, cwd: cwd ?? process.cwd() });
    const listeners = new Set();
    const session = {
      motd: "",
      write: (t) => proc.write(t),
      onData: (fn) => { listeners.add(fn); },
      close: async () => { try { proc.kill(); } catch { /* already exited */ } },
    };
    proc.onData((d) => { session.motd += d; for (const fn of listeners) fn(d); });
    await new Promise((r) => setTimeout(r, 300));
    return session;
  }
}

/** Consumer: model-facing terminal tools (guarded like write/bash).
 * cwd is confined through the fs seam (workspace + project isolation);
 * the PTY never spawns outside the session's workspace. */
export function registerTerminalTools(ctx) {
  const terminals = ctx.require("terminals");
  const tools = ctx.require("tools");
  const fs = ctx.get("fs"); // confinement seam; absent only in fs-less profiles
  const ownerOf = (req) => req.sessionId ?? "default";
  const resolveCwd = (cwd) => {
    if (!fs) return cwd ?? process.cwd();
    const resolved = fs.resolve(cwd ?? "."); // throws outside workspace / blocked dirs
    return resolved;
  };
  const defs = [
    { name: "terminal_open", description: "Open a persistent shell session. Returns a session id.", schema: { type: "object", properties: { cwd: { type: "string" } } },
      execute: async ({ cwd } = {}, req) => `terminal: ${await terminals.open(ownerOf(req), { cwd: resolveCwd(cwd) })}` },
    { name: "terminal_send", description: "Send a command to a terminal session and return its output.", schema: { type: "object", properties: { id: { type: "string" }, command: { type: "string" } }, required: ["id", "command"] },
      execute: async ({ id, command }, req) => terminals.send(id, ownerOf(req), command) },
    { name: "terminal_read", description: "Read the scrollback output of a terminal session.", schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async ({ id }, req) => terminals.read(id, ownerOf(req)) },
    { name: "terminal_kill", description: "Close a terminal session.", schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: async ({ id }, req) => { await terminals.close(id, ownerOf(req)); return "closed"; } },
  ];
  for (const d of defs) ctx.effect(() => tools.register(d));
}
