import { installOutputs } from "../../src/outputs.js";
export const plugin = { name: "outputs", deps: ["tools", "projects?"], apply(ctx) {
  installOutputs(ctx);
} };
export default plugin;
