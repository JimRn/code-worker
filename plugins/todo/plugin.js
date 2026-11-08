import { registerTodoTools } from "../../src/todo.js";
export const plugin = { name: "todo", deps: ["tools", "sessions"], apply(ctx) {
  ctx.raw("sessions").registerEventType("todo/write");
  registerTodoTools(ctx);
} };
export default plugin;
