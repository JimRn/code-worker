import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { listOutputs } from "../src/outputs.js";

test("repos: import existing dir; outputs: report_write lands in project outputs/", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cw-ro-ws-"));
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: ws, autoApprove: true, mock: true, home: mkdtempSync(join(tmpdir(), "cw-ro-home-")),
  });
  try {
    const projects = ctx.require("projects");
    const p = projects.create("ro-app");
    // import an existing directory
    const src = mkdtempSync(join(tmpdir(), "cw-ro-src-"));
    writeFileSync(join(src, "index.js"), "console.log(1)");
    const name = projects.importRepo(p.id, src);
    assert.ok(existsSync(join(p.dir, "repos", name, "index.js")));
    // report_write
    const session = store.create({ projectId: p.id });
    const tools = ctx.require("tools");
    const [r] = await tools.execute([{ id: "1", name: "report_write", args: { title: "Weekly Report", content: "did things" } }], { session, projectId: p.id, sessionId: session.id });
    assert.match(r.output, /outputs\//);
    assert.equal(listOutputs(projects, p.id).length, 1);
    assert.match(listOutputs(projects, p.id)[0], /weekly-report/);
  } finally {
    await dispose();
  }
});
