// Mini Cordis: Context = service repository + typed events + reversible effects.
// Mode contract: emit (observe) | waterfall (around, must next()) | serial (ordered, no next)
import { shouldWrap, wrapService } from "./service-definitions.js";
export class Context {
  constructor() {
    this.services = new Map();
    this._raw = new Map();
    this.listeners = new Map(); // event -> [{fn, mode}]
    this.effects = []; // disposers, LIFO on dispose
    this.disposed = false;
  }
  /** Register service under stable key; returns disposer (reversible effect).
   * Known services are stored behind their capability view (service-definitions). */
  provide(key, service) {
    const prev = this.services.get(key);
    const prevRaw = this._raw.get(key);
    this.services.set(key, shouldWrap(key, service) ? wrapService(key, service) : service);
    this._raw.set(key, service);
    const dispose = () => {
      if (prev) { this.services.set(key, prev); this._raw.set(key, prevRaw); }
      else { this.services.delete(key); this._raw.delete(key); }
    };
    this.effects.push(dispose);
    return dispose;
  }
  get(key) { return this.services.get(key); }
  /** Internal escape hatch: the raw service behind a capability view. */
  raw(key) { return this._raw.get(key) ?? this.services.get(key); }
  /** Internal-only: underlying service instance bypassing the capability view.
   * For plugin apply-time wiring (e.g. reading model-config inputs); consumers
   * must use get()/require(). */
  raw(key) { return this._raw.get(key); }
  require(key) {
    const s = this.services.get(key);
    if (!s) throw new Error(`Missing required service: ctx.${key} (misconfiguration fails loud)`);
    return s;
  }
  /** Install any registration as a reversible effect. */
  effect(fn) {
    const disposer = fn();
    const dispose = typeof disposer === "function" ? disposer : () => {};
    this.effects.push(dispose);
    return dispose;
  }
  /** Subscribe. mode: 'emit'|'waterfall'|'serial' (default emit).
   * opts.priority (default 0): waterfall listeners run higher-first; ties keep
   * registration order (stable). Guards declare high priority so profile
   * order cannot silently change enforcement semantics. @returns disposer */
  on(event, fn, mode = "emit", opts = {}) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    const entry = { fn, mode, priority: opts.priority ?? 0 };
    this.listeners.get(event).push(entry);
    return this.effect(() => () => {
      const arr = this.listeners.get(event);
      const i = arr.indexOf(entry);
      if (i >= 0) arr.splice(i, 1);
    });
  }
  async emit(event, payload) {
    for (const { fn, mode } of [...(this.listeners.get(event) ?? [])]) {
      if (mode === "emit") await fn(payload);
    }
  }
  /** Waterfall: listeners receive (value, next); must call next() to delegate.
   * Higher priority runs first (outermost); stable within a priority tier. */
  async waterfall(event, value) {
    const list = [...(this.listeners.get(event) ?? [])]
      .filter((l) => l.mode === "waterfall")
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    const run = async (i, v) => {
      if (i >= list.length) return v;
      const next = async (nv = v) => run(i + 1, nv);
      // Not calling next() short-circuits: the returned value becomes the final result.
      return list[i].fn(v, next);
    };
    return run(0, value);
  }
  async serial(event, payload) {
    for (const { fn, mode } of [...(this.listeners.get(event) ?? [])]) {
      if (mode === "serial") await fn(payload);
    }
  }
  async dispose() {
    for (const d of [...this.effects].reverse()) { try { await d(); } catch { /* teardown containment */ } }
    this.effects.length = 0;
    this.disposed = true;
  }
}
