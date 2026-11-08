import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile, validatePluginConfig } from "../src/profile.js";
import { shouldWrap } from "../src/service-definitions.js";

async function boot() {
  const ws = mkdtempSync(join(tmpdir(), "cw-p1-ws-"));
  const home = mkdtempSync(join(tmpdir(), "cw-p1-home-"));
  return { ws, home, ...await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: true, mock: true, home }) };
}

test("capability view: consumers see only declared members", async () => {
  const { ctx, dispose } = await boot();
  try {
    const fs = ctx.require("fs");
    assert.equal(typeof fs.readFile, "function");
    assert.equal(fs.defaultRoot, undefined); // internals hidden
    assert.equal(shouldWrap("fs", { v: 1 }), false); // plain data is not wrapped
  } finally { await dispose(); }
});

test("event registry: feature events need plugin registration", async () => {
  const { ctx, store, dispose } = await boot();
  try {
    const s = store.create();
    await s.append("user/message", { text: "x" }); // core type
    await assert.rejects(() => s.append("unknown/feature", {}), /Unknown session event type/);
    ctx.raw("sessions").registerEventType("unknown/feature"); // internal registry, not on the view
    await s.append("unknown/feature", {});
    assert.equal(store.registerEventType, undefined); // view does not expose the registry
  } finally { await dispose(); }
});

test("plugin config validation: unknown keys fail loud, named", async () => {
  assert.throws(() => validatePluginConfig("agent-loop", { configSchema: { properties: { maxSteps: true } } }, { bogus: 1 }), /agent-loop: unknown config key.*bogus/);
  assert.deepEqual(validatePluginConfig("agent-loop", { configSchema: { properties: { maxSteps: true } } }, { maxSteps: 3 }), { maxSteps: 3 });
  assert.throws(() => validatePluginConfig("todo", {}, { x: 1 }), /no configSchema/);
});

test("per-plugin config takes effect through boot", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-p1-ws2-"));
  const home = mkdtempSync(join(tmpdir(), "cw-p1-home2-"));
  const profilePath = join(tmpdir(), `cw-p1-${Date.now()}.json`);
  const base = JSON.parse(readFileSync(new URL("../profiles/personal.json", import.meta.url).pathname, "utf8"));
  writeFileSync(profilePath, JSON.stringify({ ...base, home, config: { ...base.config, plugins: { "agent-loop": { maxSteps: 3 } } } }));
  const { ctx, dispose } = await bootProfile(profilePath, { workspace: ws, autoApprove: true, mock: true, home });
  try {
    assert.equal(ctx.require("agentLoop").maxSteps, 3);
  } finally { await dispose(); }
});
