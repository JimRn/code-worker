// path-policy plugin: sensitive-directory policy as a ctx service + a
// tools/pre-execute guard (defense in depth behind the fs seam). The policy
// set itself stays data (src/policy.js); behavior lives here, config-able.
import { BLOCKED_DIRS } from "../../src/policy.js";
import { PolicyStore } from "../../src/policy-store.js";

export const plugin = {
  name: "path-policy",
  deps: ["tools?"],
  configSchema: { properties: { blockedDirs: true, guardedTools: true, blockedCommands: true } },
  apply(ctx, env) {
    const store = env.home ? new PolicyStore(env.home) : null;
    const stored = store?.get();
    const blocked = new Set(stored?.blockedDirs?.length ? stored.blockedDirs : (env.pluginConfig?.blockedDirs ?? BLOCKED_DIRS));
    const guarded = new Set(stored?.guardedTools?.length ? stored.guardedTools : (env.pluginConfig?.guardedTools ?? []));
    // Command patterns (regex per line), compiled once and refreshed live.
    const compiled = new Map(); // pattern string -> RegExp
    const compile = (pats) => { for (const p of pats) { if (!compiled.has(p)) { try { compiled.set(p, new RegExp(p)); } catch { /* invalid patterns are rejected at save time */ } } }
      for (const p of [...compiled.keys()]) if (!pats.includes(p)) compiled.delete(p); };
    compile(stored?.blockedCommands?.length ? stored.blockedCommands : (env.pluginConfig?.blockedCommands ?? []));
    const matchBlockedCommand = (cmd) => { for (const [pat, re] of compiled) if (re.test(cmd)) return pat; return null; };
    // Shell-word segmentation: a blocked dir hides inside words like
    // "cat .ssh/id_rsa" or "[.ssh]" — tokenize by separators and quotes.
    const words = (text) => String(text ?? "").replace(/["'`$(){}]/g, " ").split(/[\s;|&<>]+/).filter(Boolean);
    const isBlocked = (p) => words(p).some((w) => w.split(/[\/\0]/).some((seg) => blocked.has(seg)));
    // Live governance service: routes mutate these sets (persisted via store).
    ctx.provide("policies", {
      blocked, guarded, blockedCommands: () => [...compiled.keys()],
      setBlocked: (dirs) => { blocked.clear(); for (const d of dirs) blocked.add(d); },
      setGuarded: (tools) => { guarded.clear(); for (const t of tools) guarded.add(t); },
      setBlockedCommands: (pats) => compile(pats),
    });
    ctx.provide("pathPolicy", { blocked, isBlocked });
    // Tool-layer guard: scan string args for blocked path segments.
    // Execution indirection: running an existing script file whose content
    // matches a blocked command pattern is blocked too (`bash start.sh`).
    const scriptFileMatch = async (cmd) => {
      const fs = ctx.get("fs");
      if (!fs) return null;
      const tokens = String(cmd).split(/\s+/);
      for (const tok of tokens) {
        const clean = tok.replace(/^[\"']|[\"']$/g, "");
        if (!/\.(sh|py|pl|rb|js|mjs)$/i.test(clean)) continue;
        try {
          const abs = fs.resolve(clean);
          const { existsSync, readFileSync } = await import("node:fs");
          if (!existsSync(abs)) continue;
          const content = readFileSync(abs, "utf8");
          const pat = matchBlockedCommand(content);
          if (pat) return pat;
        } catch { /* non-workspace path or unreadable: fs seam already guards */ }
      }
      return null;
    };
    function* stringArgs(v, depth = 0) {
      if (depth > 4) return;
      if (typeof v === "string") yield v;
      else if (Array.isArray(v)) for (const x of v) yield* stringArgs(x, depth + 1);
      else if (v && typeof v === "object") for (const x of Object.values(v)) yield* stringArgs(x, depth + 1);
    };
    ctx.on("tools/pre-execute", async (req, next) => {
      // Argument-level governance (recursive): path segments, then command patterns.
      for (const v of stringArgs(req.args ?? {})) {
        if (isBlocked(v)) { req.denied = `path in sensitive directory: ${v}`; req.policy = "path-policy"; return next(req); }
      }
      for (const v of stringArgs(req.args ?? {})) {
        const pat = matchBlockedCommand(v);
        if (pat) { req.denied = `argument matches blocked pattern: ${pat}`; req.policy = "path-policy"; return next(req); }
      }
      const cmd = req.args?.command;
      if (typeof cmd === "string") {
        const pat = await scriptFileMatch(cmd);
        if (pat) { req.denied = `script file content matches blocked pattern: ${pat}`; req.policy = "path-policy"; return next(req); }
      }
      return next(req);
    }, "waterfall", { priority: 30 });
  },
};
export default plugin;
