# Code Worker — 个人 DeepSeek Harness

按 `docs/harness-design-summary.md` / `docs/harness-implementation-blueprint.md` 从 0 搭建的极简版 Cordis Harness：除 `node-pty`、`ws`（仅 terminals 插件与 WebSocket PTY 用）外零依赖（Node >=20 内置），对照原项目设计要点逐项落地。上游 DeepSeek 源码仅供参考，见 `../reference/deepseek-harness/`（只读，不要在此改代码）。

**一切皆插件**：`plugins/<name>/plugin.js` 自动发现，`profiles/personal.json` 的 `plugins` 数组即组合。删掉一行就是下掉对应能力（含 HTTP 路由）。

## 架构对照

| 原 DSH | 本项目 |
|---|---|
| Cordis `ctx` + `inject` + typed events | `src/context.js`：`Context{provide/get/require/on/emit/waterfall/serial/effect/dispose}`，waterfall 必须 `next()` |
| `core/session` append-only 日志 | `src/session.js`：JSONL `session.v1.jsonl`，`deriveMessages()` 投影；Model-visible ⟺ Logged |
| `core/tools` 注册 + 安全管线 | `src/tools.js`：`ToolRegistry`，`tools/pre-execute→execute→post-execute` waterfall，policy latch |
| `llm/llm` 适配器缝 | `src/llm.js`：`LlmService.prepareCall`（OpenAI 兼容流式）+ `MockAdapter`（离线） |
| `core/agent-loop` turn/step | `src/agent-loop.js`：turn/step 驱动、取消（`turn/cancelled`）、tool 配对保证 |
| fs/shell/terminal 能力缝 | `src/fs.js`、`src/shell.js`、`src/terminal.js`：Definition/Provider/Consumer 分离，workspace 隔离 |
| compaction | `plugins/compaction` + `src/compaction.js`：prune（免费）+ LLM 摘要（ durable `compaction/summary` 事件） |
| profile + bundle 组合 | `profiles/personal.json` + `src/plugin-loader.js`；CLI 透传 `--profile` |
| Todo（对话内渲染） | `plugins/todo`：`todo_write` 全量快照，渲染为对话内任务卡片 |
| AskUser 结构化提问 | `plugins/ask-user`：`ask_user` 工具挂起等答，Question 卡片提交同轮续跑 |
| Web Host + Client | `src/web/server.js`（传输）+ `src/web/routes.js`（路由组）+ `web/app.js` |

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
npm test   # node --test（56 个测试）
```

## 配置

环境变量见 `.env.example`（`OPENAI_*`/`DEEPSEEK_*`、工作区、审批、token）。网页「模型设置」里可改 endpoint/key/model/上下文窗口/计价单价，保存即 live 生效。

CLI 参数：`--mock`（离线）、`--yes`（批准 write/bash）、`--workspace <dir>`、`--session <id>`、`--repl`、`--web`、`--port`、`--host`、`--token`（未设且绑非 localhost 时随机生成）。

## 扩展（按蓝图）

- 新插件：`plugins/<name>/plugin.js`（导出 `{name, deps, provides?, serviceMethods?, configSchema?, apply}`），在 `profiles/personal.json` 加一行。
- 新工具：`ctx.tools.register({name, description, schema, execute})`，后端经 `ctx.fs`/`ctx.shell` 缝。
- 拦截：`ctx.on("agent/pre-step"|"tools/pre-execute", fn, "waterfall", {priority})`（必须 `next()`）。
- 新 LLM Provider：`ctx.get("llm").registerAdapter(name, adapter)`，loop 不变。
- 会话就是 `.code-worker/<id>/session.v1.jsonl`——即完整可重放日志。

## Web 界面

DeepSeek Web = Host（静态页 + RPC）+ Client（浏览器按 session 事件渲染）。本项目等价实现：

| DeepSeek | code-worker |
|---|---|
| `host/frontend-static` | `src/web/server.js` + `web/` |
| `api/session-controller` RPC | `/api/sessions[/:id][/turn][/cancel][/compact][/export]` |
| `session/event` 实时流 | `GET /api/sessions/:id/stream`（SSE：先回放历史（单次合并写）再推 live 事件） |
| 浏览器 shell 按事件渲染 | `web/app.js`（EventSource 渲染 user/assistant/tool 结果） |

```sh
node src/cli.js --web --mock --port 3100        # 离线演示
node src/cli.js --web --port 3000               # 真实端点（.env 配置）
# 浏览器打开 http://localhost:3000，侧栏管理会话并挑选权限
```

页面结构：**对话 / 轨迹 / 终端 / 文件 / 环境变量**；左下 composer 栏显示 Token 用量、费用、上下文用量；左侧栏可折叠。轨迹时间线最新在前，详情页含「监管」页签。

聊天能力：拖入/粘贴图片发大模型（Vision）、搜索历史、停止当前任务（■ 停止）、点击文件路径直达预览弹窗（md 渲染 / pdf 内嵌 / xlsx/docx/pptx 转换 / 下载 / 导出为 PDF）。

审批：发送时选「完全权限 / 需要审批 / 逐次审批」；审批卡片在对话内确认，监管 Block 带 policy 名。

## Policy（监管）

`🛡 Policy 配置`（侧栏）弹框编辑全局策略，保存即生效并落 `policies.json`：

| 规则 | 效果 |
|---|---|
| 敏感目录（blockedDirs） | 工具参数任何地方都不能出现 `.ssh` 等段 |
| 需审批（guardedTools） | write/bash/terminal 等工具走审批；terminal_* **不可关**（always guard） |
| 禁止命令（blockedCommands，正则） | 任意工具参数命中即 Block（含 write_file 内容、bash 脚本文件） |

被 Block 后本轮 latch 生效：换工具/改写法一样被拒，下一条用户消息才清。

## 上下文管理（compaction）

- **Prune**（每步自动、无模型成本）：旧工具结果超限截断，保留最近 `keepRecent` 条。
- **Summarize**：上下文估算超窗口时 LLM 摘要成耐久 `compaction/summary` 事件；投影保留摘要 + 其后事件（满足 model-visible ⟺ logged）。
- 手动触发：Web `POST /api/sessions/:id/compact`，或 REPL `/compact`。

## 安全边界

- `fs` 缝：工作区隔离 + 敏感目录拦截（policy 插件提供集合）；workspace 切换 allowlist
- `bash`/终端：审批门 + 仅可信 LAN，不要端口转发到公网；token 默认生成（`CW_TOKEN` 固定它）
- API key write-only（GET 只回 `hasApiKey`）；project env secrets（见下）永不进日志/提示词

## 项目环境变量

侧栏「环境变量」页签（文件后面）：按 project 存，**同 project 所有会话/Agent 共享**。
明文进 prompt 并在设置里可见；勾选「密码类型」的存为 `.env.secrets.json`（0600），列表只显示越权提示（🔒），值不回 API、不进日志；shell/终端执行时并入子进程 env。

## 安全/工程不变量

1. Model-visible ⟺ Logged（日志即事实源）
2. 插件只经 `ctx` 能力视图交换服务，`ctx.raw()` 仅 providers-only
3. 可逆注册：`ctx.effect` 在 `dispose` 回滚；terminal PTY 由插件清理
4. 发送/取消：取消即时生效（AbortSignal 全链路），Stop 按钮
5. 分页回放：SSE 哨兵 `replay/end` 后前端只渲染最新一页，点按钮往前翻

## 已知局限

- 无子代理 / Web 检索 / SQLite 检索
- `bash`/terminal 直跑本地 shell（个人使用，默认需审批；无沙箱）
- Xterm.js 由 CDN 加载（离线 LAN 需联网）
- 插件不算外部 patch 分发（仓库内插件，无独立发布/版本）
