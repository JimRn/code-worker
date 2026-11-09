import { registerTodoTools } from "../../src/todo.js";
export const plugin = { name: "todo", deps: ["tools", "sessions"], apply(ctx) {
  const store = ctx.require("sessions");
  store.registerEventType("todo/write");
  // Owned projection: latest todo/write snapshot.
  store.registerDerived("todos", (events) => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "todo/write") return events[i].data.todos;
    return [];
  });
  registerTodoTools(ctx);
} };
export default plugin;
