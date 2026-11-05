# Code Worker — 个人 DeepSeek Harness

按 `docs/harness-design-summary.md` / `docs/harness-implementation-blueprint.md` 从 0 搭建的极简版 Cordis Harness：零依赖（仅 Node >=20 内置），对照原项目设计要点逐项落地。上游 DeepSeek 源码仅供参考，见 `../reference/deepseek-harness/`（只读，不要在此改代码）。

## 架构对照

| 原 DSH | 本项目 |
|---|---|
| Cordis `ctx` + `inject` + typed events | `src/context.js`：`Context{provide/get/require/on/emit/waterfall/serial/effect/dispose}`，waterfall 必须 `next()` |
| `core/session` append-only 日志 | `src/session.js`：`SessionStore/Session`，JSONL `session.v1.jsonl`，`deriveMessages()` 投影；Model-visible ⟺ Logged |
| `core/tools` 注册 + 安全管线 | `src/tools.js`：`ToolRegistry`，`tools/pre-execute→execute→post-execute` waterfall，结果 byte 界 |
| `llm/llm` 适配器缝 | `src/llm.js`：`LlmService.prepareCall`，Provider `DeepSeekAdapter`（OpenAI 兼容）+ `MockAdapter`（离线） |
| `core/agent-loop` turn/step | `src/agent-loop.js`：turn/start→pre-step→bind→commit→freeze→tools→step/end→turn/end；失败记 `assistant/attempt` |
| fs/shell 能力缝（三角色） | `src/fs.js`、`src/shell.js`：Definition/Provider/Consumer 分离；`ctx.fs`/`ctx.shell` + `tool-fs`/`tool-bash`；workspace confinement |
| guard 审批 | `src/tools.js:installApprovalGuard`：`write_file`/`bash` 经 executor 拒绝（非 schema 过滤） |
| profile + bundle 组合 | `profiles/personal.json` + `src/profile.js` 有序装配；入口 `src/cli.js`（类比 `dsh --profile personal`） |

## 运行

```sh
cp .env.example .env   # 填 OPENAI_API_KEY（任意 OpenAI-compatible 端点）
node src/cli.js --yes "帮我看看这个目录里有什么文件"
node src/cli.js --repl           # 交互循环，/exit 退出
node src/cli.js --session <id> "继续上次任务"
```

离线演示（无需 key）：

```sh
node src/cli.js --mock --yes "list files in workspace"
npm test   # node --test，覆盖 waterfall/可逆 effect/端到端日志/confinement/审批
```

## 配置

环境变量见 `.env.example`：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`（`DEEPSEEK_*` 作 fallback）、`CW_WORKSPACE`、`CW_AUTO_APPROVE`。CLI 参数：`--mock`（离线）、`--yes`（批准 write/bash）、`--workspace <dir>`、`--session <id>`、`--repl`、`--base-url <url>`、`--model <name>`、`--api-key <key>`。

## 扩展（按蓝图）

- 新工具：`ctx.tools.register({name,description,schema,execute})`，后端经 `ctx.fs`/`ctx.shell` 缝。
- 拦截：`ctx.on("agent/pre-step"|"tools/pre-execute", fn, "waterfall")`（必须 `next()`）。
- 新 Provider：`ctx.get("llm").registerAdapter(name, adapter)`，loop 不变。
- 会话：`.code-worker/sessions/<id>/session.v1.jsonl` 即完整可重放日志。

## 已知局限

无流式输出、无 compaction、无子代理/Web 检索、无 SQLite 检索；`bash` 在 workspace 目录执行本地 shell（个人使用，默认需 `--yes`）。
