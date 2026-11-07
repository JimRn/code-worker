import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { agentList, loadAgent } from "../src/agents.js";

test("agents: list/load, instruction injection, tool whitelist at executor", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-ag-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-ag-home-")),
  });
  try {
    const projects = ctx.require("projects");
    const p = projects.create("ag-app");
    const dir = join(p.dir, "agents", "reader");
    mkdirSync(dir);
    writeFileSync(join(dir, "AGENTS.md"), "---\nname: reader\ndescription: read-only reviewer\ntools: read_file, list_dir\n---\nYou only read code and report. Never write.");
    assert.deepEqual(agentList(projects, p.id), [{ name: "reader", description: "read-only reviewer" }]);
    assert.deepEqual(loadAgent(projects, p.id, "reader").tools, ["read_file", "list_dir"]);

    const session = store.create({ projectId: p.id, agent: "reader" });
    await ctx.require("agentLoop").runTurn(session, "hi");
    const sys = session.events.filter((e) => e.type === "system/message").at(-1).data.text;
    assert.match(sys, /Agent: reader/);
    // whitelist: bash denied at executor even though autoApprove is on
    const [r] = await ctx.require("tools").execute([{ id: "1", name: "bash", args: { command: "echo hi" } }], { session, projectId: p.id, sessionId: session.id, binding: session.binding });
    assert.match(r.output, /not in agent reader whitelist/);
  } finally {
    await dispose();
  }
});
