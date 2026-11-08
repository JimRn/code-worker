// Filesystem seam: Definition (FsService interface) / Provider (LocalFs) / Consumer (tool-fs)
// Extension plugins depend only on the Definition, never the concrete provider.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { BLOCKED_DIRS, isInBlockedDir } from "./policy.js";

// Per-turn scoped root (DSH core/scope analogue): concurrent turns keep their
// own workspace; no shared mutable field is ever reassigned. Each LocalFs
// instance owns its AsyncLocalStorage, so two boots in one process never
// cross scopes. (Module export kept only as a legacy handle.)
export const fsScope = new AsyncLocalStorage();

export class FsService {
  async readFile() { throw new Error("abstract"); }
  async writeFile() { throw new Error("abstract"); }
  async listDir() { throw new Error("abstract"); }
}

export class LocalFs extends FsService {
  constructor(workspace) { super(); this.defaultRoot = resolve(workspace); this.scope = new AsyncLocalStorage(); }
  get root() { return this.scope.getStore() ?? this.defaultRoot; }
  set root(dir) { this.defaultRoot = resolve(dir); } // boot-time default only
  /** Run fn with a scoped root (concurrent-safe). */
  withRoot(dir, fn) { return this.scope.run(resolve(dir), fn); }
  /** Sensitive directory names: single definition in src/policy.js. */
  static BLOCKED = BLOCKED_DIRS;
  /** Resolve inside workspace; escape/sensitive = loud error (confinement).
   *  Canonicalizes via realpath (nearest existing ancestor + remainder) so
   *  symlinks inside the workspace cannot escape or enter sensitive dirs. */
  resolve(p) {
    let abs = resolve(this.root, p);
    // Canonicalize the deepest existing ancestor, then re-append the remainder.
    let rest = [];
    while (!existsSync(abs)) {
      rest.unshift(basename(abs));
      abs = dirname(abs);
    }
    abs = join(realpathSync(abs), ...rest);
    const root = realpathSync(this.root);
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`Path escapes workspace: ${p}`);
    if (isInBlockedDir(abs, sep)) throw new Error(`Path in sensitive directory: ${p}`);
    return abs;
  }
  async readFile(p) { return readFileSync(this.resolve(p), "utf8"); }
  async writeFile(p, content) { const f = this.resolve(p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); return `wrote ${p}`; }
  async listDir(p = ".") { return readdirSync(this.resolve(p)).join("\n") || "(empty)"; }
  async listEntries(p = ".") {
    return readdirSync(this.resolve(p), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
  }
}

/** Consumer: model-facing tools registered on ctx.tools. */
export function registerFsTools(ctx) {
  const fs = ctx.require("fs");
  const tools = ctx.require("tools");
  const defs = [
    { name: "read_file", description: "Read a UTF-8 file inside the workspace.", schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async ({ path }) => fs.readFile(path) },
    { name: "write_file", description: "Write a UTF-8 file inside the workspace (guarded: needs approval).", schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      execute: async ({ path, content }) => fs.writeFile(path, content) },
    { name: "list_dir", description: "List a directory inside the workspace.", schema: { type: "object", properties: { path: { type: "string" } } },
      execute: async ({ path = "." }) => fs.listDir(path) },
  ];
  for (const d of defs) ctx.effect(() => tools.register(d));
}
