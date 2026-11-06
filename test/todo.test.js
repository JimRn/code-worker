import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { validateTodos } from "../src/todo.js";

test("todo_write: whole-list replace, durable projection, validation", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-todo-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-todo-home-")),
  });
  try {
    const session = store.create();
    const tools = ctx.require("tools");
    const [r1] = await tools.execute([{ id: "1", name: "todo_write", args: { todos: [{ content: "a" }, { content: "b", status: "in_progress" }] } }], { session });
    assert.match(r1.output, /0\/2/);
    assert.deepEqual(session.todos(), [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }]);
    // second write replaces wholesale (last-write-wins)
    await tools.execute([{ id: "2", name: "todo_write", args: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }] } }], { session });
    assert.deepEqual(session.todos().map((t) => t.status), ["completed", "completed"]);
    // log-only: todos never enter model history
    assert.ok(!session.deriveMessages().some((m) => m.content.includes("todos updated")));
    // validation
    assert.throws(() => validateTodos([{ content: "x", status: "bogus" }]), /invalid status/);
    assert.throws(() => validateTodos("no"), /must be an array/);
  } finally {
    await dispose();
  }
});
