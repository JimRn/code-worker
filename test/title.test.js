import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";

test("title: generated once after first turn via LLM, durable as session/title", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-title-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-title-home-")),
  });
  try {
    const session = store.create();
    await ctx.require("agentLoop").runTurn(session, "hello world task");
    const title = session.title();
    assert.ok(title && title.length > 0 && title.length <= 60);
    assert.equal(session.events.filter((e) => e.type === "session/title").length, 1);
    // second turn does not regenerate
    await ctx.require("agentLoop").runTurn(session, "继续");
    assert.equal(session.events.filter((e) => e.type === "session/title").length, 1);
  } finally {
    await dispose();
  }
});
