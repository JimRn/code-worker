import { installProjectIsolation } from "../../src/features.js";
export const plugin = { name: "project-isolation", deps: ["fs", "shell", "projects"], apply(ctx) {
  installProjectIsolation(ctx);
} };
export default plugin;
