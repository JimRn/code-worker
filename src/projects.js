// Projects (P1): project-level management with strict isolation.
// Layout: <projectsDir>/<id>/{project.json, AGENTS.md, docs/, skills/, agents/, outputs/, repos/<repo>/}
// Env: CW_PROJECTS_DIR overrides the location (default ~/.code-worker/projects).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export function projectsDir() {
  return process.env.CW_PROJECTS_DIR ?? join(homedir(), ".code-worker", "projects");
}

const SUBDIRS = ["docs", "skills", "agents", "outputs", "repos"];
const AGENTS_TEMPLATE = "# Project Instructions\n\nDescribe project conventions, architecture, and rules every agent session must follow.\n";

export class ProjectStore {
  constructor(dir = projectsDir()) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }
  create(name) {
    if (!name || !String(name).trim()) throw new Error("project name is required");
    const id = randomUUID().slice(0, 8);
    const dir = join(this.dir, id);
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
    const dir = join(this.dir, id);
    if (!existsSync(join(dir, "project.json"))) return null;
    const meta = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    // Creation order from project.json (readdir order is alphabetical).
    const onDisk = existsSync(join(dir, "repos")) ? readdirSync(join(dir, "repos")) : [];
    const repos = [...(meta.repos ?? []), ...onDisk.filter((r) => !(meta.repos ?? []).includes(r))];
    return { ...meta, repos, dir };
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
  /** Repo directory for a session binding (defaults to the first repo). */
  repoDir(projectId, repo) {
    const p = this.get(projectId);
    if (!p) throw new Error(`Project not found: ${projectId}`);
    const name = repo && p.repos.includes(repo) ? repo : p.repos[0];
    if (!name) throw new Error(`Project ${projectId} has no repos`);
    return join(p.dir, "repos", name);
  }
  /** Project instructions, injected into the system prompt every turn. */
  instructions(projectId) {
    const f = join(this.dir, projectId, "AGENTS.md");
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  }
}
