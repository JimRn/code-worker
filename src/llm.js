import { DEFAULT_PROVIDER } from "./model-config.js";
// LLM seam: Definition (LlmService: prepareCall -> bound call) / Providers (DeepSeek, Mock)
// agent-loop only ever calls prepareCall(); it never imports a provider.
export class LlmService {
  constructor() { this.adapters = new Map(); }
  registerAdapter(name, adapter) {
    this.adapters.set(name, adapter);
    return () => this.adapters.delete(name);
  }
  /** Bind an adapter before any system/user commit (cancellation there commits nothing).
   * `signal` is forwarded so loop cancellation reaches the wire (fetch). */
  prepareCall({ provider = DEFAULT_PROVIDER, model, messages, tools = [], signal }) {
    // Config may rename the provider after registration (single-backend
    // profiles); fall back to the sole adapter instead of failing.
    const adapter = this.adapters.get(provider) ?? (this.adapters.size === 1 ? [...this.adapters.values()][0] : undefined);
    if (!adapter) throw new Error(`Unknown LLM provider: ${provider}`);
    return adapter.prepareCall({ model, messages, tools, signal });
  }
}

/**
 * OpenAI-compatible chat completions provider (works with OpenAI, DeepSeek,
 * and any OpenAI-compatible endpoint). Wire boundary: validate response here.
 * Env: OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL (DEEPSEEK_* kept as fallback).
 */
export class OpenAICompatibleAdapter {
  /**
   * @param {{apiKey?, baseUrl?, model?} | {config: {apiKey?, baseUrl?, model?}}} opts
   * When `config` (a mutable ref) is given, values are read at call time so
   * the Web settings page can change endpoint/key/model without restart.
   */
  constructor(opts = {}) {
    this.config = opts.config ?? opts;
    this.defaults = { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" };
  }
  resolve() {
    const c = this.config ?? {};
    const apiKey = c.apiKey;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required (configure in Web settings or env/.env; see .env.example)");
    return { apiKey, baseUrl: (c.baseUrl ?? this.defaults.baseUrl).replace(/\/$/, ""), model: c.model ?? this.defaults.model };
  }
  /**
   * Bound call = async generator (one provider attempt, always ends with finish):
   * yields {type:"text", delta} chunks, then {type:"finish", text, toolCalls}.
   */
  prepareCall({ model, messages, tools, signal }) {
    const { apiKey, baseUrl, model: cfgModel } = this.resolve();
    const m = model ?? cfgModel;
    const reasoningEffort = this.config?.reasoningEffort;
    const rawRetries = Number(this.config?.maxRetries ?? process.env.CW_LLM_RETRIES ?? 2);
    const maxRetries = Number.isFinite(rawRetries) ? Math.min(5, Math.max(0, Math.floor(rawRetries))) : 2;
    // Standardized ModelEvent stream: text_delta / reasoning_delta / tool_call_delta / usage / finish
    return async function* () {
      // Retry policy (429/5xx/network) BEFORE the stream starts; once chunks
      // flow, the attempt is committed and failures surface as attempt errors.
      let res;
      const retryable = (status) => status === 429 || status >= 500;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model: m, messages, stream: true, stream_options: { include_usage: true }, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}), tools: tools.length ? tools : undefined, tool_choice: tools.length ? "auto" : undefined }),
          });
        } catch (err) {
          if (attempt >= maxRetries) throw err;
          await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
          continue;
        }
        if (res.ok) break;
        // Some providers (e.g. Stealth) surface transient failures as 400 with
        // "Provider returned error" — retry those too; genuine 400s exhaust retries.
        const bodyText = (await res.text().catch(() => "")).slice(0, 1024);
        if (!retryable(res.status) && !(res.status === 400 && bodyText.includes("Provider returned error"))) {
          throw new Error(`LLM HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
        }
        // Provider-flavored 400s are flaky (esp. Stealth): allow extra retries.
        const limit = res.status === 400 ? Math.max(maxRetries, 4) : maxRetries;
        if (attempt >= limit) throw new Error(`LLM HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
      if (!res.ok) {
        const reqChars = JSON.stringify(messages).length;
        throw new Error(`LLM HTTP ${res.status} (req ~${reqChars} chars, ${messages.length} msgs): ${(await res.text()).slice(0, 500)}`);
      }
      let usage = null;
      let text = "";
      let reasoning = "";
      const tcByIndex = new Map();
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") break;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          if (json.usage) usage = json.usage;
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) { reasoning += delta.reasoning_content; yield { type: "reasoning_delta", text: delta.reasoning_content }; }
          if (delta.content) { text += delta.content; yield { type: "text_delta", text: delta.content }; }
          for (const [j, tc] of (delta.tool_calls ?? []).entries()) {
            // Providers that omit `index` would collide on key `undefined`; fall back to position.
            const key = tc.index ?? j;
            const cur = tcByIndex.get(key) ?? { id: `tc-${key}`, name: "", arguments: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            tcByIndex.set(key, cur);
          }
        }
      }
      // Some providers emit null-ish tool calls (name "None"/empty): drop them,
      // else they poison history and strict providers 400 on "missing field function".
      const toolCalls = [...tcByIndex.values()].filter((t) => t.name && t.name !== "None").map((t) => {
        let args;
        try { args = JSON.parse(t.arguments || "{}"); } catch { throw new Error(`invalid tool arguments JSON: ${t.arguments}`); }
        return { id: t.id, name: t.name, args };
      });
      yield { type: "finish", text, toolCalls, usage, reasoning: reasoning || undefined };
    };
  }
}

/** Backward-compat alias: DeepSeek is just an OpenAI-compatible endpoint. */
export class DeepSeekAdapter extends OpenAICompatibleAdapter {}

/** Offline keyless provider for tests/demo: first step lists dir if asked, else echoes. Streams like a real adapter. */
export class MockAdapter {
  prepareCall({ messages }) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const hasToolResult = messages.some((m) => m.role === "tool");
    let text, toolCalls = [];
    if (hasToolResult) {
      const toolMsg = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
      text = `Done. Tool output:\n${toolMsg}`;
    } else if (/todo|计划|任务/i.test(lastUser)) {
      text = "";
      toolCalls = [{
        id: "mock-todo",
        name: "todo_write",
        args: { todos: [{ content: "调研代码结构", status: "in_progress" }, { content: "实现功能", status: "pending" }, { content: "测试验证", status: "pending" }] },
      }];
    } else if (/list|ls|文件|目录/i.test(lastUser)) {
      text = "";
      toolCalls = [{ id: "mock-1", name: "list_dir", args: { path: "." } }];
    } else {
      text = `[mock] You said: ${lastUser}`;
    }
    return async function* () {
      for (let i = 0; i < text.length; i += 8) yield { type: "text_delta", text: text.slice(i, i + 8) };
      yield { type: "finish", text, toolCalls };
    };
  }
}
