import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "../src/context.js";
import { LocalFs } from "../src/fs.js";
import { LocalShell } from "../src/shell.js";

test("waterfall priority: higher runs first regardless of registration order; ties stable", async () => {
  const ctx = new Context();
  const order = [];
  ctx.on("agent/pre-step", async (v, next) => { order.push("low"); return next(v); }, "waterfall", { priority: 0 });
  ctx.on("agent/pre-step", async (v, next) => { order.push("high"); return next(v); }, "waterfall", { priority: 20 });
  ctx.on("agent/pre-step", async (v, next) => { order.push("mid"); return next(v); }, "waterfall", { priority: 10 });
  await ctx.waterfall("agent/pre-step", {});
  assert.deepEqual(order, ["high", "mid", "low"]);
  await ctx.dispose();
});

test("fs/shell scopes are per-instance: two providers never cross", async () => {
  const a = mkdtempSync(join(tmpdir(), "cw-scope-a-"));
  const b = mkdtempSync(join(tmpdir(), "cw-scope-b-"));
  const fsA = new LocalFs(a), fsB = new LocalFs(b);
  await Promise.all([
    fsA.withRoot(a, async () => { await new Promise((r) => setTimeout(r, 10)); assert.equal(fsA.root, a); assert.equal(fsB.root, b); }),
    fsB.withRoot(b, async () => { assert.equal(fsB.root, b); assert.equal(fsA.root, a); }),
  ]);
  const shA = new LocalShell(a), shB = new LocalShell(b);
  await Promise.all([
    shA.withWorkspace(a, async () => { await new Promise((r) => setTimeout(r, 5)); assert.equal(shA.workspace, a); assert.equal(shB.workspace, b); }),
    shB.withWorkspace(b, async () => { assert.equal(shB.workspace, b); }),
  ]);
});
