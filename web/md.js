// Minimal Markdown renderer (zero-dep), shared by browser (ES module) and tests.
// Contract: code blocks are extracted from RAW text first, then everything is
// escaped exactly once; code content renders verbatim (no double-escape).
export const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
export const escAttr = (t) => esc(t).replace(/"/g, "&quot;");

// Page-wide monotonic block id: copy buttons never collide across messages.
let blockSeq = 0;

export function mdToHtml(text) {
  const blocks = [];
  // 1) extract fenced code from RAW text (before escaping)
  let raw = String(text).replace(/```(\w*)\n([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    blocks.push({ lang, code });
    return `\u0000${blocks.length - 1}\u0000`;
  });
  // 2) escape the rest exactly once
  let html = esc(raw);
  html = html
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    // link URL: http/https only, quotes excluded by charset so href cannot be
    // broken out of; url is already-escaped text (no second escape).
    .replace(/\[([^\]]+)\]\((https?:[^)\s"']+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`)
    // Workspace file paths (outputs/x.md, snake.html, docs/y.txt) as clickable chips.
    .replace(/(?<![\w"'>])((?:[\w.\-一-鿿]+\/)*[\w.\-一-鿿]+\.(?:md|html|htm|txt|pdf|xlsx?|docx|pptx?|log|json|png|jpg|jpeg|gif|webp))(?!<)(?=[\s'")\]]|$)/g, (_, f) => `<code class="filechip" data-file="${f}" tabindex="0">${f}</code>`);
  const lines = html.split("\n");
  let out = "", inList = false, inTable = false, firstRow = false;
  const tableRow = (line, tag) =>
    `<tr>${line.split("|").slice(1, -1).map((c) => `<${tag}>${c.trim()}</${tag}>`).join("")}</tr>`;
  for (const line of lines) {
    if (/^\|[\s:|-]+\|$/.test(line.trim())) continue; // separator row
    if (/^\|.*\|$/.test(line.trim())) {
      if (!inTable) { out += "<table>"; inTable = true; firstRow = true; }
      out += tableRow(line, firstRow ? "th" : "td");
      firstRow = false;
      continue;
    }
    if (inTable) { out += "</table>"; inTable = false; }
    const m = line.match(/^\s*[-*] (.*)$/);
    if (m) { if (!inList) { out += "<ul>"; inList = true; } out += `<li>${m[1]}</li>`; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    if (/^\u0000\d+\u0000$/.test(line.trim())) { out += line; continue; }
    out += line.trim() ? `<p>${line}</p>` : "";
  }
  if (inList) out += "</ul>";
  if (inTable) out += "</table>";
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const { lang, code } = blocks[i];
    const id = ++blockSeq;
    return `<div class="codeblock" data-block="${id}"><div class="codehead"><span>${esc(lang || "text")}</span><button class="copy" data-block="${id}">复制</button></div><pre><code>${esc(code)}</code></pre></div>`;
  });
}
