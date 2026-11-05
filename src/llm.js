// LLM seam: Definition (LlmService: prepareCall -> bound call) / Providers (DeepSeek, Mock)
// agent-loop only ever calls prepareCall(); it never imports a provider.
export class LlmService {
  constructor() { this.adapters = new Map(); }
  registerAdapter(name, adapter) {
    this.adapters.set(name, adapter);
    return () => this.adapters.delete(name);
  }
  /** Bind an adapter before any system/user commit (cancellation there commits nothing). */
  prepareCall({ provider = "deepseek", model, messages, tools = [] }) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Unknown LLM provider: ${provider}`);
    return adapter.prepareCall({ model, messages, tools });
  }
}

/** OpenAI-compatible chat completions (DeepSeek). Wire boundary: validate response here. */
export class DeepSeekAdapter {
  constructor({ apiKey, baseUrl = "https://api.deepseek.com", model = "deepseek-chat" } = {}) {
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required (set env or .env; see .env.example)");
    this.apiKey = apiKey; this.baseUrl = baseUrl.replace(/\/$/, ""); this.model = model;
  }
  prepareCall({ model, messages, tools }) {
    const m = model ?? this.model;
    return async () => {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: m, messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? "auto" : undefined }),
      });
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const json = await res.json();
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error("LLM response missing choices[0].message");
      return {
        text: msg.content ?? "",
        toolCalls: (msg.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments || "{}") })),
      };
    };
  }
}

/** Offline keyless provider for tests/demo: first step lists dir if asked, else echoes. */
export class MockAdapter {
  prepareCall({ messages }) {
    return async () => {
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const hasToolResult = messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        const toolMsg = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
        return { text: `Done. Tool output:\n${toolMsg}`, toolCalls: [] };
      }
      if (/list|ls|文件|目录/i.test(lastUser)) {
        return { text: "", toolCalls: [{ id: "mock-1", name: "list_dir", args: { path: "." } }] };
      }
      return { text: `[mock] You said: ${lastUser}`, toolCalls: [] };
    };
  }
}
