import { installApprovalGuard } from "../../src/tools.js";
export const plugin = { name: "guard-approval", deps: ["tools"],
  configSchema: { properties: { guardedTools: true, timeoutMs: true } }, apply(ctx, env) {
  const pc = env.pluginConfig ?? {};
  installApprovalGuard(ctx, { autoApprove: env.approval, guarded: pc.guardedTools ?? env.guardedTools, timeoutMs: pc.timeoutMs ?? env.approvalTimeoutMs });
} };
export default plugin;
