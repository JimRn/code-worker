import { installSkills } from "../../src/skills.js";
export const plugin = { name: "skills", deps: ["tools", "projects?", "fileCache?"], apply(ctx) {
  installSkills(ctx);
} };
export default plugin;
