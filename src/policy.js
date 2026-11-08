// Path policy: sensitive directory names blocked at every fs-adjacent seam
// (fs, skill resources, workspace selection). Single definition, no copies.
export const BLOCKED_DIRS = new Set([".ssh", ".aws", ".gnupg", ".dsh"]);

export function isInBlockedDir(absPath, sep) {
  return absPath.split(sep).some((seg) => BLOCKED_DIRS.has(seg));
}
