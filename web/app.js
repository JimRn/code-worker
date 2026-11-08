// Browser client: renders the conversation from session/event stream (SSE),
// like DSH's Web Session-follow adapter. No framework, zero deps.
import { mdToHtml, esc, escAttr } from "./md.js";

const $ = (s) => document.querySelector(s);
let currentId = null;
let stream = null;

// Custom modal (replaces native alert/confirm/prompt).
async function modal({ title, body, input, okText = "确定" }) {
  $("#modal-title").textContent = title;
  $("#modal-body").textContent = body ?? "";
  const inp = $("#modal-input");
  inp.hidden = !input;
  inp.value = input?.value ?? "";
  inp.placeholder = input?.placeholder ?? "";
  $("#modal-ok").textContent = okText;
  $("#modal").hidden = false;
  if (input) inp.focus();
  return new Promise((resolve) => {
    const done = (v) => {
      $("#modal").hidden = true;
      $("#modal-ok").onclick = $("#modal-cancel").onclick = null;
      resolve(v);
    };
    $("#modal-ok").onclick = () => done(input ? inp.value.trim() : "ok");
    $("#modal-cancel").onclick = () => done(null);
  });
}
const alertBox = (msg) => modal({ title: "提示", body: msg, okText: "知道了" });
// LAN token: ?token= in URL is persisted to localStorage and appended to API calls.
const TOKEN = new URLSearchParams(location.search).get("token") ?? localStorage.getItem("cw-token") ?? "";
if (TOKEN) localStorage.setItem("cw-token", TOKEN);
const api = (path) => `/api${path}${TOKEN ? `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : ""}`;

// Unified copy helper (clipboard API + execCommand fallback).
async function copyText(text, btn) {
  const done = () => { if (btn) { btn.textContent = "已复制"; setTimeout(() => (btn.textContent = "复制"), 1200); } };
  try { await navigator.clipboard.writeText(text); done(); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  }
}
// Copy delegation (event delegation, survives re-renders). Finds the code in
// the SAME codeblock (page-wide monotonic data-block id), with fallback.
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".copy");
  if (!btn) return;
  copyText(btn.closest(".codeblock")?.querySelector("code")?.textContent ?? "", btn);
});

let currentTurn = null; // {el, startTs, tools: Map<callId, blockEl>}
function closeTurn(ts) {
  if (!currentTurn) return;
  const secs = Math.max(1, Math.round((ts - currentTurn.startTs) / 1000));
  // Status header created at close time, at the END of the turn (below user
  // message + tools + reply), never above the user's own message.
  const head = document.createElement("button");
  head.className = "turn-head";
  head.innerHTML = `<span class="turn-label">已完成，用时 ${secs} 秒</span> <span class="chev">⌃</span>`;
  const turnEl = currentTurn.el;
  head.onclick = () => turnEl.classList.toggle("collapsed");
  turnEl.appendChild(head); // group root, outside turn-body: collapsing never hides the toggle
  // finalize tool group label (drop the running suffix)
  turnEl.querySelectorAll(".tg-label").forEach((el) => { el.textContent = el.textContent.replace(" · 工作中", ""); });
  currentTurn.el.classList.add("done");
  currentTurn = null;
}

function renderEvent(ev) {
  const box = $("#messages");
  // Turn grouping: tool/reasoning blocks collapse under a turn header.
  if (ev.type === "turn/start") {
    const turn = document.createElement("div");
    turn.className = "turn-group";
    turn.innerHTML = `<div class="turn-body"></div>`;
    box.appendChild(turn);
    currentTurn = { el: turn, startTs: ev.ts, tools: new Map() };
    // Move the thinking indicator inside this turn (after the user message below).
    const thinking = document.getElementById("thinking");
    if (thinking) turn.querySelector(".turn-body").appendChild(thinking);
    return;
  }
  if (ev.type === "turn/end") {
    hideThinking();
    sending = false;
    // Any tool block still without output means the turn died mid-tool: mark it.
    currentTurn?.el.querySelectorAll(".tool-block").forEach((b) => {
      if (!b.querySelector(".tb-out").textContent) b.querySelector(".tb-out").textContent = "(未完成：轮次中断)";
      b.classList.add("collapsed", "done");
    });
    closeTurn(ev.ts);
    return;
  }
  if (ev.type === "tool/call") {
    const host = currentTurn ? currentTurn.el.querySelector(".turn-body") : box;
    // Summary group: "使用了 N 个 Shell、读取、编辑 ▾" folds the whole turn's tools.
    let group = host.querySelector(".tool-group");
    if (!group) {
      group = document.createElement("div");
      group.className = "tool-group collapsed"; // folded by default during conversation too
      group.innerHTML = `<button class="tg-head"><span class="tg-label"></span> <span class="chev">⌃</span></button><div class="tg-body"></div>`;
      group.querySelector(".tg-head").onclick = () => group.classList.toggle("collapsed");
      host.appendChild(group);
      group._kinds = new Map();
    }
    const kind = { bash: "Shell", read_file: "读取", write_file: "编辑", list_dir: "读取", todo_write: "任务", skill_load: "技能", report_write: "报告" }[ev.data.name] ?? ev.data.name;
    group._kinds.set(kind, (group._kinds.get(kind) ?? 0) + 1);
    const total = [...group._kinds.values()].reduce((a, b) => a + b, 0);
    group.querySelector(".tg-label").textContent = `使用了 ${total} 个 ${[...group._kinds.keys()].join("、")}${currentTurn ? " · 工作中" : ""}`;
    const block = document.createElement("div");
    block.className = "tool-block collapsed"; // collapsed by default, even mid-turn
    const summary = ev.data.args?.command ?? ev.data.args?.path ?? ev.data.args?.title ?? ev.data.name ?? {};
    block.innerHTML = `<button class="tb-head">⌃ ${esc(kind)} <code>${esc(String(summary).slice(0, 80))}</code></button><div class="tb-body"><div class="tb-cmd"><span class="dot"></span> code-worker <code>${esc(JSON.stringify(ev.data.args))}</code><button class="copy tb-copy">复制</button></div><pre class="tb-out"></pre></div>`;
    block.querySelector(".tb-head").onclick = () => block.classList.toggle("collapsed");
    block.querySelector(".tb-copy").onclick = (e) => copyText(JSON.stringify(ev.data.args), e.target);
    group.querySelector(".tg-body").appendChild(block);
    currentTurn?.tools.set(ev.data.callId, block);
    return;
  }
  if (ev.type === "tool/result") {
    const block = currentTurn?.tools.get(ev.data.callId);
    if (block) {
      block.querySelector(".tb-out").textContent = ev.data.output;
      if (ev.data.isError) block.classList.add("error");
      return;
    }
    // fallback: standalone result
    const div = document.createElement("div");
    div.className = "msg tool";
    div.innerHTML = `<div class="toolhead">→ ${esc(ev.data.name)}${ev.data.isError ? " ⚠" : ""}</div><pre>${esc(ev.data.output)}</pre>`;
    box.appendChild(div);
    return;
  }
  if (ev.type === "assistant/reasoning") {
    // Per-turn reasoning bubble (no global id singleton: no cross-turn steal).
    let bubble = currentTurn?.el.querySelector(".msg.reasoning");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "msg reasoning";
      bubble.innerHTML = `<button class="tb-head">⌃ 思考过程</button><div class="tb-body"><pre></pre></div>`;
      bubble.querySelector(".tb-head").onclick = () => bubble.classList.toggle("collapsed");
      (currentTurn ? currentTurn.el.querySelector(".turn-body") : box).appendChild(bubble);
      bubble._raw = "";
    }
    bubble._raw += ev.data.delta;
    bubble.querySelector("pre").textContent = bubble._raw;
    box.scrollTop = box.scrollHeight;
    return;
  }
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
    hideThinking();
    // Inside the current turn group (visual grouping closes on fold).
    let bubble = currentTurn?.el.querySelector(".streaming");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "msg assistant streaming";
      (currentTurn ? currentTurn.el.querySelector(".turn-body") : box).appendChild(bubble);
      bubble._raw = "";
    }
    bubble._raw += ev.data.delta;
    bubble.innerHTML = mdToHtml(bubble._raw);
    box.scrollTop = box.scrollHeight;
    return;
  }
  currentTurn?.el.querySelectorAll(".msg.reasoning, .streaming").forEach((el) => el.remove());
  const div = document.createElement("div");
  if (ev.type === "user/message") {
    div.className = "msg user";
    div.innerHTML = `${mdToHtml(ev.data.text)}<div class="msg-meta"><time>${new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><button class="copy" title="复制">⧉</button></div>`;
    div.querySelector(".copy").onclick = (e) => copyText(ev.data.text, e.target);
    // User message heads its turn group, before the thinking indicator.
    const body = currentTurn ? currentTurn.el.querySelector(".turn-body") : box;
    body.insertBefore(div, document.getElementById("thinking"));
    box.scrollTop = box.scrollHeight;
    return;
  }
  else if (ev.type === "assistant/message") {
    // Tool-only steps have no visible text: tools already render as blocks.
    if (!ev.data.text && !ev.data.reasoning) { if (ev.data.usage) updateUsage(); return; }
    div.className = "msg assistant";
    div.innerHTML =
      (ev.data.reasoning ? `<div class="reasoning-done"><button class="tb-head">⌃ 思考过程</button><div class="tb-body"><pre>${esc(ev.data.reasoning)}</pre></div></div>` : "") +
      mdToHtml(ev.data.text || "") +
      (ev.data.usage ? `<div class="usage">tokens ${ev.data.usage.prompt_tokens ?? 0}↑/${ev.data.usage.completion_tokens ?? 0}↓${ev.data.usage.prompt_tokens_details?.cached_tokens ? `（缓存 ${ev.data.usage.prompt_tokens_details.cached_tokens}）` : ""}</div>` : "");
    div.querySelectorAll(".tb-head").forEach((b) => (b.onclick = () => b.parentElement.classList.toggle("collapsed")));
    if (ev.data.usage) updateUsage();
    (currentTurn ? currentTurn.el.querySelector(".turn-body") : box).appendChild(div);
    box.scrollTop = box.scrollHeight;
    return;
  }
  else if (ev.type === "system/message") { return; } // model-only: never render in chat
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
  currentTurn = null;
  stream = new EventSource(api(`/sessions/${id}/stream`));
  stream.onopen = () => { $("#conn").textContent = "● 已连接"; $("#conn").style.color = "#3fb950"; };
  stream.onerror = () => {
    $("#conn").textContent = "○ 连接中断，重试中…"; $("#conn").style.color = "#d29922";
    // Disconnect mid-turn: clear stuck thinking/lock (replay on reconnect resyncs).
    hideThinking();
    sending = false;
  };
  stream.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "turn/start") $("#status").textContent = "运行中…";
    if (ev.type === "turn/end") $("#status").textContent = "";
    renderEvent(ev);
  };
}

async function refreshSessions() {
  const pid = $("#project-picker").value;
  const ag = $("#agent-picker").value;
  const params = new URLSearchParams();
  if (pid) params.set("projectId", pid);
  if (ag) params.set("agent", ag);
  const { sessions } = await (await fetch(api(`/sessions${params.toString() ? `?${params}` : ""}`))).json();
  $("#session-list").innerHTML = sessions.map((s) =>
    `<li data-id="${escAttr(s.id)}" class="${s.id === currentId ? "active" : ""}"><span class="sl-title">${esc(s.title || s.id)}</span><button class="sl-del" title="删除（移入回收站）">✕</button></li>`).join("");
  document.querySelectorAll("#session-list li").forEach((li) => (li.onclick = (e) => {
    if (e.target.classList.contains("sl-del")) return;
    selectSession(li.dataset.id);
  }));
  document.querySelectorAll(".sl-del").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const id = b.closest("li").dataset.id;
    if (!(await modal({ title: "删除会话", body: `删除会话 ${id}？将移入回收站（可恢复），不是彻底删除。`, okText: "删除" }))) return;
    await fetch(api(`/sessions/${id}`), { method: "DELETE" });
    if (currentId === id) { currentId = null; stream?.close(); $("#messages").innerHTML = ""; }
    refreshSessions();
    refreshTrash();
  }));
  // If the current session is not in this project's list, switch to the first one.
  if (currentId && !sessions.some((s) => s.id === currentId)) {
    if (sessions[0]) selectSession(sessions[0].id);
    else { currentId = null; stream?.close(); stream = null; $("#messages").innerHTML = ""; }
  }
}

async function selectSession(id) {
  currentId = id;
  sending = false; // switching sessions releases any stuck send lock
  hideThinking();
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
    const text = await modal({ title: label, body: `输入${label}内容（将作为消息发送）：`, input: {} });
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
    projects.map((p) => `<option value="${escAttr(p.id)}">${esc(p.name)}</option>`).join("") +
    `<option value="__new__">+ 新建 Project…</option>`;
  refreshAgents();
  $("#new-session").disabled = !$("#project-picker").value || $("#project-picker").value === "__new__";
  refreshSessions();
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
  if (!pid) return alertBox("先选 Project");
  const choice = await modal({ title: "添加仓库", body: "仓库名（新建空目录），或填已有目录的绝对路径（导入）：", input: { placeholder: "new-repo" } });
  if (!choice) return;
  const body = choice.startsWith("/") ? { importFrom: choice } : { name: choice };
  await fetch(api(`/projects/${encodeURIComponent(pid)}/repos`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  refreshProjects();
};
async function refreshTrash() {
  const pid = $("#project-picker").value;
  $("#trash-list").innerHTML = "";
  if (!pid) return;
  const { trash } = await (await fetch(api(`/projects/${encodeURIComponent(pid)}/trash`))).json();
  $("#trash-list").innerHTML = trash.map((t) =>
    `<li>${esc(t.title || t.id)} <button data-restore="${escAttr(t.id)}" title="恢复">恢复</button><button data-purge="${escAttr(t.id)}" title="彻底删除">彻底删除</button></li>`).join("");
  document.querySelectorAll("[data-restore]").forEach((b) => (b.onclick = async () => {
    await fetch(api(`/projects/${encodeURIComponent(pid)}/trash/${encodeURIComponent(b.dataset.restore)}/restore`), { method: "POST" });
    refreshTrash(); refreshSessions();
  }));
  document.querySelectorAll("[data-purge]").forEach((b) => (b.onclick = async () => {
    if (!(await modal({ title: "彻底删除", body: `彻底删除 ${b.dataset.purge}？不可恢复。`, okText: "彻底删除" }))) return;
    await fetch(api(`/projects/${encodeURIComponent(pid)}/trash/${encodeURIComponent(b.dataset.purge)}/purge`), { method: "DELETE" });
    refreshTrash();
  }));
}
$("#refresh-trash").onclick = () => refreshTrash();

async function refreshAgents() {
  const pid = $("#project-picker").value;
  $("#agent-picker").innerHTML = `<option value="">（默认 Agent）</option>`;
  if (!pid) return;
  const { agents } = await (await fetch(api(`/projects/${encodeURIComponent(pid)}/agents`))).json();
  $("#agent-picker").innerHTML += agents.map((a) => `<option value="${escAttr(a.name)}">${esc(a.name)} · ${esc(a.description)}</option>`).join("") +
    `<option value="__new__">+ 新建 Agent…</option>`;
  refreshUsage();
}
async function refreshUsage() {
  const pid = $("#project-picker").value;
  if (!pid) { $("#usage-chip").textContent = ""; return; }
  const u = await (await fetch(api(`/projects/${encodeURIComponent(pid)}/usage`))).json();
  $("#usage-chip").textContent = u.total?.total ? `用量 ${u.total.total}` : "";
  $("#usage-detail").innerHTML =
    `<div class="ud-total"><span>总计</span><b>${u.total?.total ?? 0} tokens</b></div>` +
    (Object.entries(u.byAgent ?? {}).map(([n, t]) =>
      `<div class="ud-row"><span>${esc(n)}</span><span>${t.total} tokens</span><span>${t.prompt}↑/${t.completion}↓</span><span>缓存命中 ${t.hitRate}%</span><span>${t.turns} 轮</span></div>`).join("") ||
    `<div class="status">暂无用量数据</div>`);
}
$("#new-agent").onclick = async () => {
  $("#agent-dialog").hidden = !$("#agent-dialog").hidden;
  if (!$("#agent-dialog").hidden) {
    const pid = $("#project-picker").value;
    $("#ag-folder").innerHTML = `<option value="">（新建文件夹）</option>`;
    if (pid) {
      const { folders } = await (await fetch(api(`/projects/${encodeURIComponent(pid)}/agent-folders`))).json();
      $("#ag-folder").innerHTML += folders.map((f) => `<option>${escAttr(f)}</option>`).join("");
    }
    $("#ag-name").value = "";
  }
};
$("#ag-folder").onchange = async () => {
  const name = $("#ag-folder").value;
  if (!name) return;
  $("#ag-name").value = name;
  // Prefill from existing AGENTS.md if present.
  const pid = $("#project-picker").value;
  const { agents } = await (await fetch(api(`/projects/${encodeURIComponent(pid)}/agents`))).json();
  const found = agents.find((a) => a.name === name);
  if (found) { $("#ag-desc").value = found.description; $("#ag-body").value = ""; }
};
$("#cancel-agent").onclick = () => { $("#agent-dialog").hidden = true; };
$("#save-agent").onclick = async () => {
  const pid = $("#project-picker").value;
  if (!pid) return alertBox("先选 Project");
  const tools = [...document.querySelectorAll(".tools-checks input:checked")].map((i) => i.value);
  const r = await fetch(api(`/projects/${encodeURIComponent(pid)}/agents`), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: $("#ag-name").value, description: $("#ag-desc").value, body: $("#ag-body").value, tools }),
  });
  const d = await r.json();
  if (!r.ok) return alertBox(d.error);
  $("#agent-dialog").hidden = true;
  refreshAgents();
};
$("#del-agent").onclick = async () => {
  const pid = $("#project-picker").value;
  const name = $("#agent-picker").value;
  if (!pid || !name) return alertBox("先选 Project 和 Agent");
  if (!(await modal({ title: "删除 Agent", body: `删除 Agent 定义 ${name}？（历史会话不受影响）`, okText: "删除" }))) return;
  await fetch(api(`/projects/${encodeURIComponent(pid)}/agents/${encodeURIComponent(name)}`), { method: "DELETE" });
  refreshAgents();
};
$("#new-project").onclick = async () => {
  const name = await modal({ title: "新建 Project", body: "Project 名称：", input: {} });
  if (!name) return;
  await fetch(api("/projects"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
  await refreshProjects();
  refreshSessions();
};
$("#project-picker").onchange = async () => {
  if ($("#project-picker").value === "__new__") {
    const sel = $("#project-picker");
    sel.disabled = false;
    const prev = sel.options[0]?.value ?? "";
    sel.value = prev; // restore before prompting; cancel keeps the previous project
    $("#new-project").click();
    return;
  }
  wsPath = ".";
  refreshSessions(); refreshWorkspace(); refreshAgents(); refreshTrash();
};
$("#agent-picker").onchange = () => {
  if ($("#agent-picker").value === "__new__") {
    $("#agent-picker").value = "default"; // restore; cancel keeps previous selection
    $("#new-agent").click();
    return;
  }
  $("#new-session").disabled = !$("#project-picker").value;
  refreshSessions();
};

$("#new-session").onclick = async () => {
  if (!$("#project-picker").value) { alertBox("先选择 Project（会话必须属于某个 Project）"); return; }
  const projectId = $("#project-picker").value || undefined;
  const agent = $("#agent-picker").value || "default"; // default agent is a valid binding
  $("#agent-picker").value = agent;
  const repo = $("#repo-picker").value || undefined;
  const { id } = await (await fetch(api("/sessions"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId, agent, repo }) })).json();
  selectSession(id);
};

let sending = false;
$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#input").value.trim();
  if (!text || !currentId || sending) return; // double-Enter / rapid sends ignored
  sending = true;
  $("#input").value = "";
  // Acknowledge immediately: thinking indicator in the chat (user bubble
  // arrives right after via SSE turn/start + user/message).
  showThinking();
  $("#status").textContent = "运行中…";
  setTimeout(() => { sending = false; }, 10000); // failsafe release (turns usually finish sooner)
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
  $("#set-reasoning").value = s.reasoningEffort || "";
  $("#set-context").value = s.contextWindow || "";
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
  const body = { baseUrl: $("#set-baseurl").value.trim(), model: $("#set-model").value.trim(), reasoningEffort: $("#set-reasoning").value, contextWindow: $("#set-context").value.trim() };
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
// --- Web terminal: xterm.js + WebSocket to PTY (PuTTY-like) ---
let termWs = null, termXterm = null, termFit = null;
let termId = null;
function termOpenWs() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${location.host}/api/terminals/${encodeURIComponent(termId)}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
  termWs = new WebSocket(wsUrl);
  termWs.onmessage = (e) => termXterm.write(e.data);
  // Closed sockets clear the handle so reopening the panel reconnects to the
  // SAME PTY (no orphan PTY + lost scrollback from a fresh POST).
  termWs.onclose = () => { termWs = null; };
}
async function termConnect() {
  if (typeof Terminal === "undefined" || typeof FitAddon === "undefined") {
    $("#xterm-holder").textContent = "xterm.js failed to load (CDN unreachable?). Check network and refresh.";
    return;
  }
  if (!termId) {
    const r = await (await fetch(api("/terminals"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    termId = r.id;
    termXterm = new Terminal({ cursorBlink: true, scrollback: 5000, theme: { background: "#0d1117" } });
    termXterm.open($("#xterm-holder"));
    termFit = new FitAddon.FitAddon();
    termXterm.loadAddon(termFit);
    termFit.fit();
    termXterm.onData((d) => { if (termWs?.readyState === 1) termWs.send(JSON.stringify({ input: d })); });
    termXterm.onResize(({ cols, rows }) => { if (termWs?.readyState === 1) termWs.send(JSON.stringify({ cols, rows })); });
    window.addEventListener("resize", () => { if (viewMode === "terminal" && termFit) termFit.fit(); });
  }
  termOpenWs();
}
// Terminal button only shows when the terminals plugin is loaded.
(async () => {
  const s = await (await fetch(api("/settings"))).json().catch(() => ({}));
  if (!s.capabilities?.terminal) $("#tab-terminal").style.display = "none";
})();

$("#usage-chip").onclick = () => {
  $("#usage-panel-right").hidden = !$("#usage-panel-right").hidden;
  if (!$("#usage-panel-right").hidden) { $("#file-panel").hidden = true; $("#trash-panel").hidden = true; refreshUsage(); }
};
$("#up-close").onclick = () => { $("#usage-panel-right").hidden = true; };
$("#toggle-trash").onclick = () => {
  $("#trash-panel").hidden = !$("#trash-panel").hidden;
  if (!$("#trash-panel").hidden) { $("#file-panel").hidden = true; refreshTrash(); }
};
$("#tp-close").onclick = () => { $("#trash-panel").hidden = true; };

// Thinking indicator: shown the moment a message is sent, removed when the
// first assistant content (or turn end) arrives.
function showThinking() {
  hideThinking(); // singleton: rapid sends never stack indicators
  const box = $("#messages");
  const t = document.createElement("div");
  t.id = "thinking";
  t.className = "msg assistant thinking";
  t.innerHTML = `<span class="dots"><span>.</span><span>.</span><span>.</span></span> 正在思考…`;
  box.appendChild(t);
  box.scrollTop = box.scrollHeight;
  t._failsafe = setTimeout(hideThinking, 90000); // never stick forever
}
function hideThinking() {
  const el = document.getElementById("thinking");
  if (el) { clearTimeout(el._failsafe); el.remove(); }
}

// --- Trace view (DeepSeek-style): timeline + compact rows + detail panel ---
let viewMode = "chat";
document.querySelectorAll("#view-tabs button").forEach((b) => (b.onclick = () => {
  viewMode = b.dataset.view;
  document.querySelectorAll("#view-tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $("#trace-view").hidden = viewMode !== "trace";
  $("#terminal-view").hidden = viewMode !== "terminal";
  $("#messages").style.display = viewMode === "chat" ? "" : "none";
  $("#composer").style.display = viewMode === "terminal" ? "none" : "";
  if (viewMode === "trace") renderTrace();
  if (viewMode === "terminal") {
    if (!termWs) termConnect();
    requestAnimationFrame(() => { termFit?.fit(); });
  }
}));

const BADGE = { "user/message": ["用户", "user"], "assistant/message": ["助手", "assistant"], "tool/call": ["工具", "tool"], "tool/result": ["工具", "tool"], "system/message": ["上下文", "system"] };

async function renderTrace() {
  if (!currentId) return;
  const snap = await (await fetch(api(`/sessions/${currentId}`))).json();
  const events = snap.events ?? [];
  const q = ($("#trace-search").value || "").toLowerCase();
  // timeline: proportional lanes from timestamps
  const ts = events.map((e) => e.ts).filter(Boolean);
  const t0 = Math.min(...ts, 0), t1 = Math.max(...ts, 1), span = Math.max(1, t1 - t0);
  const lane = (types) => events.filter((e) => types.includes(e.type)).map((e) =>
    `<span class="tl" style="left:${((e.ts - t0) / span * 100).toFixed(1)}%"></span>`).join("");
  $("#timeline").innerHTML =
    `<div class="tl-row"><span>输入</span><div class="tl-track">${lane(["user/message"])}</div></div>` +
    `<div class="tl-row"><span>模型</span><div class="tl-track">${lane(["assistant/message", "assistant/attempt"])}</div></div>` +
    `<div class="tl-row"><span>工具</span><div class="tl-track">${lane(["tool/call", "tool/result"])}</div></div>`;
  // compact rows
  const rows = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const badge = BADGE[ev.type];
    if (!badge) continue;
    let summary = "";
    if (ev.type === "user/message") summary = ev.data.text;
    else if (ev.type === "assistant/message") summary = ev.data.text || "（仅工具调用）";
    else if (ev.type === "tool/call") summary = `${ev.data.name} ${JSON.stringify(ev.data.args)}`;
    else if (ev.type === "tool/result") summary = `${ev.data.name ?? "tool"} → ${String(ev.data.output).slice(0, 80)}`;
    else if (ev.type === "system/message") summary = ev.data.text;
    if (q && !summary.toLowerCase().includes(q)) continue;
    rows.push(`<div class="trace-row" data-i="${i}"><span class="badge ${badge[1]}">${badge[0]}</span><span class="tr-summary">${esc(summary)}</span></div>`);
  }
  $("#trace-list").innerHTML = rows.join("");
  document.querySelectorAll(".trace-row").forEach((el) => (el.onclick = () => showTraceDetail(events[+el.dataset.i], events)));
}

function showTraceDetail(ev, events) {
  $("#trace-detail").hidden = false;
  $("#td-title").textContent = ev.type === "tool/call" || ev.type === "tool/result" ? `${ev.data.name ?? "tool"}` : ev.type;
  const result = ev.type === "tool/call" ? events.find((e, j) => j > events.indexOf(ev) && e.type === "tool/result" && e.data.callId === ev.data.callId) : null;
  const dur = result ? result.ts - ev.ts : null;
  const tabs = {
    overview: `<div class="td-kv"><span>层级</span><b>${ev.type === "tool/call" ? "工具调用" : ev.type}</b></div><div class="td-kv"><span>状态</span><b>${result ? (result.data.isError ? "失败" : "已完成") : "—"}</b></div>`,
    args: `<pre>${esc(JSON.stringify(ev.data.args ?? {}, null, 2))}</pre>`,
    result: `<pre>${esc(result ? String(result.data.output) : "（无结果）")}</pre>`,
    schema: `<b>${esc(ev.data.name ?? "")}</b><pre>${esc(ev.data.name === "bash" ? "Execute a bash command: runs in the workspace cwd." : ev.data.name === "read_file" ? "Read a UTF-8 file inside the workspace." : ev.data.name === "write_file" ? "Write a UTF-8 file inside the workspace." : ev.data.name === "list_dir" ? "List a directory inside the workspace." : "Tool schema")}
</pre>`,
    timing: `<div class="td-kv"><span>开始时间</span><b>${new Date(ev.ts).toISOString()}</b></div><div class="td-kv"><span>时长</span><b>${dur != null ? `${dur} 毫秒` : "—"}</b></div>`,
  };
  $("#td-body").innerHTML = tabs.overview;
  document.querySelectorAll(".td-tabs button").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".td-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $("#td-body").innerHTML = tabs[b.dataset.t];
  }));
}
$("#td-close").onclick = () => { $("#trace-detail").hidden = true; };
$("#trace-search").oninput = () => renderTrace();
$("#open-files").onclick = (e) => { e.preventDefault(); $("#file-panel").hidden = false; };
$("#fp-close").onclick = () => { $("#file-panel").hidden = true; };
$("#fp-refresh").onclick = () => refreshWorkspace();

async function refreshWorkspace() {
  const pid = $("#project-picker").value;
  const r = await (await fetch(api(`/workspace?path=${encodeURIComponent(wsPath)}${pid ? `&projectId=${encodeURIComponent(pid)}` : ""}`))).json();
  $("#ws-root").textContent = r.root || "";
  $("#fp-root").textContent = (r.root || "") + (wsPath === "." ? "" : "/" + wsPath);
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
refreshWorkspace();
refreshProjects().then(async () => {
  await refreshSessions();
  const first = document.querySelector("#session-list li");
  if (first) selectSession(first.dataset.id);
  else $("#new-session").click();
});
