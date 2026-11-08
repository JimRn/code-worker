// Session: append-only SessionEvent log (JSONL) — the single source of truth.
// Invariant: Model-visible <=> Logged. Anything sent to the model is in this log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveMessages, todos as deriveMessagesTodos, title as deriveTitle, usageTotals as deriveUsageTotals } from "./session-views.js";
import { AsyncLocalStorage } from "node:async_hooks";

/** Per-turn live session scope (replaces the mutable ctx.currentSession slot). */
export const sessionScope = new AsyncLocalStorage();

export const SESSION_FORMAT_VERSION = 1;

/** Durable event registry (SessionEventMap analogue): unknown types fail loud. */
export const SESSION_EVENTS = new Set([
  "turn/start", "turn/end", "step/start", "step/end",
  "system/message", "user/message", "assistant/message", "assistant/attempt",
  "tool/call", "tool/result", "todo/write", "session/title", "compaction/summary",
]);

const MAX_CACHE = 50; // LRU cap for live sessions

export class SessionStore {
  constructor(homeDir) {
    this.homeDir = homeDir;
    // Projects live beside sessions (same home); trash is per-project.
    this.projectsDir = join(homeDir, "..", "projects");
    mkdirSync(homeDir, { recursive: true });
    this.cache = new Map(); // identity: one live Session per id, so SSE subscribers see appends
  }
  /** Lightweight list: binding from meta.json + title from last lines (no full open). */
  listLight() {
    if (!existsSync(this.homeDir)) return [];
    return readdirSync(this.homeDir)
      .filter((id) => {
        try {
          const full = join(this.homeDir, id);
          const files = readdirSync(full);
          return files.some((f) => f.startsWith("session.v") || f === "meta.json");
        } catch { return false; }
      })
      .map((id) => {
        const full = join(this.homeDir, id);
        const binding = existsSync(join(full, "meta.json")) ? JSON.parse(readFileSync(join(full, "meta.json"), "utf8")) : {};
        let title = null;
        const file = readdirSync(full).find((f) => f.startsWith("session.v"));
        if (file) {
          const lines = readFileSync(join(full, file), "utf8").trim().split("\n");
          for (let i = lines.length - 1; i >= 0 && i >= lines.length - 200; i--) {
            try { const ev = JSON.parse(lines[i]); if (ev.type === "session/title") { title = ev.data.text; break; } } catch { /* skip */ }
          }
        }
        return { id, title, projectId: binding.projectId, agent: binding.agent };
      });
  }
  create(meta = {}) {
    const id = randomUUID().slice(0, 8);
    const dir = join(this.homeDir, id);
    mkdirSync(dir, { recursive: true });
    if (meta.projectId || meta.agent) writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
    writeFileSync(join(dir, `session.v${SESSION_FORMAT_VERSION}.jsonl`), ""); // marker: this is a session dir
    const s = new Session(this, id, dir);
    this.cache.set(id, s);
    return s;
  }
  open(id) {
    const cached = this.cache.get(id);
    if (cached) {
      // LRU touch: re-insert as most-recently-used.
      this.cache.delete(id);
      this.cache.set(id, cached);
      return cached;
    }
    const dir = join(this.homeDir, id);
    if (!existsSync(dir)) throw new Error(`Session not found: ${id}`);
    const s = new Session(this, id, dir);
    this.cache.set(id, s);
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    return s;
  }
  /** Soft delete: move the session dir into its project's trash (recoverable). */
  softDelete(id) {
    const s = this.open(id);
    this.cache.delete(id);
    const binding = s.binding?.projectId ? s.binding : null;
    if (binding) {
      const trashDir = join(this.projectsDir, binding.projectId, "trash");
      mkdirSync(trashDir, { recursive: true });
      renameSync(s.dir, join(trashDir, id));
      return trashDir;
    }
    // Unbound sessions: plain delete (no project to hold a trash).
    rmSync(s.dir, { recursive: true, force: true });
    return null;
  }
  /** Restore a trashed session into its project scope. */
  restore(projectId, id) {
    const src = join(this.projectsDir, projectId, "trash", id);
    if (!existsSync(src)) throw new Error(`Session not in trash: ${id}`);
    renameSync(src, join(this.homeDir, id));
  }
  /** List trashed sessions of a project. */
  listTrash(projectId) {
    const dir = join(this.projectsDir, projectId, "trash");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((sid) => {
        try {
          const s = new Session(this, sid, join(dir, sid));
          return { id: sid, title: s.title(), events: s.events.length };
        } catch { return null; }
      })
      .filter(Boolean);
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
    if (!SESSION_EVENTS.has(type)) throw new Error(`Unknown session event type: ${type}`);
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
  deriveMessages() {
    // Incremental invalidation: reuse the projection until append changes length.
    if (this._derivedAt !== this.events.length) {
      this._derived = deriveMessages(this.events);
      this._derivedAt = this.events.length;
    }
    return this._derived;
  }
}
