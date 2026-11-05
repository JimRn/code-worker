import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";

test("per-turn model override flows to prepareCall (modelSelection snapshot)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-mo-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-mo-home-")),
  });
  try {
    const seen = [];
    ctx.on("agent/pre-step", async (pre, next) => { seen.push(pre.modelSelection.model); return next(pre); }, "waterfall");
    const session = store.create();
    await ctx.require("agentLoop").runTurn(session, "hi", { model: "override-model" });
    assert.ok(seen.includes("override-model"));
    await ctx.require("agentLoop").runTurn(session, "hi2");
    assert.ok(!seen.slice(1).includes("override-model")); // next turn back to default
  } finally {
    await dispose();
  }
});
