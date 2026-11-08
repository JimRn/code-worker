// Todo (mirrors DSH todo/tool-todo): model-facing todo_write replaces the
// session's whole list; durable `todo/write` event is log-only (UI state,
// replayed from the log, never sent to the model as history).
const STATUSES = new Set(["pending", "in_progress", "completed"]);

/** Validate + normalize a whole-list write. */
export function validateTodos(todos) {
  if (!Array.isArray(todos)) throw new Error("todos must be an array");
  if (todos.length > 50) throw new Error("at most 50 todo items");
  return todos.map((t) => {
    if (!t?.content || typeof t.content !== "string") throw new Error("each todo needs a content string");
    const content = t.content.trim();
    if (!content) throw new Error("todo content must not be blank");
    if (content.length > 200) throw new Error(`todo content exceeds 200 chars: ${content.slice(0, 40)}…`);
    const status = t.status ?? "pending";
    if (!STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
    return { content, status };
  });
}

/** Narrow write capability factory: the ONLY way tools write todos.
 * Lives here (todo-owned) so core Session never knows the todo/write type. */
export function createTodoWriter(session) {
  return async (todos) => {
    const prev = session.todos();
    if (JSON.stringify(prev) === JSON.stringify(todos)) return false; // no-change: skip append
    await session.append("todo/write", { todos });
    return true;
  };
}

/** Consumer: registers the todo_write tool on ctx.tools + provides the writer factory. */
export function registerTodoTools(ctx) {
  const tools = ctx.require("tools");
  ctx.provide("todoWriter", createTodoWriter);
  ctx.effect(() => tools.register({
    name: "todo_write",
    description: "Replace the session todo list (whole-list snapshot). Call at task start and update statuses as you work.",
    schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content"],
          },
        },
      },
      required: ["todos"],
    },
    execute: async ({ todos }, req) => {
      const list = validateTodos(todos);
      if (!req.appendTodo) throw new Error("todo_write requires a session");
      const changed = await req.appendTodo(list);
      const done = list.filter((t) => t.status === "completed").length;
      return changed ? `todos updated: ${done}/${list.length} completed` : `todos unchanged: ${done}/${list.length} completed`;
    },
  }));
}
