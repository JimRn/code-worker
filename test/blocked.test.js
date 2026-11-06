import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFs } from "../src/fs.js";

test("fs seam blocks sensitive dirs at tool layer (not just workspace selection)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cw-blk-"));
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "id_rsa"), "SECRET");
  const fs = new LocalFs(root);
  await assert.rejects(() => fs.readFile(".ssh/id_rsa"), /sensitive/);
  await assert.rejects(() => fs.listDir(".ssh"), /sensitive/);
  await assert.rejects(() => fs.writeFile(".aws/creds", "x"), /sensitive/);
  // normal paths still work
  writeFileSync(join(root, "ok.txt"), "ok");
  assert.equal(await fs.readFile("ok.txt"), "ok");
});

test("fs canonical: symlink inside workspace pointing outside is rejected (read+write)", async () => {
  const root = mkdtempSync(join(tmpdir(), "cw-blk2-"));
  symlinkSync("/etc", join(root, "evil"));
  symlinkSync("/tmp", join(root, "tmp-link"));
  const fs = new LocalFs(root);
  await assert.rejects(() => fs.readFile("evil/hostname"), /escapes workspace/);
  await assert.rejects(() => fs.writeFile("evil/x", "1"), /escapes workspace/);
  await assert.rejects(() => fs.listDir("tmp-link"), /escapes workspace/);
});
