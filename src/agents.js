// Agents (P3): project experts. Each agent is a directory
// agents/<name>/AGENTS.md with frontmatter: description, tools (whitelist).
// The agent's instructions stack on the project's; its tool whitelist
// restricts which tools the session may call.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { EV } from "./events.js";
import { join } from "node:path";
import { FileCache } from "./file-cache.js";
import { parseFrontmatter } from "./frontmatter.js";

/** List agents of a project: [{name, description}]. */
export function agentList(projects, projectId, cache = new FileCache()) {
  if (!projectId || !projects) return [];
  const dir = join(projects.dir, projectId, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const content = cache.read(join(dir, d.name, "AGENTS.md"));
      if (!content) return null;
      const { meta } = parseFrontmatter(content);
      return { name: meta.name || d.name, description: meta.description || "" };
    })
    .filter(Boolean);
}

/** Create an agent definition (name + AGENTS.md). */
export function createAgent(projects, projectId, { name, description, body, tools }, cache = new FileCache()) {
  if (!projectId || !projects) throw new Error("project is required");
  const p = projects.get(projectId);
  if (!p) throw new Error(`Project not found: ${projectId}`);
  const safe = String(name || "").replace(/[^\w.\-]/g, "_").trim();
  if (!safe) throw new Error("agent name is required");
  if (!description?.trim()) throw new Error("agent description is required");
  const dir = join(p.dir, "agents", safe);
  mkdirSync(dir, { recursive: true }); // upsert: selecting an existing folder edits it
  const fm = `---\nname: ${safe}\ndescription: ${description.trim()}${tools?.length ? `\ntools: ${tools.join(", ")}` : ""}\n---\n`;
  const existing = cache.read(join(dir, "AGENTS.md"));
  // Upsert: keep existing body when the dialog left it blank (folder-preload case).
  const finalBody = body?.trim() || (existing ? parseFrontmatter(existing).body : "You are a specialist agent.");
  writeFileSync(join(dir, "AGENTS.md"), fm + finalBody);
  return { name: safe, description: description.trim() };
}

/** Delete an agent definition only (historical sessions keep their binding). */
export function deleteAgent(projects, projectId, name) {
  const p = projects.get(projectId);
  if (!p) throw new Error(`Project not found: ${projectId}`);
  const dir = join(p.dir, "agents", String(name).replace(/[^\w.\-]/g, "_"));
  if (!existsSync(join(dir, "AGENTS.md"))) throw new Error(`Agent not found: ${name}`);
  rmSync(dir, { recursive: true, force: true });
}

/** Load one agent: instructions (body) + tool whitelist. */
export function loadAgent(projects, projectId, name, cache = new FileCache()) {
  if (!projectId || !projects || name === "default") return null; // default = unrestricted
  const f = join(projects.dir, projectId, "agents", String(name).replace(/[^\w.\-]/g, "_"), "AGENTS.md");
  const content = cache.read(f);
  if (!content) return null;
  const { meta, body } = parseFrontmatter(content);
  const tools = meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : null;
  return { name: meta.name || name, instructions: body, tools };
}

/** Plugin: agent instruction injection (stacked on project AGENTS.md). */
export function installAgents(ctx) {
  const cache = ctx.get("fileCache") ?? new FileCache();
  ctx.on(EV.SYSTEM_PROMPT, async (base, next) => {
    const session = ctx.get("sessionScope")?.getStore();
    const agentName = session?.binding?.agent;
    if (!agentName) return next(base);
    const agent = loadAgent(ctx.get("projects"), session.binding.projectId, agentName, cache);
    if (!agent) return next(base);
    return next(`${base}\n\n## Agent: ${agent.name}\n${agent.instructions}`);
  }, "waterfall");
  // Tool whitelist enforcement at the executor (like approval): denied at execution time.
  // Default-deny: a session that declares an agent but whose agent cannot be
  // loaded denies everything (fail closed, never silently unrestricted).
  // Binding comes from the explicit req payload (loop-supplied), never from
  // reopening the session store inside the guard.
  ctx.on(EV.TOOLS_PRE_EXECUTE, async (req, next) => {
    const binding = req.binding ?? ctx.get("sessionScope")?.getStore()?.binding ?? null;
    if (!binding?.agent || binding.agent === "default") return next(req); // default agent: unrestricted
    const agent = loadAgent(ctx.get("projects"), binding.projectId, binding.agent, cache);
    if (!agent) { req.denied = `agent ${binding.agent} not found`; return next(req); }
    if (agent.tools && !agent.tools.includes(req.name)) {
      req.denied = `tool ${req.name} not in agent ${agent.name} whitelist`;
    }
    return next(req);
  }, "waterfall", { priority: 10 });
}
