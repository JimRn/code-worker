// Skills: progressive disclosure (L1 index in prompt, L2 on demand).
// Layout per skill: skills/<name>/SKILL.md with YAML-ish frontmatter
// (name, description) + body; extra files under the skill dir are resources.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { EV } from "./events.js";
import { basename, dirname, join, resolve, sep } from "node:path";
import { FileCache } from "./file-cache.js";
import { isInBlockedDir } from "./policy.js";
import { parseFrontmatter } from "./frontmatter.js";
export { parseFrontmatter }; // back-compat re-export (tests import from here)

/** L1 index: [{name, description}] for every skill in the project. */
export function skillIndex(projects, projectId, cache = new FileCache()) {
  if (!projectId || !projects) return [];
  const dir = join(projects.dirOf?.(projectId) ?? join(projects.dir, projectId), "skills");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const content = cache.read(join(dir, d.name, "SKILL.md"));
      if (!content) return null;
      const { meta } = parseFrontmatter(content);
      return { name: meta.name || d.name, description: meta.description || "" };
    })
    .filter(Boolean);
}

/** L2 load: full SKILL.md body (+ optional resource file inside the skill dir). */
export function loadSkill(projects, projectId, name, resource) {
  if (!projectId || !projects) throw new Error("skill_load requires a project-bound session");
  const safe = String(name).replace(/[^\w.\-]/g, "_");
  const dir = join(projects.dirOf?.(projectId) ?? join(projects.dir, projectId), "skills", safe);
  const f = join(dir, "SKILL.md");
  if (!existsSync(f)) throw new Error(`Skill not found: ${safe}`);
  const { body } = parseFrontmatter(readFileSync(f, "utf8"));
  if (!resource) return body.slice(0, 200 * 1024);
  // Canonicalize + confine + BLOCKED, then size-limit (same discipline as fs seam).
  let rf = resolve(dir, String(resource).replace(/[^\w.\- /]/g, "_"));
  let rest = [];
  while (!existsSync(rf)) { rest.unshift(basename(rf)); rf = dirname(rf); }
  rf = join(realpathSync(rf), ...rest);
  const base = realpathSync(dir);
  if (rf !== base && !rf.startsWith(base + sep)) throw new Error(`Skill resource not found: ${resource}`);
  if (isInBlockedDir(rf, sep)) throw new Error("Skill resource in sensitive directory");
  if (!statSync(rf).isFile() || statSync(rf).size > 200 * 1024) throw new Error("Skill resource too large or missing");
  return `${body}\n\n--- ${resource} ---\n${readFileSync(rf, "utf8")}`;
}

/** Plugin: L1 index injection + skill_load tool. */
export function installSkills(ctx) {
  const cache = ctx.get("fileCache") ?? new FileCache();
  ctx.on(EV.SYSTEM_PROMPT, async (base, next) => {
    const session = ctx.get("sessionScope")?.getStore();
    const index = skillIndex(ctx.get("projects"), session?.binding?.projectId, cache);
    if (!index.length) return next(base);
    const lines = index.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    return next(`${base}\n\n## Available skills (load with skill_load when needed)\n${lines}`);
  }, "waterfall");
  ctx.effect(() => ctx.require("tools").register({
    name: "skill_load",
    description: "Load a skill's full instructions (progressive disclosure L2).",
    schema: {
      type: "object",
      properties: { name: { type: "string" }, resource: { type: "string" } },
      required: ["name"],
    },
    execute: async ({ name, resource }, req) => loadSkill(ctx.get("projects"), req.projectId, name, resource),
  }));
}
