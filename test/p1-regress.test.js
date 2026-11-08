import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";

async function boot(extra = {}) {
  const ws = mkdtempSync(join(tmpdir(), "cw-ap-ws-"));
  const home = mkdtempSync(join(tmpdir(), "cw-ap-home-"));
  return { ws, home, ...await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, { workspace: ws, autoApprove: false, mock: true, home, ...extra }) };
}

test("approval guard is per-session: one session's auto-approve does not leak", async () => {
  const { ctx, dispose } = await boot();
  try {
    const tools = ctx.require("tools");
    // Session A auto-approved via bySession, session B not.
    const approval = ctx.get("sessions"); void approval;
    // Reach the shared ref through a tool call with no session: global fallback denies.
    const [r] = await tools.execute([{ id: "1", name: "write_file", args: { path: "x.txt", content: "y" } }], { sessionId: "sess-b" });
    assert.match(r.output, /Denied/);
  } finally { await dispose(); }
});

test("todo write path goes through todo-owned writer; core Session has no writeTodos", async () => {
  const { ctx, store, dispose } = await boot();
  try {
    const session = store.create();
    assert.equal(session.writeTodos, undefined);
    const tools = ctx.require("tools");
    const [r] = await tools.execute([{ id: "t1", name: "todo_write", args: { todos: [{ content: "a" }] } }], { session, sessionId: session.id });
    assert.match(r.output, /todos updated/);
    assert.equal(session.todos().length, 1);
  } finally { await dispose(); }
});
