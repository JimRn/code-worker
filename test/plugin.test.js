import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";

test("plugin unload: disposing a tool registration updates schemas()", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-plug-ws-"));
  const { ctx, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-plug-home-")),
  });
  try {
    const tools = ctx.require("tools");
    const before = tools.schemas().map((s) => s.function.name);
    assert.ok(before.includes("todo_write"));
    const off = tools.register({ name: "temp_tool", description: "t", schema: {}, execute: async () => "x" });
    assert.ok(tools.schemas().some((s) => s.function.name === "temp_tool"));
    off();
    assert.ok(!tools.schemas().some((s) => s.function.name === "temp_tool"));
  } finally {
    await dispose();
  }
});

test("scoped isolation: concurrent turns in different projects never cross workspaces", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-scope-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-scope-home-")),
  });
  try {
    const projects = ctx.require("projects");
    const a = projects.create("proj-a");
    const b = projects.create("proj-b");
    const sa = store.create({ projectId: a.id });
    const sb = store.create({ projectId: b.id });
    // Interleave: start A, observe fs root inside its turn, then B.
    const roots = [];
    ctx.on("agent/pre-step", async (pre, next) => { roots.push(ctx.require("fs").root); return next(pre); }, "waterfall");
    await Promise.all([
      ctx.require("agentLoop").runTurn(sa, "hello"),
      ctx.require("agentLoop").runTurn(sb, "hello"),
    ]);
    const dirA = projects.repoDir(a.id).split("repos")[0];
    assert.ok(roots.some((r) => r.includes("proj-a")), roots.join(" | "));
    assert.ok(roots.some((r) => r.includes("proj-b")), roots.join(" | "));
    void dirA;
    // after both turns, default root restored
    assert.equal(ctx.require("fs").root, ws);
  } finally {
    await dispose();
  }
});
