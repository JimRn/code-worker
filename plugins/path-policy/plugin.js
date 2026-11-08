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
    const isBlocked = (p, sep = "/") => String(p ?? "").split(sep).some((seg) => blocked.has(seg));
    // Live governance service: routes mutate these sets (persisted via store).
    ctx.provide("policies", {
      blocked, guarded, blockedCommands: () => [...compiled.keys()],
      setBlocked: (dirs) => { blocked.clear(); for (const d of dirs) blocked.add(d); },
      setGuarded: (tools) => { guarded.clear(); for (const t of tools) guarded.add(t); },
      setBlockedCommands: (pats) => compile(pats),
    });
    ctx.provide("pathPolicy", { blocked, isBlocked });
    // Tool-layer guard: scan string args for blocked path segments.
    ctx.on("tools/pre-execute", async (req, next) => {
      // Argument-level governance: path segments first, then command patterns.
      for (const v of Object.values(req.args ?? {})) {
        if (typeof v === "string" && isBlocked(v)) { req.denied = `path in sensitive directory: ${v}`; req.policy = "path-policy"; return next(req); }
      }
      const cmd = req.args?.command;
      if (typeof cmd === "string") {
        const pat = matchBlockedCommand(cmd);
        if (pat) { req.denied = `command matches blocked pattern: ${pat}`; req.policy = "path-policy"; return next(req); }
      }
      return next(req);
    }, "waterfall", { priority: 30 });
  },
};
export default plugin;
