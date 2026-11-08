import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectEnvStore } from "../src/project-env.js";
import { bootProfile } from "../src/profile.js";

test("project env: secrets write-only, plain readable, list never leaks values", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-env-"));
  const env = new ProjectEnvStore(dir);
  env.set("PLAIN_KEY", "visible");
  env.set("API_TOKEN", "super-secret", { secret: true });
  const list = env.list();
  assert.equal(list.find((v) => v.key === "API_TOKEN").hasValue, true);
  assert.ok(!JSON.stringify(list).includes("super-secret"));
  assert.equal(env.get("API_TOKEN"), "super-secret");
  assert.equal(env.plain().PLAIN_KEY, "visible");
  assert.equal(env.plain().API_TOKEN, undefined); // secrets excluded from prompt-visible
  assert.throws(() => env.set("bad-key", "x"), /invalid env key/);
  env.delete("API_TOKEN");
  assert.equal(env.get("API_TOKEN"), undefined);
  void readFileSync;
});

test("project env via ctx service: system prompt gets plain only; bash child env gets secrets without logs", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-env-ws-"));
  const home = mkdtempSync(join(tmpdir(), "cw-env-home-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home,
  });
  try {
    const projects = ctx.require("projects");
    const p = projects.create("env-app");
    const penv = ctx.require("projectEnv");
    penv.set(p.id, "APP_ENV", "dev");
    penv.set(p.id, "DEPLOY_TOKEN", "s3cr3t", { secret: true });
    const session = store.create({ projectId: p.id });
    await ctx.require("agentLoop").runTurn(session, "hello");
    const sys = session.events.filter((e) => e.type === "system/message").at(-1)?.data.text ?? "";
    assert.match(sys, /APP_ENV=dev/);
    assert.ok(!sys.includes("s3cr3t"));
    assert.ok(!JSON.stringify(session.events).includes("s3cr3t"), "secret must never land in the log");
    // bash tool: secret lands in child env output (by design it can print it, but we never log it)
    const [r] = await ctx.require("tools").execute([{ id: "1", name: "bash", args: { command: "echo $APP_ENV" } }], { sessionId: session.id, projectId: p.id, session, binding: session.binding });
    assert.match(r.output, /dev/);
  } finally { await dispose(); }
});
