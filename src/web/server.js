// Web Host (mirrors DSH host/ + api/): Node http server serving static client
// and a session RPC/stream API. Routes are grouped in routes.js; this file
// owns only transport (static, auth, SSE, turn dispatch).
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { registerProjectRoutes, registerSettingsRoutes, registerWorkspaceRoutes, registerApprovalRoutes, registerSessionRoutes } from "./routes.js";

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
    ctx, sendJson, readBody, approval, store, loop, running, sseClients,
    route(method, pattern, handler) {
      routes.push({ method, match: typeof pattern === "string" ? (p) => p === pattern : (p) => { const m = p.match(pattern); return m ? m : null; }, handler, isRegex: pattern instanceof RegExp });
    },
  };
  registerProjectRoutes(app);
  registerSettingsRoutes(app);
  registerWorkspaceRoutes(app);
  registerApprovalRoutes(app);
  registerSessionRoutes(app);

  // Optional LAN token auth: API requires ?token=, x-cw-token, or Authorization: Bearer.
  const authorized = (req, url) =>
    !token || req.headers["x-cw-token"] === token ||
    req.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token;

  const server = createServer(async (req, res) => {
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
      res.writeHead(404); res.end("not found");
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else console.error("[web] handler error after headers sent:", err.message);
    }
  });
  // WebSocket upgrade: /api/terminals/:id/ws?token= (xterm.js <-> PTY).
  server.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const m = url.pathname.match(/^\/api\/terminals\/([\w-]+)\/ws$/);
      if (!m) { socket.destroy(); return; }
      if (!authorized(req, url)) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
      const { WebSocketServer } = await import("ws");
      const wss = new WebSocketServer({ noServer: true });
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
        const terminals = ctx.require("terminals");
        const owner = "web";
        const off = terminals.subscribe(m[1], owner, (d) => { if (ws.readyState === 1) ws.send(d); });
        ws.on("message", (msg) => {
          try {
            const { input, cols, rows } = JSON.parse(msg.toString());
            if (cols && rows) terminals.resize(m[1], owner, cols, rows);
            if (input) terminals.send(m[1], owner, input).catch(() => {});
          } catch { /* ignore */ }
        });
        ws.on("close", () => { off(); wss.close(); });
      });
    } catch { socket.destroy(); }
  });
  return server;
}

/** Start listening on all interfaces (LAN reachable); resolves with the bound address. */
export function startWebServer(deps, opts = {}) {
  if (typeof opts === "number") opts = { port: opts }; // backward-compat positional port
  const { port = 3000, host = "0.0.0.0" } = opts;
  const server = createWebServer(deps);
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
