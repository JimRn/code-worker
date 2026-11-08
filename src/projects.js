// Projects (P1): project-level management with strict isolation.
// Layout: <projectsDir>/<project-name>/{project.json, AGENTS.md, docs/, skills/, agents/, outputs/, repos/<repo>/}
// Directories are named by project NAME (human-readable); project.json holds the stable uuid id.
// Env: CW_PROJECTS_DIR overrides the location (default ~/.code-worker/projects).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { FileCache } from "./file-cache.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function projectsDir() {
  return process.env.CW_PROJECTS_DIR ?? join(homedir(), ".code-worker", "projects");
}

const SUBDIRS = ["docs", "skills", "agents", "outputs", "repos"];
const AGENTS_TEMPLATE = "# Project Instructions\n\nDescribe project conventions, architecture, and rules every agent session must follow.\n";

/** Filesystem-safe directory name for a project: the name itself, sanitized
 * only for path separators/control chars, deduped against existing dirs. */
export function safeDirName(name) {
  return String(name ?? "").trim().replace(/[\\/\0]/g, "_").replace(/\s+/g, " ").slice(0, 80) || "project";
}

export class ProjectStore {
  constructor(dir = projectsDir(), { cache = new FileCache() } = {}) {
    this.dir = dir;
    this.cache = cache;
    mkdirSync(this.dir, { recursive: true });
    this.migrate();
  }
  /** Rename legacy id-named dirs to name-named (best-effort, no overwrite). */
  migrate() {
    for (const d of readdirSync(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const full = join(this.dir, d.name);
      const pj = join(full, "project.json");
      if (!existsSync(pj)) continue;
      let meta; try { meta = JSON.parse(readFileSync(pj, "utf8")); } catch { continue; }
      const want = safeDirName(meta.name);
      if (d.name === want) continue;
      const target = join(this.dir, want);
      if (existsSync(target)) continue; // never clobber; leave for manual resolution
      try { renameSync(full, target); } catch { /* concurrent migrate: leave as-is */ }
    }
  }
  create(name) {
    if (!name || !String(name).trim()) throw new Error("project name is required");
    const id = randomUUID().slice(0, 8);
    const base = safeDirName(name);
    // Dedupe: append a short id suffix when the name dir is taken by another project.
    let dirName = base;
    while (existsSync(join(this.dir, dirName, "project.json"))) dirName = `${base}-${id.slice(0, 4)}`;
    const dir = join(this.dir, dirName);
    mkdirSync(dir, { recursive: true });
    for (const d of SUBDIRS) mkdirSync(join(dir, d), { recursive: true });
    const meta = { id, name: String(name).trim(), createdAt: Date.now(), repos: [] };
    writeFileSync(join(dir, "project.json"), JSON.stringify(meta, null, 2));
    writeFileSync(join(dir, "AGENTS.md"), AGENTS_TEMPLATE);
    // first repo so the project is immediately usable as a workspace
    this.addRepo(id, "main");
    return this.get(id);
  }
  list() {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.get(d.name))
      .filter(Boolean);
  }
  get(id) {
    const dir = this.dirOf(id);
    if (!dir || !existsSync(join(dir, "project.json"))) return null;
    const meta = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    // Creation order from project.json (readdir order is alphabetical).
    const onDisk = existsSync(join(dir, "repos")) ? readdirSync(join(dir, "repos")) : [];
    const repos = [...(meta.repos ?? []), ...onDisk.filter((r) => !(meta.repos ?? []).includes(r))];
    return { ...meta, repos, dir };
  }
  /** Resolve the on-disk directory for an id or name (scan, not direct join). */
  dirOf(id) {
    if (!id) return null;
    const direct = join(this.dir, id);
    if (existsSync(join(direct, "project.json"))) return direct;
    for (const d of readdirSync(this.dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const full = join(this.dir, d.name);
      const pj = join(full, "project.json");
      if (!existsSync(pj)) continue;
      let meta; try { meta = JSON.parse(readFileSync(pj, "utf8")); } catch { continue; }
      if (meta.id === id || d.name === id || meta.name === id) return full;
    }
    return null;
  }
  /** Project root directory (by id or name). */
  projectDir(id) {
    const dir = this.dirOf(id);
    if (!dir) throw new Error(`Project not found: ${id}`);
    return dir;
  }
  addRepo(projectId, repoName) {
    const p = this.get(projectId);
    if (!p) throw new Error(`Project not found: ${projectId}`);
    const name = String(repoName || "main").replace(/[^\w.\- ]/g, "_").slice(0, 60) || "main";
    mkdirSync(join(p.dir, "repos", name), { recursive: true });
    if (!p.repos.includes(name)) {
      p.repos.push(name);
      writeFileSync(join(p.dir, "project.json"), JSON.stringify({ id: p.id, name: p.name, createdAt: p.createdAt, repos: p.repos }, null, 2));
    }
    return name;
  }
  /** Import an existing local directory as a repo (recursive copy). */
  importRepo(projectId, srcDir) {
    const p = this.get(projectId);
    if (!p) throw new Error(`Project not found: ${projectId}`);
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) throw new Error("source is not a directory");
    // Safety caps: file count + total bytes (walk first, copy second).
    const { readdirSync: rd, statSync: st } = { readdirSync, statSync };
    let files = 0, bytes = 0;
    const walk = (d) => {
      for (const e of rd(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) { if (++files > 10000) throw new Error("import exceeds 10000 files"); if ((bytes += st(full).size) > 200 * 1024 * 1024) throw new Error("import exceeds 200MB"); }
      }
    };
    walk(srcDir);
    const base = srcDir.split("/").filter(Boolean).pop() || "repo";
    const name = String(base).replace(/[^\w.\- ]/g, "_").slice(0, 60);
    const dest = join(p.dir, "repos", name);
    cpSync(srcDir, dest, { recursive: true, dereference: false });
    if (!p.repos.includes(name)) {
      p.repos.push(name);
      writeFileSync(join(p.dir, "project.json"), JSON.stringify({ id: p.id, name: p.name, createdAt: p.createdAt, repos: p.repos }, null, 2));
    }
    return name;
  }
  /** Repo directory for a session binding (defaults to the first repo). */
  repoDir(projectId, repo) {
    const p = this.get(projectId);
    if (!p) throw new Error(`Project not found: ${projectId}`);
    const name = repo && p.repos.includes(repo) ? repo : p.repos[0];
    if (!name) throw new Error(`Project ${projectId} has no repos`);
    return join(p.dir, "repos", name);
  }
  /** Project instructions, injected into the system prompt every turn (mtime-cached). */
  instructions(projectId) {
    const dir = this.dirOf(projectId);
    return dir ? this.cache.read(join(dir, "AGENTS.md")) ?? "" : "";
  }
}
