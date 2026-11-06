// Browser client: renders the conversation from session/event stream (SSE),
// like DSH's Web Session-follow adapter. No framework, zero deps.
import { mdToHtml, esc, escAttr } from "./md.js";

const $ = (s) => document.querySelector(s);
let currentId = null;
let stream = null;
// LAN token: ?token= in URL is persisted to localStorage and appended to API calls.
const TOKEN = new URLSearchParams(location.search).get("token") ?? localStorage.getItem("cw-token") ?? "";
if (TOKEN) localStorage.setItem("cw-token", TOKEN);
const api = (path) => `/api${path}${TOKEN ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : ""}`;

// Copy delegation (event delegation, survives re-renders). Finds the code in
// the SAME codeblock (page-wide monotonic data-block id), with fallback.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  const code = btn.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
  const done = () => { btn.textContent = "已复制"; setTimeout(() => (btn.textContent = "复制"), 1200); };
  try {
    await navigator.clipboard.writeText(code);
    done();
  } catch {
    const ta = document.createElement("textarea");
    ta.value = code;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  }
});

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
  // Live stream chunk: re-render markdown incrementally (removed when the durable message lands).
  if (ev.type === "assistant/chunk") {
    let bubble = document.getElementById("streaming");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.id = "streaming";
      bubble.className = "msg assistant streaming";
      box.appendChild(bubble);
      bubble._raw = "";
    }
    bubble._raw += ev.data.delta;
    bubble.innerHTML = mdToHtml(bubble._raw);
    box.scrollTop = box.scrollHeight;
    return;
  }
  document.getElementById("streaming")?.remove();
  const div = document.createElement("div");
  if (ev.type === "user/message") { div.className = "msg user"; div.textContent = ev.data.text; }
  else if (ev.type === "assistant/message") {
    div.className = "msg assistant";
    div.innerHTML = mdToHtml(ev.data.text || "") +
      (ev.data.toolCalls?.length ? `<div class="toolcalls">${ev.data.toolCalls.map((t) =>
        `<div class="toolcall"><div class="toolhead">🔧 ${esc(t.name)}</div><pre>${esc(JSON.stringify(t.args, null, 2))}</pre></div>`).join("")}</div>` : "") +
      (ev.data.usage ? `<div class="usage">tokens ${ev.data.usage.prompt_tokens ?? 0}↑/${ev.data.usage.completion_tokens ?? 0}↓</div>` : "");
    if (ev.data.usage) updateUsage();
  } else if (ev.type === "tool/result") {
    div.className = "msg tool";
    div.innerHTML = `<div class="toolhead">→ ${esc(ev.data.name)}${ev.data.isError ? " ⚠" : ""}</div><pre>${esc(ev.data.output)}</pre>`;
  }
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
  const pid = $("#project-picker").value;
  const { sessions } = await (await fetch(api(`/sessions${pid ? `?projectId=${encodeURIComponent(pid)}` : ""}`))).json();
  $("#session-list").innerHTML = sessions.map((s) => `<li data-id="${escAttr(s.id)}" class="${s.id === currentId ? "active" : ""}">${esc(s.title || s.id)}</li>`).join("");
  document.querySelectorAll("#session-list li").forEach((li) => li.onclick = () => selectSession(li.dataset.id));
  // If the current session is not in this project's list, switch to the first one.
  if (currentId && !sessions.some((s) => s.id === currentId)) {
    if (sessions[0]) selectSession(sessions[0].id);
    else { currentId = null; $("#messages").innerHTML = ""; }
  }
}

async function selectSession(id) {
  currentId = id;
  await refreshSessions();
  openStream(id);
  const snap = await (await fetch(api(`/sessions/${id}`))).json();
  renderTodos(snap.todos ?? []);
  updateUsage();
}

$("#plus").onclick = () => { $("#plus-menu").hidden = !$("#plus-menu").hidden; };
document.addEventListener("click", (e) => { if (!e.target.closest("#plus-wrap")) $("#plus-menu").hidden = true; });
$("#file-input").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  let bin = "";
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
  const r = await (await fetch(api("/upload"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: f.name, content: btoa(bin) }) })).json();
  $("#input").value += r.path ? `@${r.path} ` : "";
  $("#input").focus();
};
$("#plus-menu").querySelectorAll("button").forEach((b) => (b.onclick = async () => {
  $("#plus-menu").hidden = true;
  const act = b.dataset.act;
  if (act === "file") $("#file-input").click();
  else if (act === "compact" && currentId) {
    $("#status").textContent = "压缩中…";
    const r = await (await fetch(api(`/sessions/${currentId}/compact`), { method: "POST" })).json();
    $("#status").textContent = r.compacted ? "已压缩" : "无需压缩";
  }
  else if (act === "export" && currentId) location.href = api(`/sessions/${currentId}/export`);
  else if (act === "permission") $("#perm-picker").focus();
  else if (act === "model") $("#model-picker").focus();
  else if (act === "goal" || act === "plan" || act === "feedback") {
    const label = { goal: "目标", plan: "计划", feedback: "反馈" }[act];
    const text = prompt(`输入${label}内容（将作为消息发送）：`);
    if (text) { $("#input").value = `/${act} ${text}`; $("#composer").requestSubmit(); }
  }
}));
$("#perm-picker").onchange = (e) => {
  $("#approve").checked = e.target.value === "full";
  $("#per-call").checked = e.target.value === "per-call";
};

