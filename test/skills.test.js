import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { parseFrontmatter, skillIndex, loadSkill } from "../src/skills.js";

test("skills: L1 index injected, L2 load on demand, resource confined", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-sk-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-sk-home-")),
  });
  try {
    const projects = ctx.require("projects");
    const p = projects.create("sk-app");
    const dir = join(p.dir, "skills", "demo");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: demo skill for testing\n---\nDo the demo thing.");
    writeFileSync(join(dir, "ref.txt"), "resource content");
    // L1
    assert.deepEqual(skillIndex(projects, p.id), [{ name: "demo", description: "demo skill for testing" }]);
    // L2
    assert.match(loadSkill(projects, p.id, "demo"), /Do the demo thing/);
    assert.match(loadSkill(projects, p.id, "demo", "ref.txt"), /resource content/);
    assert.throws(() => loadSkill(projects, p.id, "demo", "../../etc/passwd"), /not found/);
    // injection: bound session turn carries the L1 index in system prompt
    const session = store.create({ projectId: p.id });
    await ctx.require("agentLoop").runTurn(session, "hi");
    const sys = session.events.filter((e) => e.type === "system/message").at(-1).data.text;
    assert.match(sys, /demo: demo skill for testing/);
    // tool path
    const tools = ctx.require("tools");
    const [r] = await tools.execute([{ id: "1", name: "skill_load", args: { name: "demo" } }], { session, projectId: p.id });
    assert.match(r.output, /Do the demo thing/);
    assert.equal(parseFrontmatter("---\nname: x\n---\nbody").meta.name, "x");
  } finally {
    await dispose();
  }
});
