// Session: append-only SessionEvent log (JSONL) — the single source of truth.
// Invariant: Model-visible <=> Logged. Anything sent to the model is in this log.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const SESSION_FORMAT_VERSION = 1;

export class SessionStore {
  constructor(homeDir) {
    this.homeDir = homeDir;
    mkdirSync(homeDir, { recursive: true });
  }
  create() {
    const id = randomUUID().slice(0, 8);
    const dir = join(this.homeDir, id);
    mkdirSync(dir, { recursive: true });
    return new Session(this, id, dir);
  }
  open(id) {
    const dir = join(this.homeDir, id);
    if (!existsSync(dir)) throw new Error(`Session not found: ${id}`);
    return new Session(this, id, dir);
  }
}

export class Session {
  constructor(store, id, dir) {
    this.store = store; this.id = id; this.dir = dir;
    this.file = join(dir, `session.v${SESSION_FORMAT_VERSION}.jsonl`);
    this.events = [];
    if (existsSync(this.file)) {
      this.events = readFileSync(this.file, "utf8").split("\n").filter(Boolean)
        .map((l) => JSON.parse(l));
    }
  }
  /** Subscribe to session/event (live broadcast, e.g. SSE). Returns unsubscriber. */
  subscribe(fn) {
    this.onAppend ??= new Set();
    this.onAppend.add(fn);
    return () => this.onAppend?.delete(fn);
  }
  /** Append one durable event; broadcast session/event (emit). */
  async append(type, data = {}) {
    const ev = { v: SESSION_FORMAT_VERSION, seq: this.events.length, ts: Date.now(), type, data };
    this.events.push(ev);
    appendFileSync(this.file, JSON.stringify(ev) + "\n");
    for (const fn of this.onAppend ?? []) fn(ev);
    return ev;
  }
  /** Project model history from the log. */
  deriveMessages() {
    const msgs = [];
    for (const ev of this.events) {
      if (ev.type === "system/message") msgs.push({ role: "system", content: ev.data.text });
      else if (ev.type === "user/message") msgs.push({ role: "user", content: ev.data.text });
      else if (ev.type === "assistant/message") msgs.push({ role: "assistant", content: ev.data.text, tool_calls: ev.data.toolCalls ?? undefined });
      else if (ev.type === "tool/result") msgs.push({ role: "tool", tool_call_id: ev.data.callId, content: ev.data.output });
    }
    return msgs;
  }
}
