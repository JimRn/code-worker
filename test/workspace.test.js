import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootProfile } from "../src/profile.js";
import { startWebServer } from "../src/web/server.js";

test("workspace: browse entries and switch root (fs + shell follow)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cw-wsroot-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "a.txt"), "a");
  const approval = { current: true };
  const { ctx, store, dispose } = await bootProfile(new URL("../profiles/personal.json", import.meta.url).pathname, {
    workspace: root, autoApprove: approval, mock: true, home: mkdtempSync(join(tmpdir(), "cw-ws-home-")),
  });
  const server = await startWebServer({ ctx, store, approval }, { port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/workspace?path=.`)).json();
    assert.deepEqual(list.entries.map((e) => e.name).sort(), ["a.txt", "sub"]);
    assert.equal(list.entries.find((e) => e.name === "sub").dir, true);
    // escape attempts are rejected by fs confinement
    assert.equal((await fetch(`${base}/api/workspace?path=..`)).status, 400);
    // switch root persists and tools follow
    const other = mkdtempSync(join(tmpdir(), "cw-wsother-"));
    writeFileSync(join(other, "b.txt"), "b");
    const put = await (await fetch(`${base}/api/workspace`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: other }) })).json();
    assert.equal(put.root, other);
    const list2 = await (await fetch(`${base}/api/workspace?path=.`)).json();
    assert.deepEqual(list2.entries.map((e) => e.name), ["b.txt"]);
    assert.equal(ctx.require("fs").root, other);
  } finally {
    server.close();
    await dispose();
  }
});
