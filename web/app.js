// Browser client: renders the conversation from session/event stream (SSE),
// like DSH's Web Session-follow adapter. No framework, zero deps.
const $ = (s) => document.querySelector(s);
let currentId = null;
let stream = null;

const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function renderEvent(ev) {
  const box = $("#messages");
  const div = document.createElement("div");
  if (ev.type === "user/message") { div.className = "msg user"; div.textContent = ev.data.text; }
  else if (ev.type === "assistant/message") {
    div.className = "msg assistant";
    div.innerHTML = esc(ev.data.text || "(tool call)") +
      (ev.data.toolCalls?.length ? `<div>${ev.data.toolCalls.map((t) => `🔧 ${t.name}(${JSON.stringify(t.args)})`).join("<br>")}</div>` : "");
  } else if (ev.type === "tool/result") { div.className = "msg tool"; div.textContent = `→ ${ev.data.name}: ${ev.data.output}`; }
  else if (ev.type === "system/message") { div.className = "msg system"; div.textContent = ev.data.text; }
  else if (ev.type === "assistant/attempt") { div.className = "msg tool"; div.textContent = `⚠ ${ev.data.error}`; }
  else return; // turn/step markers are structural, not rendered
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function openStream(id) {
  stream?.close();
  $("#messages").innerHTML = "";
  stream = new EventSource(`/api/sessions/${id}/stream`);
  stream.onmessage = (e) => renderEvent(JSON.parse(e.data));
}

async function refreshSessions() {
  const { sessions } = await (await fetch("/api/sessions")).json();
  $("#session-list").innerHTML = sessions.map((s) => `<li data-id="${s.id}" class="${s.id === currentId ? "active" : ""}">${s.id}</li>`).join("");
  document.querySelectorAll("#session-list li").forEach((li) => li.onclick = () => selectSession(li.dataset.id));
}

async function selectSession(id) {
  currentId = id;
  await refreshSessions();
  openStream(id);
}

$("#new-session").onclick = async () => {
  const { id } = await (await fetch("/api/sessions", { method: "POST" })).json();
  selectSession(id);
};

$("#composer").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#input").value.trim();
  if (!text || !currentId) return;
  $("#input").value = "";
  $("#status").textContent = "运行中…";
  await fetch(`/api/sessions/${currentId}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, autoApprove: $("#approve").checked }),
  });
  $("#status").textContent = "";
};

$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); }
});

refreshSessions().then(async () => {
  const first = document.querySelector("#session-list li");
  if (first) selectSession(first.dataset.id);
  else $("#new-session").click();
});
