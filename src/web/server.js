// Web Host (mirrors DSH host/ + api/): Node http server serving static client
// and a session RPC/stream API. The browser client renders from session/event,
// exactly like DSH's Web Session-follow adapter consumes agent/assistant-stream.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/**
 * @param {{ctx: import('../context.js').Context, store: import('../session.js').SessionStore, approval: {current:boolean}}} deps
 * @returns {import('node:http').Server}
 */
export function createWebServer({ ctx, store, approval }) {
  const loop = ctx.require("agentLoop");
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

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      // --- static client (Host serves frontend-static) ---
      if (req.method === "GET" && (url.pathname === "/" || /\.(html|js|css)$/.test(url.pathname))) {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const full = join(webDir, file);
        if (!existsSync(full)) { res.writeHead(404); return res.end("not found"); }
        res.writeHead(200, { "content-type": MIME[url.pathname.match(/\.\w+$/)?.[0]] ?? "application/octet-stream" });
        return res.end(readFileSync(full));
      }
      // --- session RPC ---
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const { readdirSync } = await import("node:fs");
        const ids = existsSync(store.homeDir) ? readdirSync(store.homeDir) : [];
        return sendJson(res, 200, { sessions: ids.map((id) => ({ id })) });
      }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const s = store.create();
        return sendJson(res, 201, { id: s.id });
      }
      const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)(\/(events|stream|turn))?$/);
      if (m) {
        const session = store.open(m[1]);
        if (!m[2] && req.method === "GET") {
          return sendJson(res, 200, { id: session.id, events: session.events, messages: session.deriveMessages() });
        }
        if (m[3] === "stream" && req.method === "GET") {
          // SSE: replay history then stream session/event live.
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          for (const ev of session.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
          const off = session.subscribe((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
          req.on("close", off);
          return;
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

/** Start listening; resolves with the bound address. */
export function startWebServer(deps, port = 3000) {
  const server = createWebServer(deps);
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
