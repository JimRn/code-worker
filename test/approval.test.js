import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";

test("per-call approval: executor suspends until decision; deny blocks the write", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-appr-ws-"));
  const approval = { current: false, mode: "per-call" };
  const { ctx, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: approval, mock: true, home: mkdtempSync(join(tmpdir(), "cw-appr-home-")),
  });
  try {
    const notified = [];
    approval.notify = (r) => notified.push(r);
    const tools = ctx.require("tools");
    // deny path
    const p1 = tools.execute([{ id: "c1", name: "write_file", args: { path: "a.txt", content: "x" } }]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notified.length, 1);
    assert.equal(notified[0].name, "write_file");
    approval.pending.get("c1").resolve(false);
    const [r1] = await p1;
    assert.match(r1.output, /denied/);
    assert.equal(existsSync(join(ws, "a.txt")), false);
    // approve path
    const p2 = tools.execute([{ id: "c2", name: "write_file", args: { path: "b.txt", content: "y" } }]);
    await new Promise((r) => setTimeout(r, 50));
    approval.pending.get("c2").resolve(true);
    const [r2] = await p2;
    assert.equal(existsSync(join(ws, "b.txt")), true);
  } finally {
    await dispose();
  }
});
