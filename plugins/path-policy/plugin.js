// path-policy plugin: sensitive-directory policy as a ctx service + a
// tools/pre-execute guard (defense in depth behind the fs seam). The policy
// set itself stays data (src/policy.js); behavior lives here, config-able.
import { BLOCKED_DIRS } from "../../src/policy.js";

export const plugin = {
  name: "path-policy",
  deps: ["tools?"],
  configSchema: { properties: { blockedDirs: true } },
  apply(ctx, env) {
    const blocked = new Set(env.pluginConfig?.blockedDirs ?? BLOCKED_DIRS);
    const isBlocked = (p, sep = "/") => String(p ?? "").split(sep).some((seg) => blocked.has(seg));
    ctx.provide("pathPolicy", { blocked, isBlocked });
    // Tool-layer guard: scan string args for blocked path segments.
    ctx.on("tools/pre-execute", async (req, next) => {
      for (const v of Object.values(req.args ?? {})) {
        if (typeof v === "string" && isBlocked(v)) { req.denied = `path in sensitive directory: ${v}`; req.policy = "path-policy"; return next(req); }
      }
      return next(req);
    }, "waterfall", { priority: 30 });
  },
};
export default plugin;
