// Session: append-only SessionEvent log (JSONL) — the single source of truth.
// Invariant: Model-visible <=> Logged. Anything sent to the model is in this log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deriveMessages, todos as deriveMessagesTodos, title as deriveTitle, usageTotals as deriveUsageTotals } from "./session-views.js";
import { AsyncLocalStorage } from "node:async_hooks";

/** Per-turn live session scope lives on each SessionStore instance
 * (store.scope), never a module singleton — two boots never cross. */

export const SESSION_FORMAT_VERSION = 1;

/** Core durable event types. Feature events (todo/write, session/title,
 * compaction/summary) are NOT here — the owning plugin registers them via
 * store.registerEventType() at apply time, so core knows no feature names. */
export const SESSION_EVENTS = new Set([
  "turn/start", "turn/end", "turn/failed", "turn/cancelled", "step/start", "step/end",
  "system/message", "user/message", "assistant/message", "assistant/attempt",
  "tool/call", "tool/result",
]);

const MAX_CACHE = 50; // LRU cap for live sessions

export class SessionStore {
  constructor(homeDir) {
    this.homeDir = homeDir;
    // Projects live beside sessions (same home); trash is per-project.
    this.projectsDir = join(homeDir, "..", "projects");
    mkdirSync(homeDir, { recursive: true });
    this.cache = new Map(); // identity: one live Session per id, so SSE subscribers see appends
    this.eventTypes = new Set(SESSION_EVENTS);
    this.projectionHandlers = new Map(); // feature event type -> fold(state, ev)
    this.scope = new AsyncLocalStorage(); // per-turn live session
  }
  /** Plugins register their durable event types here (fail-loud append gate). */
  registerEventType(type) { this.eventTypes.add(type); return () => this.eventTypes.delete(type); }
  /** Plugins register message-projection folds (e.g. compaction/summary reset). */
  registerProjection(type, handler) { this.projectionHandlers.set(type, handler); return () => this.projectionHandlers.delete(type); }
  /** Title plugin registers how to read a title from the log tail; core only calls it. */
  registerTitleReader(fn) { this.titleReader = fn; return () => { this.titleReader = undefined; }; }
  /** Resolve a project's on-disk dir by id OR by name (dir names are by name;
   * scan project.json ids so id bindings keep working after renames). */
  projectDir(projectIdOrName) {
    const direct = join(this.projectsDir, projectIdOrName);
    if (existsSync(join(direct, "project.json"))) return direct;
    for (const d of readdirSync(this.projectsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const full = join(this.projectsDir, d.name);
      const pj = join(full, "project.json");
      if (!existsSync(pj)) continue;
      let meta; try { meta = JSON.parse(readFileSync(pj, "utf8")); } catch { continue; }
      if (meta.id === projectIdOrName || d.name === projectIdOrName) return full;
    }
    return direct; // not found: fall back so the error names the requested dir
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
        if (file && this.titleReader) {
          try { title = this.titleReader(readFileSync(join(full, file), "utf8")); } catch { /* unreadable tail: no title */ }
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
    let evicted = false;
    while (this.cache.size > MAX_CACHE && !evicted) {
      // Never evict a live session (in-flight turn / SSE subscribers):
      // forking the same id into two live objects corrupts seq and pairing.
      const oldest = [...this.cache.entries()].find(([, s]) => !(s.onAppend?.size > 0));
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      evicted = oldest[1] !== s;
    }
    return s;
  }
  /** Soft delete: move the session dir into its project's trash (recoverable). */
  softDelete(id) {
    const s = this.open(id);
    this.cache.delete(id);
    const binding = s.binding?.projectId ? s.binding : null;
    if (binding) {
      const trashDir = join(this.projectDir(binding.projectId), "trash");
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
    const src = join(this.projectDir(projectId), "trash", id);
    if (!existsSync(src)) throw new Error(`Session not in trash: ${id}`);
    renameSync(src, join(this.homeDir, id));
  }
  /** List trashed sessions of a project. */
  listTrash(projectId) {
    const dir = join(this.projectDir(projectId), "trash");
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
      // Tolerate a torn trailing line (kill -9 mid-append): skip + warn,
      // never make the whole session unopenable.
      this.events = [];
      let idx = 0;
      for (const l of readFileSync(this.file, "utf8").split("\n")) {
        if (!l.trim()) { idx++; continue; }
        try { this.events.push(JSON.parse(l)); }
        catch (err) { console.warn(`[session] dropping corrupt line ${idx} in ${this.file}: ${err.message}`); }
        idx++;
      }
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
    if (!this.store.eventTypes.has(type)) throw new Error(`Unknown session event type: ${type} (register it via store.registerEventType)`);
    const ev = { v: SESSION_FORMAT_VERSION, seq: this.events.length, ts: Date.now(), type, data };
    appendFileSync(this.file, JSON.stringify(ev) + "\n"); // disk first
    this.events.push(ev);
    for (const fn of this.onAppend ?? []) fn(ev);
    return ev;
  }
  // Derived views delegate to session-views.js (Session only appends).
  // Todo writes live in the todo plugin (it owns the todo/write event type);
  // the core Session only appends events it has been told about.
  todos() { return deriveMessagesTodos(this.events); }
  usageTotals() { return deriveUsageTotals(this.events); }
  title() { return deriveTitle(this.events); }
  deriveMessages() {
    // Incremental invalidation: reuse the projection until append changes length.
    if (this._derivedAt !== this.events.length) {
      this._derived = deriveMessages(this.events, this.store.projectionHandlers);
      this._derivedAt = this.events.length;
    }
    return this._derived;
  }
}
