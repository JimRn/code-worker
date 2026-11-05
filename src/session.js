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
    this.cache = new Map(); // identity: one live Session per id, so SSE subscribers see appends
  }
  create() {
    const id = randomUUID().slice(0, 8);
    const dir = join(this.homeDir, id);
    mkdirSync(dir, { recursive: true });
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
  /** Sum of token usage across assistant messages (provider-reported). */
  usageTotals() {
    let prompt = 0, completion = 0;
    for (const ev of this.events) {
      if (ev.type === "assistant/message" && ev.data.usage) {
        prompt += ev.data.usage.prompt_tokens ?? 0;
        completion += ev.data.usage.completion_tokens ?? 0;
      }
    }
    return { prompt, completion, total: prompt + completion };
  }
  /** Latest generated title, or null. */
  title() {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === "session/title") return this.events[i].data.text;
    }
    return null;
  }
  /** Project model history from the log. After a compaction/summary, only the
   *  summary + later events are model-visible (the summary is itself logged). */
  deriveMessages() {
    const msgs = [];
    let compacted = false;
    for (const ev of this.events) {
      if (ev.type === "compaction/summary") {
        msgs.length = 0; // drop pre-summary history from the projection
        msgs.push({ role: "system", content: `[Earlier conversation summarized]\n${ev.data.text}` });
        compacted = true;
        continue;
      }
      if (ev.type === "system/message") msgs.push({ role: "system", content: ev.data.text });
      else if (ev.type === "user/message") msgs.push({ role: "user", content: ev.data.text });
      else if (ev.type === "assistant/message") msgs.push({ role: "assistant", content: ev.data.text, tool_calls: ev.data.toolCalls ?? undefined });
      else if (ev.type === "tool/result") msgs.push({ role: "tool", tool_call_id: ev.data.callId, content: ev.data.output });
    }
    void compacted;
    return msgs;
  }
}
