import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../src/projects.js";
import { bootProfile } from "../src/profile.js";

test("projects: CRUD, structure, repo default, instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-proj-"));
  const store = new ProjectStore(dir);
  const p = store.create("my-app");
  assert.ok(p.repos.includes("main"));
  assert.equal(store.list().length, 1);
  assert.equal(store.addRepo(p.id, "api"), "api");
  assert.deepEqual(store.get(p.id).repos.sort(), ["api", "main"]);
  assert.equal(store.repoDir(p.id), join(dir, "my-app", "repos", "main")); // default first repo; dir is NAME-named
  assert.match(store.instructions(p.id), /Project Instructions/);
  assert.throws(() => store.create(""), /required/);
});

test("project isolation: bound session turn runs inside project repo; AGENTS.md injected per turn", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-piso-ws-"));
  const home = mkdtempSync(join(tmpdir(), "cw-piso-home-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home,
  });
  try {
    const projects = ctx.require("projects");
    const p = projects.create("iso-app");
    writeFileSync(join(p.dir, "AGENTS.md"), "ALWAYS use tabs");
    writeFileSync(join(p.dir, "repos", "main", "keep.txt"), "from-project");
    const session = store.create({ projectId: p.id });
    assert.equal(session.binding.projectId, p.id);
    const seen = [];
    ctx.on("agent/pre-step", async (pre, next) => { seen.push(pre.messages[0]?.content ?? ""); return next(pre); }, "waterfall");
    await ctx.require("agentLoop").runTurn(session, "hello");
    // system prompt injected from project AGENTS.md
    const sysEvents = session.events.filter((e) => e.type === "system/message");
    assert.match(sysEvents.at(-1).data.text, /ALWAYS use tabs/);
    // fs root restored after turn (isolation is per-turn)
    assert.equal(ctx.require("fs").root, ws);
  } finally {
    await dispose();
  }
});
