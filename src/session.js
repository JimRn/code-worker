// Session: append-only SessionEvent log (JSONL) — the single source of truth.
// Invariant: Model-visible <=> Logged. Anything sent to the model is in this log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveMessages, todos as deriveMessagesTodos, title as deriveTitle, usageTotals as deriveUsageTotals } from "./session-views.js";

export const SESSION_FORMAT_VERSION = 1;

export class SessionStore {
  constructor(homeDir) {
    this.homeDir = homeDir;
    mkdirSync(homeDir, { recursive: true });
    this.cache = new Map(); // identity: one live Session per id, so SSE subscribers see appends
  }
  create(meta = {}) {
    const id = randomUUID().slice(0, 8);
    const dir = join(this.homeDir, id);
    mkdirSync(dir, { recursive: true });
    if (meta.projectId) writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    writeFileSync(join(dir, `session.v${SESSION_FORMAT_VERSION}.jsonl`), ""); // marker: this is a session dir
    const s = new Session(this, id, dir);
    this.cache.set(id, s);
    return s;
  }
  open(id) {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const dir = join(this.homeDir, id);
    if (!existsSync(dir)) throw new Error(`Session not found: ${id}`);
    const s = new Session(this, id, dir);
    this.cache.set(id, s);
    return s;
  }
}

export class Session {
  constructor(store, id, dir) {
    this.store = store; this.id = id; this.dir = dir;
    this.file = join(dir, `session.v${SESSION_FORMAT_VERSION}.jsonl`);
    this.events = [];
    this.binding = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : {};
    if (existsSync(this.file)) {
      this.events = readFileSync(this.file, "utf8").split("\n").filter(Boolean)
        .map((l) => JSON.parse(l));
    }
  }
  /** Live-only frame (e.g. assistant stream chunk): broadcast, never persisted/replayed. */
  broadcastLive(type, data = {}) {
    const ev = { live: true, ts: Date.now(), type, data };
    for (const fn of this.onAppend ?? []) fn(ev);
    return ev;
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
  /** Capability-scoped todo write: the ONLY write tools may perform on the log. */
  async writeTodos(todos) {
    const prev = this.todos();
    if (JSON.stringify(prev) === JSON.stringify(todos)) return false; // no-change: skip append
    await this.append("todo/write", { todos });
    return true;
  }
  // Derived views delegate to session-views.js (Session only appends).
  todos() { return deriveMessagesTodos(this.events); }
  usageTotals() { return deriveUsageTotals(this.events); }
  title() { return deriveTitle(this.events); }
  deriveMessages() { return deriveMessages(this.events); }
}
