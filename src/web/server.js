// Web Host (mirrors DSH host/ + api/): Node http server serving static client
// and a session RPC/stream API. The browser client renders from session/event,
// exactly like DSH's Web Session-follow adapter consumes agent/assistant-stream.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces, homedir, tmpdir } from "node:os";

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
  const settings = ctx.get("settings");
  const modelConfig = ctx.get("modelConfig");
  const bootWorkspace = ctx.require("fs").root;
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
      // --- workspace: list + switch (fs seam root moves; tools follow) ---
      if (url.pathname === "/api/workspace" && req.method === "GET") {
        const fs = ctx.require("fs");
        const sub = url.searchParams.get("path") || ".";
        try {
          const entries = await fs.listEntries(sub);
          return sendJson(res, 200, { root: fs.root, path: sub, entries });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      if (url.pathname === "/api/workspace" && req.method === "PUT") {
        const body = await readBody(req);
        if (!body.path) return sendJson(res, 400, { error: "path is required" });
        const fs = ctx.require("fs");
        const shell = ctx.require("shell");
        const { resolve, sep } = await import("node:path");
        const { realpathSync, statSync } = await import("node:fs");
        if (!existsSync(body.path) || !statSync(body.path).isDirectory()) return sendJson(res, 400, { error: "not a directory" });
        // Canonicalize (defeats symlink escape) before the allowlist check.
        const abs = realpathSync(body.path);
        const allowed = [bootWorkspace, homedir(), tmpdir()].some((r) => abs === r || abs.startsWith(r + sep));
        if (!allowed) return sendJson(res, 403, { error: "workspace outside allowed roots (boot workspace / home)" });
        // Sensitive subdirectories are never workspace roots.
        const BLOCKED = new Set([".ssh", ".aws", ".gnupg", ".dsh"]);
        if (abs.split(sep).some((seg) => BLOCKED.has(seg))) return sendJson(res, 403, { error: "workspace in a sensitive directory" });
        fs.root = abs;
        shell.workspace = abs;
        settings.setWorkspace(abs);
        return sendJson(res, 200, { root: abs });
      }
      // --- per-call approvals ---
      if (url.pathname === "/api/approvals" && req.method === "POST") {
        const body = await readBody(req);
        const entry = approval.pending?.get(body.callId);
        if (!entry) return sendJson(res, 404, { error: "no pending approval" });
        if (body.sessionId && entry.req.sessionId !== body.sessionId) return sendJson(res, 403, { error: "approval belongs to a different session" });
        entry.resolve(Boolean(body.approved));
        return sendJson(res, 200, { ok: true });
      }
      // --- settings (redacted; API key write-only, never returned) ---
      if (url.pathname === "/api/settings" && req.method === "GET") {
        return sendJson(res, 200, settings.describe());
      }
      if (url.pathname === "/api/settings" && req.method === "PUT") {
        const body = await readBody(req);
        const view = settings.update(body);
        // Live-apply to the running adapter/loop without restart.
        if (body.baseUrl !== undefined) modelConfig.baseUrl = body.baseUrl || undefined;
        if (body.model !== undefined) modelConfig.model = body.model || undefined;
        if (body.apiKey) modelConfig.apiKey = body.apiKey;
        return sendJson(res, 200, view);
      }
      if (url.pathname === "/api/settings/test" && req.method === "POST") {
        const body = await readBody(req);
        const baseUrl = (body.baseUrl || modelConfig.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
        // SSRF guard: test only ever calls the CONFIGURED host. A body baseUrl
        // pointing elsewhere is rejected (no intranet probing, no key leak).
        const storedHost = (() => { try { return new URL(modelConfig.baseUrl || "https://api.openai.com/v1").host; } catch { return ""; } })();
        let reqHost = "";
        try { reqHost = new URL(baseUrl).host; } catch { return sendJson(res, 200, { ok: false, error: "invalid baseUrl" }); }
        if (reqHost !== storedHost) return sendJson(res, 200, { ok: false, error: "test endpoint restricted to the configured host" });
        const key = body.apiKey || modelConfig.apiKey;
        if (!key) return sendJson(res, 400, { ok: false, error: "no API key configured" });
        try {
          const r = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
          const json = await r.json().catch(() => ({}));
          const models = json.data?.map?.((m) => m.id) ?? [];
          return sendJson(res, 200, { ok: r.ok, status: r.status, models: models.slice(0, 20) });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: err.message });
        }
      }
      // --- session RPC ---
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const { readdirSync } = await import("node:fs");
        const { statSync } = await import("node:fs");
        const ids = existsSync(store.homeDir)
          ? readdirSync(store.homeDir).filter((id) => { try { return statSync(join(store.homeDir, id)).isDirectory(); } catch { return false; } })
          : [];
        return sendJson(res, 200, { sessions: ids.map((id) => { const s = store.open(id); return { id, title: s.title() }; }) });
      }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const s = store.create();
        return sendJson(res, 201, { id: s.id });
      }
      const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)(\/(events|stream|turn|compact))?$/);
      if (m) {
        const session = store.open(m[1]);
        if (!m[2] && req.method === "GET") {
          return sendJson(res, 200, { id: session.id, title: session.title(), usage: session.usageTotals(), todos: session.todos(), events: session.events, messages: session.deriveMessages() });
        }
        if (m[3] === "stream" && req.method === "GET") {
          // SSE: replay history then stream session/event live.
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          for (const ev of session.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          const off = session.subscribe((ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } });
          if (!sseClients.has(session.id)) sseClients.set(session.id, new Set());
          sseClients.get(session.id).add(res);
          req.on("close", () => {
            off();
            sseClients.get(session.id)?.delete(res);
            // Disconnect: auto-deny only when NO tab remains for this session
            // (one tab closing must not deny another tab's pending approval).
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
            const text = await loop.compact(session);
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
