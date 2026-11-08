import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { createAgent, deleteAgent, agentList } from "../src/agents.js";
import { usageByAgent } from "../src/session-views.js";

test("agent CRUD + per-agent/project usage rollup with cache hit rate", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-acu-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-acu-home-")),
  });
  try {
    const projects = ctx.require("projects");
    const p = projects.create("acu-app");
    createAgent(projects, p.id, { name: "reader", description: "reader", body: "read only", tools: ["read_file"] });
    assert.equal(agentList(projects, p.id).length, 1);
    createAgent(projects, p.id, { name: "reader", description: "dup" }); assert.equal(agentList(projects, p.id).length, 1);
    // usage rollup
    const s = store.create({ projectId: p.id, agent: "reader" });
    await s.append("assistant/message", { text: "a", usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } } });
    await s.append("turn/end", {});
    const byAgent = usageByAgent([s]);
    assert.equal(byAgent.reader.total, 120);
    assert.equal(byAgent.reader.cacheRead, 80);
    assert.equal(byAgent.reader.hitRate, 80);
    // delete definition only
    deleteAgent(projects, p.id, "reader");
    assert.equal(agentList(projects, p.id).length, 0);
    assert.equal(s.binding.agent, "reader"); // historical session binding kept
    assert.equal(existsSync(join(p.dir, "agents", "reader")), false);
  } finally {
    await dispose();
  }
});
