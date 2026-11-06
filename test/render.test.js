import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mdToHtml } from "../web/md.js";

test("md: fenced code escaped exactly once (no double-escape)", () => {
  const html = mdToHtml("```cpp\ncout << a < b;\n```");
  assert.match(html, /cout &lt;&lt; a &lt; b;/);
  assert.ok(!html.includes("&amp;lt;"), "must not double-escape");
});

test("md: copy blocks get page-wide monotonic ids (no cross-message collision)", () => {
  const a = mdToHtml("```\nfirst\n```");
  const b = mdToHtml("```\nsecond\n```");
  const idA = a.match(/data-block="(\d+)"/)[1];
  const idB = b.match(/data-block="(\d+)"/)[1];
  assert.notEqual(idA, idB);
});

test("md: link URL cannot break out of href via quotes", () => {
  const html = mdToHtml('[t](https://example.com/"onclick="alert(1))');
  assert.ok(!/<a[^>]*onclick/.test(html), html);
  // and a clean link still renders with escaped href
  assert.match(mdToHtml("[ok](https://example.com/a?b=1&c=2)"), /href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
});

test("frontend: tool cards + clipboard fallback present", () => {
  const js = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(js, /from "\.\/md\.js"/);
  assert.match(js, /execCommand\("copy"\)/);
  assert.match(js, /tool-block/); assert.match(js, /assistant/reasoning/);
});
