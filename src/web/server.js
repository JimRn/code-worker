// Web Host (mirrors DSH host/ + api/): Node http server serving static client
// and a session RPC/stream API. Routes are grouped in routes.js; this file
// owns only transport (static, auth, SSE, turn dispatch).
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { registerProjectRoutes, registerSettingsRoutes, registerWorkspaceRoutes, registerApprovalRoutes } from "./routes.js";

/** LAN IPv4 addresses of this host (for display; server binds all interfaces). */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/**
 * @param {{ctx: import('../context.js').Context, store: import('../session.js').SessionStore, approval: {current:boolean}}} deps
 * @returns {import('node:http').Server}
 */
export function createWebServer({ ctx, store, approval, token }) {
  const loop = ctx.require("agentLoop");
  const running = new Set(); // sessionIds with an in-flight turn
  const sseClients = new Map(); // sessionId -> Set<res> (approval notify is session-directed)
  // Per-call approval: guard suspends; we fan the request out to that session's browsers only.
  approval.notify = ({ callId, name, args, sessionId }) => {
    const frame = `data: ${JSON.stringify({ live: true, type: "approval/request", data: { callId, name, args, sessionId } })}\n\n`;
    for (const res of sseClients.get(sessionId) ?? []) { try { res.write(frame); } catch { /* client gone */ } }
  };

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 1e6) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error("invalid JSON body")); } });
  });

  // Route registry: groups register first, core dispatches by match.
  const routes = [];
  const app = {
    ctx, sendJson, readBody, approval,
    route(method, pattern, handler) {
      routes.push({ method, match: typeof pattern === "string" ? (p) => p === pattern : (p) => { const m = p.match(pattern); return m ? m : null; }, handler, isRegex: pattern instanceof RegExp });
    },
  };
  registerProjectRoutes(app);
  registerSettingsRoutes(app);
  registerWorkspaceRoutes(app);
  registerApprovalRoutes(app);

  // Optional LAN token auth: API requires ?token=, x-cw-token, or Authorization: Bearer.
  const authorized = (req, url) =>
    !token || req.headers["x-cw-token"] === token ||
    req.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token;

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/") && !authorized(req, url)) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized: token required (?token= / x-cw-token / Bearer)" }));
      }
      // --- static client (Host serves frontend-static) ---
      if (req.method === "GET" && (url.pathname === "/" || /\.(html|js|css)$/.test(url.pathname))) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const full = resolve(webDir, file);
        // Traversal whitelist: resolved path must stay inside webDir.
        if (full !== webDir && !full.startsWith(webDir + sep)) { res.writeHead(403); return res.end("forbidden"); }
        if (!existsSync(full)) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "content-type": MIME[file.match(/\.\w+$/)?.[0]] ?? "application/octet-stream" });
        return res.end(readFileSync(full));
      }
      // --- grouped routes ---
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.match(url.pathname);
        if (m) return r.handler(req, res, m === true ? null : m, url);
      }
      // --- session RPC + SSE + turn (core) ---
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const projectId = url.searchParams.get("projectId");
        const agentName = url.searchParams.get("agent");
        // Lightweight list: meta.json + tail title only, never full event load.
        return sendJson(res, 200, {
          sessions: store.listLight()
            .filter((s) => !projectId || s.projectId === projectId)
            .filter((s) => !agentName || s.agent === agentName),
        });
      }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        if (!body.projectId) return sendJson(res, 400, { error: "projectId is required (sessions must be project-scoped)" });
        if (!body.agent) return sendJson(res, 400, { error: "agent is required (every session must bind an agent)" });
        const binding = { projectId: body.projectId, repo: body.repo, agent: body.agent };
        const { validateBinding } = await import("../binding.js");
        const v = validateBinding(ctx.get("projects"), binding);
        if (!v.ok) return sendJson(res, 400, { error: v.error });
        const s = store.create(binding);
        return sendJson(res, 201, { id: s.id });
      }
      // trash: list/restore/purge per project
      const tm = url.pathname.match(/^\/api\/projects\/([\w-]+)\/trash(?:\/([\w-]+)\/(restore|purge))?$/);
      if (tm) {
        if (!tm[2] && req.method === "GET") return sendJson(res, 200, { trash: store.listTrash(tm[1]) });
        if (tm[3] === "restore" && req.method === "POST") {
          try { store.restore(tm[1], tm[2]); return sendJson(res, 200, { ok: true }); }
          catch (err) { return sendJson(res, 404, { error: err.message }); }
        }
        if (tm[3] === "purge" && req.method === "DELETE") {
          try {
            const { rmSync: rm } = await import("node:fs");
            const { join: j2 } = await import("node:path");
            rm(j2(store.projectsDir, tm[1], "trash", tm[2]), { recursive: true, force: true });
            return sendJson(res, 200, { ok: true });
          } catch (err) { return sendJson(res, 500, { error: err.message }); }
        }
      }
      const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)(\/(stream|turn|compact|export))?$/);
      if (m && req.method === "DELETE" && !m[2]) {
        try { store.softDelete(m[1]); return sendJson(res, 200, { ok: true }); }
        catch (err) { return sendJson(res, 404, { error: err.message }); }
      }
      if (m) {
        const session = store.open(m[1]);
        if (!m[2] && req.method === "GET") {
          return sendJson(res, 200, { id: session.id, title: session.title(), binding: session.binding, usage: session.usageTotals(), todos: session.todos(), events: session.events, messages: session.deriveMessages() });
        }
        if (m[3] === "export" && req.method === "GET") {
          res.writeHead(200, { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="session-${session.id}.jsonl"` });
          return res.end(session.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
        }
        if (m[3] === "stream" && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          for (const ev of session.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          const off = session.subscribe((ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } });
          if (!sseClients.has(session.id)) sseClients.set(session.id, new Set());
          sseClients.get(session.id).add(res);
          req.on("close", () => {
            off();
            sseClients.get(session.id)?.delete(res);
            // Disconnect: auto-deny only when NO tab remains for this session.
            if ((sseClients.get(session.id)?.size ?? 0) === 0) {
              for (const [callId, entry] of approval.pending ?? []) {
                if (entry.req.sessionId === session.id) entry.resolve(false);
              }
            }
          });
          return;
        }
        if (m[3] === "compact" && req.method === "POST") {
          try {
            const text = await ctx.require("compaction").compact(session);
            return sendJson(res, 200, { compacted: Boolean(text), summary: text ?? undefined });
          } catch (err) {
            return sendJson(res, 500, { error: err.message });
          }
        }
        if (m[3] === "turn" && req.method === "POST") {
          const body = await readBody(req);
          if (!body.text) return sendJson(res, 400, { error: "text is required" });
          if (running.has(session.id)) return sendJson(res, 409, { error: "turn already running" });
          // Per-turn scope: save/restore shared approval state around this turn.
          const prevApproval = { current: approval.current, mode: approval.mode };
          approval.current = Boolean(body.autoApprove);
          if (body.approvalMode) approval.mode = body.approvalMode;
          running.add(session.id);
          sendJson(res, 202, { accepted: true });
          loop.runTurn(session, body.text, { model: body.model })
            .catch((e) => console.error("[web] turn failed:", e.message))
            .finally(() => { running.delete(session.id); approval.current = prevApproval.current; approval.mode = prevApproval.mode; });
          return;
        }
      }
      res.writeHead(404); res.end("not found");
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else console.error("[web] handler error after headers sent:", err.message);
    }
  });
}

/** Start listening on all interfaces (LAN reachable); resolves with the bound address. */
export function startWebServer(deps, opts = {}) {
  if (typeof opts === "number") opts = { port: opts }; // backward-compat positional port
  const { port = 3000, host = "0.0.0.0" } = opts;
  const server = createWebServer(deps);
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
