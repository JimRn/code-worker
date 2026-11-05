import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "../src/context.js";
import { bootProfile } from "../src/profile.js";

test("waterfall must next() to delegate; non-delegation short-circuits", async () => {
  const ctx = new Context();
  ctx.on("tools/pre-execute", async (v, next) => next({ ...v, a: 1 }), "waterfall");
  ctx.on("tools/pre-execute", async (v) => ({ ...v, b: 2 }), "waterfall"); // short-circuits
  const out = await ctx.waterfall("tools/pre-execute", { x: 0 });
  assert.equal(out.a, 1); assert.equal(out.b, 2);
  await ctx.dispose();
});

test("registrations are reversible effects", async () => {
  const ctx = new Context();
  const dispose = ctx.provide("fs", { v: 1 });
  assert.equal(ctx.get("fs").v, 1);
  dispose();
  assert.equal(ctx.get("fs"), undefined);
  await ctx.dispose();
});

test("mock end-to-end: list_dir tool round-trip is fully logged", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-ws-"));
  writeFileSync(join(ws, "hello.txt"), "hi");
  const home = mkdtempSync(join(tmpdir(), "cw-home-"));
  // boot with mock profile against temp workspace/home via profile config override:
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: true, mock: true });
  const session = store.create();
  // point session home is profile home; just assert turn runs and log contains tool flow
  await ctx.require("agentLoop").runTurn(session, "list files in workspace");
  const types = session.events.map((e) => e.type);
  assert.ok(types.includes("turn/start") && types.includes("turn/end"));
  assert.ok(types.includes("tool/call") && types.includes("tool/result"));
  assert.ok(session.deriveMessages().some((m) => m.role === "tool" && m.content.includes("hello.txt")));
  await dispose();
});

test("fs confinement: path escape fails loud", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-ws2-"));
  const { ctx, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: true, mock: true });
  await assert.rejects(() => ctx.require("fs").readFile("../secret"), /escapes workspace/);
  await dispose();
});

test("approval guard denies write_file without --yes (enforced at executor)", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-ws3-"));
  const { ctx, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: false, mock: true });
  const [r] = await ctx.require("tools").execute([{ id: "1", name: "write_file", args: { path: "x.txt", content: "y" } }]);
  assert.match(r.output, /Denied/);
  await dispose();
});