async function refreshProjects() {
  const { projects } = await (await fetch(api("/projects"))).json();
  $("#project-picker").innerHTML =
    `<option value="">（无 Project，全局 workspace）</option>` +
    projects.map((p) => `<option value="${escAttr(p.id)}">${esc(p.name)}（${p.repos.join(", ")}）</option>`).join("");
  refreshAgents();
  refreshRepos();
}
async function refreshRepos() {
  const pid = $("#project-picker").value;
  $("#repo-picker").innerHTML = `<option value="">（默认 Repo）</option>`;
  if (!pid) return;
  const p = await (await fetch(api(`/projects/${encodeURIComponent(pid)}`))).json();
  $("#repo-picker").innerHTML += (p.repos ?? []).map((r) => `<option value="${escAttr(r)}">${esc(r)}</option>`).join("");
}
$("#add-repo").onclick = async () => {
  const pid = $("#project-picker").value;
  if (!pid) return alert("先选 Project");
  const choice = prompt("仓库名（新建空目录），或填已有目录的绝对路径（导入）：", "new-repo");
  if (!choice) return;
  const body = choice.startsWith("/") ? { importFrom: choice } : { name: choice };
  await fetch(api(`/projects/${encodeURIComponent(pid)}/repos`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  refreshProjects();
};
async function refreshAgents() {
  const pid = $("#project-picker").value;
  $("#agent-picker").innerHTML = `<option value="">（默认 Agent）</option>`;
  if (!pid) return;
  const { agents } = await (await fetch(api(`/projects/${encodeURIComponent(pid)}/agents`))).json();
  $("#agent-picker").innerHTML += agents.map((a) => `<option value="${escAttr(a.name)}">${esc(a.name)}</option>`).join("");
}
$("#new-project").onclick = async () => {
  const name = prompt("Project 名称：");
  if (!name) return;
  await fetch(api("/projects"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  await refreshProjects();
  refreshSessions();
};
$("#project-picker").onchange = () => { wsPath = "."; refreshSessions(); refreshWorkspace(); refreshAgents(); };

$("#new-session").onclick = async () => {
  const projectId = $("#project-picker").value || undefined;
  const agent = $("#agent-picker").value || undefined;
  const repo = $("#repo-picker").value || undefined;
  const { id } = await (await fetch(api("/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, agent, repo }) })).json();
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
    body: JSON.stringify({ text, autoApprove: $("#perm-picker").value === "full", approvalMode: $("#perm-picker").value === "per-call" ? "per-call" : "auto", model: $("#model-picker").value || undefined }),
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

// --- File panel (DeepSeek-style right sidebar: tab + path + refresh + list) ---
let wsPath = ".";
$("#toggle-files").onclick = () => { $("#file-panel").hidden = !$("#file-panel").hidden; };
$("#fp-close").onclick = () => { $("#file-panel").hidden = true; };
$("#fp-refresh").onclick = () => refreshWorkspace();

async function refreshWorkspace() {
  const pid = $("#project-picker").value;
  const r = await (await fetch(api(`/workspace?path=${encodeURIComponent(wsPath)}${pid ? `&projectId=${encodeURIComponent(pid)}` : ""}`))).json();
  $("#ws-root").textContent = r.root || "";
  $("#fp-root").textContent = (r.root || "") + (wsPath === "." ? "" : "/" + wsPath);
  $("#ws-list").innerHTML = "";
  $("#fp-list").innerHTML =
    (wsPath !== "." ? `<li data-up="1">📁 ..</li>` : "") +
    (r.entries ?? []).map((e) => `<li data-name="${escAttr(e.name)}" class="${e.dir ? "dir" : ""}">${e.dir ? "📁" : "📄"} ${esc(e.name)}</li>`).join("");
  document.querySelectorAll("#fp-list li").forEach((li) => (li.onclick = async () => {
    if (li.dataset.up) wsPath = wsPath.split("/").slice(0, -1).join("/") || ".";
    else if (li.classList.contains("dir")) wsPath = wsPath === "." ? li.dataset.name : `${wsPath}/${li.dataset.name}`;
    else {
      // file: preview
      const p = wsPath === "." ? li.dataset.name : `${wsPath}/${li.dataset.name}`;
      const d = await (await fetch(api(`/workspace/read?path=${encodeURIComponent(p)}${pid ? `&projectId=${encodeURIComponent(pid)}` : ""}`))).json();
      const pre = $("#fp-preview");
      pre.hidden = false;
      pre.textContent = d.content ?? d.error ?? "";
      return;
    }
    $("#fp-preview").hidden = true;
    refreshWorkspace();
  }));
}

loadSettings?.();
refreshProjects();
refreshWorkspace();
refreshSessions().then(async () => {
  const first = document.querySelector("#session-list li");
  if (first) selectSession(first.dataset.id);
  else $("#new-session").click();
});
