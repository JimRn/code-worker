// Web Host (mirrors DSH host/ + api/): Node http server serving static client
// and a session RPC/stream API. The browser client renders from session/event,
// exactly like DSH's Web Session-follow adapter consumes agent/assistant-stream.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

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
  const running = new Set(); // sessionIds with an in-flight turn

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e6) reject(new Error("body too large")); });
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
        const full = join(webDir, file);
        if (!existsSync(full)) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "content-type": MIME[file.match(/\.\w+$/)?.[0]] ?? "application/octet-stream" });
        return res.end(readFileSync(full));
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
          return sendJson(res, 200, { id: session.id, title: session.title(), usage: session.usageTotals(), events: session.events, messages: session.deriveMessages() });
        }
        if (m[3] === "stream" && req.method === "GET") {
          // SSE: replay history then stream session/event live.
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          for (const ev of session.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          const off = session.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
          req.on("close", off);
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
          approval.current = Boolean(body.autoApprove);
          running.add(session.id);
          sendJson(res, 202, { accepted: true });
          loop.runTurn(session, body.text).catch((e) => console.error("[web] turn failed:", e.message)).finally(() => running.delete(session.id));
          return;
        }
      }
      res.writeHead(404); res.end("not found");
    } catch (err) {
      sendJson(res, 500, { error: err.message });
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
