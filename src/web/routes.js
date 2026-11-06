// Route groups extracted from web/server.js (server slimming):
// projects, settings, workspace(+read/upload), approvals, export.
// Each handler receives shared deps and returns void; server wires them in order.
import { existsSync, readFileSync, writeFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
    sendJson(res, 200, { id: project.id, name: project.name, repos: project.repos, instructions: projects.instructions(m[1]) });
  });
  app.route("POST", /^\/api\/projects\/([\w-]+)\/repos$/, async (req, res, m) => {
    const body = await readBody(req);
    if (!projects().get(m[1])) return sendJson(res, 404, { error: "project not found" });
    sendJson(res, 201, { repo: projects().addRepo(m[1], body.name) });
  });
  app.route("GET", /^\/api\/projects\/([\w-]+)\/agents$/, async (req, res, m) => {
    if (!projects().get(m[1])) return sendJson(res, 404, { error: "project not found" });
    const { agentList } = await import("../agents.js");
    sendJson(res, 200, { agents: agentList(projects(), m[1]) });
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
  const BLOCKED = new Set([".ssh", ".aws", ".gnupg", ".dsh"]);
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
    if (abs.split(sep).some((seg) => BLOCKED.has(seg))) return sendJson(res, 403, { error: "workspace in a sensitive directory" });
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
