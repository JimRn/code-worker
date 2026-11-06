import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("frontend: markdown renderer, code copy, tool-card distinction present", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(js, /function mdToHtml/);
  assert.match(js, /navigator\.clipboard/);
  assert.match(js, /class="toolcall"/);
  assert.match(js, /class="codeblock"/);
  assert.match(css, /\.codeblock/);
  assert.match(css, /\.toolcall/);
  // XSS hygiene: user/model text escaped before markdown transform
  assert.match(js, /let html = esc\(text\)/);
});
