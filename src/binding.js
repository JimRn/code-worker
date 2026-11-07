// Binding validation (single home): project/agent/repo consistency.
// Used by the Web session-create route; the agents guard re-checks at runtime.
import { loadAgent } from "./agents.js";

/** @returns {{ok:true} | {ok:false, error:string}} */
export function validateBinding(projects, { projectId, agent } = {}) {
  if (!projectId) {
    if (agent) return { ok: false, error: "agent requires a project" };
    return { ok: true };
  }
  if (!projects?.get(projectId)) return { ok: false, error: "project not found" };
  if (agent && !loadAgent(projects, projectId, agent)) return { ok: false, error: "agent not found in project" };
  return { ok: true };
}
