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
const escAttr = (t) => esc(t).replace(/"/g, "&quot;");

function renderEvent(ev) {
  const box = $("#messages");
  // Per-call approval request (live-only).
  if (ev.type === "approval/request") {
    const card = document.createElement("div");
    card.className = "msg approval";
    card.innerHTML = `⚠ 审批：<b>${esc(ev.data.name)}</b>(${esc(JSON.stringify(ev.data.args))}) ` +
      `<button data-ok="1">批准</button> <button data-ok="0">拒绝</button>`;
    card.querySelectorAll("button").forEach((b) => (b.onclick = async () => {
      await fetch(api("/approvals"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: ev.data.callId, sessionId: ev.data.sessionId, approved: b.dataset.ok === "1" }) });
      card.remove();
    }));
    box.appendChild(card);
    box.scrollTop = box.scrollHeight;
    return;
  }
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
      (ev.data.toolCalls?.length ? `<div>${ev.data.toolCalls.map((t) => `🔧 ${esc(t.name)}(${esc(JSON.stringify(t.args))})`).join("<br>")}</div>` : "") +
      (ev.data.usage ? `<div class="usage">tokens ${ev.data.usage.prompt_tokens ?? 0}↑/${ev.data.usage.completion_tokens ?? 0}↓</div>` : "");
    if (ev.data.usage) updateUsage();
  } else if (ev.type === "tool/result") { div.className = "msg tool"; div.textContent = `→ ${ev.data.name}: ${ev.data.output}`; }
  else if (ev.type === "system/message") { div.className = "msg system"; div.textContent = ev.data.text; }
  else if (ev.type === "compaction/summary") { div.className = "msg system"; div.textContent = `🗜 已压缩 ${ev.data.summarizedCount} 条早期消息：${ev.data.text.slice(0, 200)}…`; }
  else if (ev.type === "todo/write") { renderTodos(ev.data.todos); return; }
  else if (ev.type === "assistant/attempt") { div.className = "msg tool"; div.textContent = `⚠ ${ev.data.error}`; }
  else return; // turn/step markers are structural, not rendered
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function renderTodos(todos) {
  $("#todos").hidden = !todos.length;
  const done = todos.filter((t) => t.status === "completed").length;
  $("#todo-progress").textContent = `${done}/${todos.length}`;
  $("#todo-list").innerHTML = todos.map((t) =>
    `<li class="${t.status}">${t.status === "completed" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜"} ${esc(t.content)}</li>`).join("");
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
  stream.onopen = () => { $("#conn").textContent = "● 已连接"; $("#conn").style.color = "#3fb950"; };
  stream.onerror = () => { $("#conn").textContent = "○ 连接中断，重试中…"; $("#conn").style.color = "#d29922"; };
  stream.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "turn/start") $("#status").textContent = "运行中…";
    if (ev.type === "turn/end") $("#status").textContent = "";
    renderEvent(ev);
  };
}

async function refreshSessions() {
  const { sessions } = await (await fetch(api("/sessions"))).json();
  $("#session-list").innerHTML = sessions.map((s) => `<li data-id="${escAttr(s.id)}" class="${s.id === currentId ? "active" : ""}">${esc(s.title || s.id)}</li>`).join("");
  document.querySelectorAll("#session-list li").forEach((li) => li.onclick = () => selectSession(li.dataset.id));
}

async function selectSession(id) {
  currentId = id;
  await refreshSessions();
  openStream(id);
  const snap = await (await fetch(api(`/sessions/${id}`))).json();
  renderTodos(snap.todos ?? []);
  updateUsage();
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
    body: JSON.stringify({ text, autoApprove: $("#approve").checked, approvalMode: $("#per-call").checked ? "per-call" : "auto", model: $("#model-picker").value || undefined }),
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
  refreshModelPicker(s.model);
}
async function refreshModelPicker(current) {
  const r = await (await fetch(api("/settings/test"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json().catch(() => ({}));
  const models = [...new Set([current, ...(r.models ?? [])].filter(Boolean))];
  $("#model-picker").innerHTML = models.map((m) => `<option value="${escAttr(m)}" ${m === current ? "selected" : ""}>${esc(m)}</option>`).join("");
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

// --- Workspace browser ---
let wsPath = ".";
async function refreshWorkspace() {
  const r = await (await fetch(api(`/workspace?path=${encodeURIComponent(wsPath)}`))).json();
  $("#ws-root").textContent = r.root || "";
  $("#ws-list").innerHTML =
    (wsPath !== "." ? `<li data-up="1">📁 ..</li>` : "") +
    (r.entries ?? []).map((e) => `<li data-name="${escAttr(e.name)}" class="${e.dir ? "dir" : ""}">${e.dir ? "📁" : "📄"} ${esc(e.name)}</li>`).join("");
  document.querySelectorAll("#ws-list li").forEach((li) => (li.onclick = () => {
    if (li.dataset.up) wsPath = wsPath.split("/").slice(0, -1).join("/") || ".";
    else if (li.classList.contains("dir")) wsPath = wsPath === "." ? li.dataset.name : `${wsPath}/${li.dataset.name}`;
    else return;
    refreshWorkspace();
  }));
}

loadSettings?.();
refreshWorkspace();
refreshSessions().then(async () => {
  const first = document.querySelector("#session-list li");
  if (first) selectSession(first.dataset.id);
  else $("#new-session").click();
});
