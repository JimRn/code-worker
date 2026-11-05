// Filesystem seam: Definition (FsService interface) / Provider (LocalFs) / Consumer (tool-fs)
// Extension plugins depend only on the Definition, never the concrete provider.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export class FsService {
  async readFile() { throw new Error("abstract"); }
  async writeFile() { throw new Error("abstract"); }
  async listDir() { throw new Error("abstract"); }
}

export class LocalFs extends FsService {
  constructor(workspace) { super(); this.root = resolve(workspace); }
  /** Resolve inside workspace; escape = loud error (confinement). */
  resolve(p) {
    const abs = resolve(this.root, p);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error(`Path escapes workspace: ${p}`);
    return abs;
  }
  async readFile(p) { return readFileSync(this.resolve(p), "utf8"); }
  async writeFile(p, content) { const f = this.resolve(p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); return `wrote ${p}`; }
  async listDir(p = ".") { return readdirSync(this.resolve(p)).join("\n") || "(empty)"; }
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
