// Route groups extracted from web/server.js (server slimming):
// projects, settings, workspace(+read/upload), approvals, export.
// Each handler receives shared deps and returns void; server wires them in order.
import { existsSync, readFileSync, writeFileSync, realpathSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { isInBlockedDir } from "../policy.js";

export function registerProjectRoutes(app) {
  const { ctx, sendJson, readBody } = app;
  const projects = () => ctx.get("projects");
  app.route("GET", "/api/projects", async (req, res) => {
    sendJson(res, 200, { projects: projects().list().map(({ dir, ...p }) => p) });
  });
  app.route("POST", "/api/projects", async (req, res) => {
    const body = await readBody(req);
    try {
      const p = projects().create(body.name);
      sendJson(res, 201, { id: p.id, name: p.name, repos: p.repos });
    } catch (err) { sendJson(res, 400, { error: err.message }); }
  });
  app.route("GET", /^\/api\/projects\/([\w-]+)$/, async (req, res, m) => {
    const project = projects().get(m[1]);
    if (!project) return sendJson(res, 404, { error: "project not found" });
    sendJson(res, 200, { id: project.id, name: project.name, repos: project.repos, instructions: projects().instructions(m[1]) });
  });
  app.route("POST", /^\/api\/projects\/([\w-]+)\/repos$/, async (req, res, m) => {
    const body = await readBody(req);
    if (!projects().get(m[1])) return sendJson(res, 404, { error: "project not found" });
    const { homedir, tmpdir } = await import("node:os");
    if (body.importFrom) {
      // Import an existing local directory (allowlisted roots only, like workspace switch).
      const { existsSync, statSync, realpathSync } = await import("node:fs");
      const { resolve, sep } = await import("node:path");
      if (!existsSync(body.importFrom) || !statSync(body.importFrom).isDirectory()) return sendJson(res, 400, { error: "source is not a directory" });
      const abs = realpathSync(body.importFrom);
      const allowed = [projects().dir, homedir(), tmpdir()].some((r) => abs === r || abs.startsWith(r + sep));
      if (!allowed) return sendJson(res, 403, { error: "source outside allowed roots" });
      return sendJson(res, 201, { repo: projects().importRepo(m[1], abs) });
    }
    sendJson(res, 201, { repo: projects().addRepo(m[1], body.name) });
  });
  // --- terminals (Web UI: open/send/read over HTTP, long-poll style) ---
  app.route("POST", "/api/terminals", async (req, res) => {
    const body = await readBody(req);
    const id = await ctx.require("terminals").open(body.sessionId ?? "web", { cwd: body.cwd });
    sendJson(res, 201, { id });
  });
  app.route("POST", /^\/api\/terminals\/([\w-]+)\/send$/, async (req, res, m) => {
    const body = await readBody(req);
    try {
      const out = await ctx.require("terminals").send(m[1], body.sessionId ?? "web", body.command ?? "");
      sendJson(res, 200, { output: out });
    } catch (err) { sendJson(res, 404, { error: err.message }); }
  });
  app.route("GET", /^\/api\/terminals\/([\w-]+)$/, async (req, res, m) => {
    try {
      sendJson(res, 200, { output: ctx.require("terminals").read(m[1], url.searchParams.get("sessionId") ?? "web") });
    } catch (err) { sendJson(res, 404, { error: err.message }); }
  });
  app.route("GET", /^\/api\/projects\/([\w-]+)\/outputs$/, async (req, res, m) => {
    if (!projects().get(m[1])) return sendJson(res, 404, { error: "project not found" });
    const { listOutputs } = await import("../outputs.js");
    sendJson(res, 200, { outputs: listOutputs(projects(), m[1]) });
  });
  app.route("GET", /^\/api\/projects\/([\w-]+)\/agents$/, async (req, res, m) => {
    if (!projects().get(m[1])) return sendJson(res, 404, { error: "project not found" });
    const { agentList } = await import("../agents.js");
    sendJson(res, 200, { agents: agentList(projects(), m[1], ctx.get("fileCache")) });
  });
  app.route("POST", /^\/api\/projects\/([\w-]+)\/agents$/, async (req, res, m) => {
    const body = await readBody(req);
    try {
      const { createAgent } = await import("../agents.js");
      sendJson(res, 201, createAgent(projects(), m[1], body, ctx.get("fileCache")));
    } catch (err) { sendJson(res, 400, { error: err.message }); }
  });
  app.route("GET", /^\/api\/projects\/([\w-]+)\/agent-folders$/, async (req, res, m) => {
    const project = projects().get(m[1]);
    if (!project) return sendJson(res, 404, { error: "project not found" });
    const { readdirSync: rd, existsSync: ex } = await import("node:fs");
    const { join: j } = await import("node:path");
    const dir = j(project.dir, "agents");
    const folders = ex(dir) ? rd(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
    sendJson(res, 200, { folders });
  });
  app.route("DELETE", /^\/api\/projects\/([\w-]+)\/agents\/([\w.\-]+)$/, async (req, res, m) => {
    try {
      const { deleteAgent } = await import("../agents.js");
      deleteAgent(projects(), m[1], m[2]);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendJson(res, 404, { error: err.message }); }
  });
  app.route("GET", /^\/api\/projects\/([\w-]+)\/usage$/, async (req, res, m) => {
    if (!projects().get(m[1])) return sendJson(res, 404, { error: "project not found" });
    const { usageByAgent } = await import("../session-views.js");
    const store = app.ctx.require("sessions");
    const sessions = [];
    const { readdirSync: rd, statSync: st } = await import("node:fs");
    const { join: j } = await import("node:path");
    for (const id of rd(store.homeDir)) {
      try {
        const full = j(store.homeDir, id);
        if (!st(full).isDirectory()) continue;
        const s = store.open(id);
        if (s.binding?.projectId === m[1]) sessions.push(s);
      } catch { /* skip non-session dirs */ }
    }
    const byAgent = usageByAgent(sessions);
    const total = Object.values(byAgent).reduce((n, t) => ({ prompt: n.prompt + t.prompt, completion: n.completion + t.completion, total: n.total + t.total, cacheRead: n.cacheRead + t.cacheRead }), { prompt: 0, completion: 0, total: 0, cacheRead: 0 });
    sendJson(res, 200, { total, byAgent });
  });
  app.route("PUT", /^\/api\/projects\/([\w-]+)\/instructions$/, async (req, res, m) => {
    const project = projects().get(m[1]);
    if (!project) return sendJson(res, 404, { error: "project not found" });
    const body = await readBody(req);
    if (typeof body.text !== "string") return sendJson(res, 400, { error: "text is required" });
    writeFileSync(join(project.dir, "AGENTS.md"), body.text);
    sendJson(res, 200, { ok: true });
  });
}

export function registerSettingsRoutes(app) {
  const { ctx, sendJson, readBody } = app;
  const settings = () => ctx.get("settings");
  const modelConfig = () => ctx.get("modelConfig");
  app.route("GET", "/api/settings", async (req, res) => sendJson(res, 200, settings().describe()));
  app.route("PUT", "/api/settings", async (req, res) => {
    const body = await readBody(req);
    const view = settings().update(body);
    if (body.baseUrl !== undefined) modelConfig().baseUrl = body.baseUrl || undefined;
    if (body.model !== undefined) modelConfig().model = body.model || undefined;
    if (body.reasoningEffort !== undefined) modelConfig().reasoningEffort = body.reasoningEffort || undefined;
    if (body.contextWindow !== undefined) modelConfig().contextWindow = body.contextWindow ? Number(body.contextWindow) : undefined;
    if (body.apiKey) modelConfig().apiKey = body.apiKey;
    sendJson(res, 200, view);
  });
  app.route("POST", "/api/settings/test", async (req, res) => {
    const body = await readBody(req);
    const mc = modelConfig();
    const baseUrl = (body.baseUrl || mc.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    // SSRF guard: only ever call the CONFIGURED host.
    const storedHost = (() => { try { return new URL(mc.baseUrl || "https://api.openai.com/v1").host; } catch { return ""; } })();
    let reqHost = "";
    try { reqHost = new URL(baseUrl).host; } catch { return sendJson(res, 200, { ok: false, error: "invalid baseUrl" }); }
    if (reqHost !== storedHost) return sendJson(res, 200, { ok: false, error: "test endpoint restricted to the configured host" });
    const key = body.apiKey || mc.apiKey;
    if (!key) return sendJson(res, 400, { ok: false, error: "no API key configured" });
    try {
      const r = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
      const json = await r.json().catch(() => ({}));
      sendJson(res, 200, { ok: r.ok, status: r.status, models: (json.data?.map?.((m) => m.id) ?? []).slice(0, 20) });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    }
  });
}

export function registerWorkspaceRoutes(app) {
  const { ctx, sendJson, readBody } = app;
  const bootWorkspace = () => ctx.require("fs").root;
  app.route("GET", "/api/workspace/read", async (req, res, m, url) => {
    const projectId = url.searchParams.get("projectId");
    const sub = url.searchParams.get("path") || "";
    try {
      let content;
      if (projectId) {
        const dir = realpathSync(ctx.get("projects").get(projectId).dir);
        const abs = realpathSync(resolve(dir, sub));
        if (abs !== dir && !abs.startsWith(dir + sep)) return sendJson(res, 403, { error: "path escapes project repo" });
        if (statSync(abs).isDirectory()) return sendJson(res, 400, { error: "is a directory" });
        if (statSync(abs).size > 200 * 1024) return sendJson(res, 413, { error: "file too large (200KB)" });
        content = readFileSync(abs, "utf8");
      } else {
        content = await ctx.require("fs").readFile(sub);
        if (content.length > 200 * 1024) return sendJson(res, 413, { error: "file too large (200KB)" });
      }
      sendJson(res, 200, { path: sub, content });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
  app.route("GET", "/api/workspace", async (req, res, m, url) => {
    const fs = ctx.require("fs");
    const sub = url.searchParams.get("path") || ".";
    const projectId = url.searchParams.get("projectId");
    if (projectId) {
      try {
        const dir = realpathSync(ctx.get("projects").get(projectId).dir);
        const abs = realpathSync(resolve(dir, sub));
        if (abs !== dir && !abs.startsWith(dir + sep)) return sendJson(res, 403, { error: "path escapes project repo" });
        const entries = readdirSync(abs, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
        return sendJson(res, 200, { root: dir, path: sub, entries });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
    try {
      const entries = await fs.listEntries(sub);
      sendJson(res, 200, { root: fs.root, path: sub, entries });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
  app.route("PUT", "/api/workspace", async (req, res) => {
    const body = await readBody(req);
    if (!body.path) return sendJson(res, 400, { error: "path is required" });
    const fs = ctx.require("fs");
    const shell = ctx.require("shell");
    if (!existsSync(body.path) || !statSync(body.path).isDirectory()) return sendJson(res, 400, { error: "not a directory" });
    const abs = realpathSync(body.path);
    const { homedir, tmpdir } = await import("node:os");
    const allowed = [bootWorkspace(), homedir(), tmpdir()].some((r) => abs === r || abs.startsWith(r + sep));
    if (!allowed) return sendJson(res, 403, { error: "workspace outside allowed roots (boot workspace / home)" });
    if (isInBlockedDir(abs, sep)) return sendJson(res, 403, { error: "workspace in a sensitive directory" });
    fs.root = abs;
    shell.workspace = abs;
    ctx.get("settings").setWorkspace(abs);
    sendJson(res, 200, { root: abs });
  });
  app.route("POST", "/api/upload", async (req, res) => {
    const body = await readBody(req);
    if (!body.name || !body.content) return sendJson(res, 400, { error: "name and content (base64) required" });
    const buf = Buffer.from(body.content, "base64");
    if (buf.length > 5 * 1024 * 1024) return sendJson(res, 413, { error: "file too large (5MB)" });
    const safe = body.name.replace(/[^\w.\- ]/g, "_").slice(0, 100);
    await ctx.require("fs").writeFile(`uploads/${safe}`, buf.toString("utf8"));
    sendJson(res, 201, { path: `uploads/${safe}` });
  });
}

export function registerApprovalRoutes(app) {
  const { sendJson, readBody, approval } = app;
  app.route("POST", "/api/approvals", async (req, res) => {
    const body = await readBody(req);
    const entry = approval.pending?.get(body.callId);
    if (!entry) return sendJson(res, 404, { error: "no pending approval" });
    if (body.sessionId && entry.req.sessionId !== body.sessionId) return sendJson(res, 403, { error: "approval belongs to a different session" });
    entry.resolve(Boolean(body.approved));
    sendJson(res, 200, { ok: true });
  });
}

/** Session routes: CRUD + SSE stream + turn dispatch + trash. Transport
 * (static/auth/listen) stays in server.js; this group only declares API. */
export function registerSessionRoutes(app) {
  const { ctx, sendJson, readBody, approval, store, loop, running, sseClients } = app;

  app.route("GET", "/api/sessions", async (req, res, m, url) => {
    const projectId = url.searchParams.get("projectId");
    const agentName = url.searchParams.get("agent");
    return sendJson(res, 200, {
      sessions: store.listLight()
        .filter((s) => !projectId || s.projectId === projectId)
        .filter((s) => !agentName || s.agent === agentName),
    });
  });

  app.route("POST", "/api/sessions", async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    if (!body.projectId) return sendJson(res, 400, { error: "projectId is required (sessions must be project-scoped)" });
    if (!body.agent) return sendJson(res, 400, { error: "agent is required (every session must bind an agent)" });
    const binding = { projectId: body.projectId, repo: body.repo, agent: body.agent };
    const { validateBinding } = await import("../binding.js");
    const v = validateBinding(ctx.get("projects"), binding);
    if (!v.ok) return sendJson(res, 400, { error: v.error });
    const s = store.create(binding);
    return sendJson(res, 201, { id: s.id });
  });

  // trash: list/restore/purge per project
  app.route("GET", /^\/api\/projects\/([\w-]+)\/trash$/, async (req, res, m) => sendJson(res, 200, { trash: store.listTrash(m[1]) }));
  app.route("POST", /^\/api\/projects\/([\w-]+)\/trash\/([\w-]+)\/restore$/, async (req, res, m) => {
    try { store.restore(m[1], m[2]); return sendJson(res, 200, { ok: true }); }
    catch (err) { return sendJson(res, 404, { error: err.message }); }
  });
  app.route("DELETE", /^\/api\/projects\/([\w-]+)\/trash\/([\w-]+)\/purge$/, async (req, res, m) => {
    try {
      rmSync(join(store.projectsDir, m[1], "trash", m[2]), { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    } catch (err) { return sendJson(res, 500, { error: err.message }); }
  });

  app.route("DELETE", /^\/api\/sessions\/([\w-]+)$/, async (req, res, m) => {
    try { store.softDelete(m[1]); return sendJson(res, 200, { ok: true }); }
    catch (err) { return sendJson(res, 404, { error: err.message }); }
  });

  app.route("GET", /^\/api\/sessions\/([\w-]+)$/, async (req, res, m) => {
    const session = store.open(m[1]);
    return sendJson(res, 200, { id: session.id, title: session.title(), binding: session.binding, usage: session.usageTotals(), todos: session.todos(), events: session.events, messages: session.deriveMessages() });
  });

  app.route("GET", /^\/api\/sessions\/([\w-]+)\/export$/, async (req, res, m) => {
    const session = store.open(m[1]);
    res.writeHead(200, { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="session-${session.id}.jsonl"` });
    return res.end(session.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  app.route("GET", /^\/api\/sessions\/([\w-]+)\/stream$/, async (req, res, m) => {
    const session = store.open(m[1]);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    for (const ev of session.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const off = session.subscribe((ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } });
    if (!sseClients.has(session.id)) sseClients.set(session.id, new Set());
    sseClients.get(session.id).add(res);
    req.on("close", () => {
      off();
      sseClients.get(session.id)?.delete(res);
      if ((sseClients.get(session.id)?.size ?? 0) === 0) {
        for (const [callId, entry] of approval.pending ?? []) {
          if (entry.req.sessionId === session.id) entry.resolve(false);
        }
      }
    });
    return;
  });

  app.route("POST", /^\/api\/sessions\/([\w-]+)\/cancel$/, async (req, res, m) => sendJson(res, 200, { cancelled: await loop.cancel(m[1]) }));

  app.route("POST", /^\/api\/sessions\/([\w-]+)\/compact$/, async (req, res, m) => {
    try {
      const text = await ctx.require("compaction").compact(store.open(m[1]));
      return sendJson(res, 200, { compacted: Boolean(text), summary: text ?? undefined });
    } catch (err) { return sendJson(res, 500, { error: err.message }); }
  });

  app.route("POST", /^\/api\/sessions\/([\w-]+)\/turn$/, async (req, res, m) => {
    const session = store.open(m[1]);
    const body = await readBody(req);
    if (!body.text) return sendJson(res, 400, { error: "text is required" });
    if (running.has(session.id)) return sendJson(res, 409, { error: "turn already running" });
    // Per-session approval state (guard reads bySession by req.sessionId);
    // global approval stays the CLI fallback. Only provided fields override.
    approval.bySession ??= new Map();
    const prevApproval = approval.bySession.get(session.id) ?? null;
    const st = { current: prevApproval?.current ?? approval.current, mode: prevApproval?.mode ?? approval.mode };
    if (body.autoApprove !== undefined) st.current = Boolean(body.autoApprove);
    if (body.approvalMode) st.mode = body.approvalMode;
    approval.bySession.set(session.id, st);
    running.add(session.id);
    sendJson(res, 202, { accepted: true });
    loop.runTurn(session, body.text, { model: body.model })
      .catch((e) => console.error("[web] turn failed:", e.message))
      .finally(() => { running.delete(session.id); if (prevApproval) approval.bySession.set(session.id, prevApproval); else approval.bySession.delete(session.id); });
    return;
  });
}
