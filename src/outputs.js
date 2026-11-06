// Outputs (P5): session reports live in projects/<id>/outputs/<date>-<slug>.md,
// shared by all sessions/agents of the project. report_write is the narrow
// capability tool (like appendTodo): write-only, project-scoped.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** List reports of a project (newest first). */
export function listOutputs(projects, projectId) {
  if (!projectId || !projects) return [];
  const dir = join(projects.dir, projectId, "outputs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
}

function slug(s) {
  return String(s || "report").toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "report";
}

/** Plugin: report_write tool -> project outputs/. */
export function installOutputs(ctx) {
  ctx.effect(() => ctx.require("tools").register({
    name: "report_write",
    description: "Write a session report (Markdown) into the project's outputs/ for all sessions to share.",
    schema: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string" } },
      required: ["title", "content"],
    },
    execute: async ({ title, content }, req) => {
      const projects = ctx.get("projects");
      if (!req.projectId || !projects) throw new Error("report_write requires a project-bound session");
      const p = projects.get(req.projectId);
      if (!p) throw new Error(`Project not found: ${req.projectId}`);
      if (content.length > 200 * 1024) throw new Error("report content too large (200KB)");
      const date = new Date().toISOString().slice(0, 10);
      const dir = join(p.dir, "outputs");
      mkdirSync(dir, { recursive: true });
      // Never overwrite: same-day same-title gets a sequence suffix.
      let file = `${date}-${slug(title)}.md`;
      for (let n = 2; existsSync(join(dir, file)); n++) file = `${date}-${slug(title)}-${n}.md`;
      writeFileSync(join(dir, file), `# ${title}\n\n${content}\n`);
      return `report written: outputs/${file}`;
    },
  }));
}
