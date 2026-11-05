import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session.js";

test("store identity: open() returns the same live Session (SSE subscribers see appends)", async () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "cw-id-")));
  const created = store.create();
  const a = store.open(created.id);
  const b = store.open(created.id);
  assert.equal(a, b);
  const seen = [];
  a.subscribe((ev) => seen.push(ev.type));
  await b.append("user/message", { text: "hello" });
  assert.deepEqual(seen, ["user/message"]);
});
