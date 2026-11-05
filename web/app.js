// Browser client: renders the conversation from session/event stream (SSE),
// like DSH's Web Session-follow adapter. No framework, zero deps.
const $ = (s) => document.querySelector(s);
let currentId = null;
let stream = null;
// LAN token: ?token= in URL is persisted to localStorage and appended to API calls.
const TOKEN = new URLSearchParams(location.search).get("token") ?? localStorage.getItem("cw-token") ?? "";
if (TOKEN) localStorage.setItem("cw-token", TOKEN);
const api = (path) => `/api${path}${TOKEN ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : ""}`;

const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function renderEvent(ev) {
  const box = $("#messages");
  // Live stream chunk: append to the streaming bubble (removed when the durable message lands).
  if (ev.type === "assistant/chunk") {
    let bubble = document.getElementById("streaming");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.id = "streaming";
      bubble.className = "msg assistant streaming";
      box.appendChild(bubble);
    }
    bubble.textContent += ev.data.delta;
    box.scrollTop = box.scrollHeight;
    return;
  }
  document.getElementById("streaming")?.remove();
  const div = document.createElement("div");
  if (ev.type === "user/message") { div.className = "msg user"; div.textContent = ev.data.text; }
  else if (ev.type === "assistant/message") {
    div.className = "msg assistant";
    div.innerHTML = esc(ev.data.text || "(tool call)") +
      (ev.data.toolCalls?.length ? `<div>${ev.data.toolCalls.map((t) => `🔧 ${t.name}(${JSON.stringify(t.args)})`).join("<br>")}</div>` : "") +
      (ev.data.usage ? `<div class="usage">tokens ${ev.data.usage.prompt_tokens ?? 0}↑/${ev.data.usage.completion_tokens ?? 0}↓</div>` : "");
    if (ev.data.usage) updateUsage();
  } else if (ev.type === "tool/result") { div.className = "msg tool"; div.textContent = `→ ${ev.data.name}: ${ev.data.output}`; }
  else if (ev.type === "system/message") { div.className = "msg system"; div.textContent = ev.data.text; }
  else if (ev.type === "compaction/summary") { div.className = "msg system"; div.textContent = `🗜 已压缩 ${ev.data.summarizedCount} 条早期消息：${ev.data.text.slice(0, 200)}…`; }
  else if (ev.type === "assistant/attempt") { div.className = "msg tool"; div.textContent = `⚠ ${ev.data.error}`; }
  else return; // turn/step markers are structural, not rendered
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function updateUsage() {
  if (!currentId) return;
  const s = await (await fetch(api(`/sessions/${currentId}`))).json();
  $("#usage-info").textContent = s.usage?.total ? `用量 ${s.usage.total} tokens（${s.usage.prompt}↑/${s.usage.completion}↓）` : "";
}

function openStream(id) {
  stream?.close();
  $("#messages").innerHTML = "";
  stream = new EventSource(api(`/sessions/${id}/stream`));
  stream.onmessage = (e) => renderEvent(JSON.parse(e.data));
}

async function refreshSessions() {
  const { sessions } = await (await fetch(api("/sessions"))).json();
  $("#session-list").innerHTML = sessions.map((s) => `<li data-id="${s.id}" class="${s.id === currentId ? "active" : ""}">${esc(s.title || s.id)}</li>`).join("");
  document.querySelectorAll("#session-list li").forEach((li) => li.onclick = () => selectSession(li.dataset.id));
}

async function selectSession(id) {
  currentId = id;
  await refreshSessions();
  openStream(id);
}

$("#new-session").onclick = async () => {
  const { id } = await (await fetch(api("/sessions"), { method: "POST" })).json();
  selectSession(id);
};

$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#input").value.trim();
  if (!text || !currentId) return;
  $("#input").value = "";
  $("#status").textContent = "运行中…";
  await fetch(api(`/sessions/${currentId}/turn`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, autoApprove: $("#approve").checked }),
  });
  $("#status").textContent = "";
};

$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); }
});

// --- Models settings (mirrors DSH ui-settings-models): key is write-only,
// the page only ever learns hasApiKey, never the secret value. ---
$("#open-settings").onclick = () => {
  const p = $("#settings-panel");
  p.hidden = !p.hidden;
  if (!p.hidden) loadSettings();
};
async function loadSettings() {
  const s = await (await fetch(api("/settings"))).json();
  $("#set-baseurl").value = s.baseUrl || "";
  $("#set-model").value = s.model || "";
  $("#set-apikey").value = "";
  $("#set-apikey").placeholder = s.hasApiKey ? "已保存（留空则不修改）" : "sk-...";
  $("#model-info").textContent = s.model ? `模型：${s.model}` : "";
}
$("#save-settings").onclick = async () => {
  const body = { baseUrl: $("#set-baseurl").value.trim(), model: $("#set-model").value.trim() };
  const key = $("#set-apikey").value.trim();
  if (key) body.apiKey = key;
  const r = await fetch(api("/settings"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const s = await r.json();
  $("#settings-status").textContent = r.ok ? `已保存${s.hasApiKey ? "（key 已配置）" : ""}` : `失败：${s.error}`;
  loadSettings();
};
$("#test-settings").onclick = async () => {
  $("#settings-status").textContent = "测试中…";
  const body = { baseUrl: $("#set-baseurl").value.trim() };
  const key = $("#set-apikey").value.trim();
  if (key) body.apiKey = key;
  const r = await (await fetch(api("/settings/test"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  $("#settings-status").textContent = r.ok ? `连接正常${r.models?.length ? `，可用模型 ${r.models.length}+` : ""}` : `失败：${r.error || r.status}`;
};

refreshSessions().then(async () => {
  const first = document.querySelector("#session-list li");
  if (first) selectSession(first.dataset.id);
  else $("#new-session").click();
});
