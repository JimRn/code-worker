// Agents (P3): project experts. Each agent is a directory
// agents/<name>/AGENTS.md with frontmatter: description, tools (whitelist).
// The agent's instructions stack on the project's; its tool whitelist
// restricts which tools the session may call.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./skills.js";
import { sessionScope } from "./session.js";

/** List agents of a project: [{name, description}]. */
export function agentList(projects, projectId) {
  if (!projectId || !projects) return [];
  const dir = join(projects.dir, projectId, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const f = join(dir, d.name, "AGENTS.md");
      if (!existsSync(f)) return null;
      const { meta } = parseFrontmatter(readFileSync(f, "utf8"));
      return { name: meta.name || d.name, description: meta.description || "" };
    })
    .filter(Boolean);
}

/** Load one agent: instructions (body) + tool whitelist. */
export function loadAgent(projects, projectId, name) {
  if (!projectId || !projects) return null;
  const f = join(projects.dir, projectId, "agents", String(name).replace(/[^\w.\-]/g, "_"), "AGENTS.md");
  if (!existsSync(f)) return null;
  const { meta, body } = parseFrontmatter(readFileSync(f, "utf8"));
  const tools = meta.tools ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean) : null;
  return { name: meta.name || name, instructions: body, tools };
}

/** Plugin: agent instruction injection (stacked on project AGENTS.md). */
export function installAgents(ctx) {
  ctx.on("system-prompt/assemble", async (base, next) => {
    const session = sessionScope.getStore();
    const agentName = session?.binding?.agent;
    if (!agentName) return next(base);
    const agent = loadAgent(ctx.get("projects"), session.binding.projectId, agentName);
    if (!agent) return next(base);
    return next(`${base}\n\n## Agent: ${agent.name}\n${agent.instructions}`);
  }, "waterfall");
  // Tool whitelist enforcement at the executor (like approval): denied at execution time.
  ctx.on("tools/pre-execute", async (req, next) => {
    // Prefer the live turn scope; fall back to the session binding by id.
    const scoped = sessionScope.getStore();
    const binding = scoped?.binding ?? (req.sessionId && ctx.get("sessions") ? ctx.get("sessions").open(req.sessionId).binding : null);
    const agent = binding?.agent
      ? loadAgent(ctx.get("projects"), binding.projectId, binding.agent)
      : null;
    if (agent?.tools && !agent.tools.includes(req.name)) {
      req.denied = `tool ${req.name} not in agent ${agent.name} whitelist`;
    }
    return next(req);
  }, "waterfall");
}
