# 模块说明

> 行数统计基于 2026-11-06 现状（`wc -l src/**/*.js web/*`），仅供规模参考。

## 核心运行时（`src/`）

| 文件（行数） | 对应上游 DSH | 关键导出 | 职责 |
|---|---|---|---|
| `context.js`（71） | Cordis `ctx` + `inject` | `Context{provide/get/require/on/emit/waterfall/serial/effect/dispose}` | 服务注册表 + 类型化事件。三种模式：`emit`（观察）/ `waterfall`（环绕，必须 `next()`）/ `serial`（有序，无 `next`）。`effect` 注册可逆副作用，`dispose` 时回滚。 |
| `session.js`（118） | `core/session` | `SessionStore / Session`、`deriveMessages()`、`todos()`、`usageTotals()`、`title()`、`writeTodos()`、`subscribe` 广播 | append-only JSONL 日志（`session.v1.jsonl`），唯一事实源；会话目录含 `meta.json`（`{projectId, repo}` binding）。不变量 **Model-visible ⟺ Logged**；同一 id 单例缓存（保证 SSE 订阅者看到追加）；compaction 摘要投影；`todo/write`、标题、用量等从日志派生。 |
| `agent-loop.js`（118） | `core/agent-loop` | `AgentLoop.runTurn()`、`compact()`、`inject()` | Turn = 0..N Step；Step = 1 次模型请求 + 其工具调用。**每轮开始**：① 项目隔离（把 `fs.root`/`shell.workspace` 指向绑定项目的 repo 目录，轮后恢复）；② 每轮实时读取项目 `AGENTS.md` 追加进 system prompt（`## Project instructions (AGENTS.md)` 段，经 `system-prompt/assemble` waterfall）；③ 装配 system prompt、执行 compaction、流式调用、工具管线。LLM 失败记 `assistant/attempt` 后结束本轮。 |
| `llm.js`（140） | `llm/llm` | `LlmService`、`OpenAICompatibleAdapter`、`DeepSeekAdapter`、`MockAdapter` | 适配器缝：loop 只调 `prepareCall()`，不感知 Provider。绑定调用返回 async generator：`{type:"text",delta}` chunk → `{type:"finish",text,toolCalls,usage}`。配置经可变 ref 读取，Web 设置页改端点/key/model 无需重启。Mock 对 todo/计划/任务关键词会触发 `todo_write`（离线演示）。 |
| `tools.js`（75） | `core/tools` | `ToolRegistry`、`installApprovalGuard()` | 注册表 + 守卫执行管线：`tools/pre-execute → tools/execute → tools/post-execute`（waterfall），结果按 `maxBytes` 截断；工具只拿到窄能力 `appendTodo`，不给整个 Session。审批守卫对 `write_file`/`bash` 生效（auto 批准 / per-call 挂起等 Web 裁决，超时默认 30s 拒绝）。 |
| `fs.js`（54） | fs 能力缝 | `FsService`(定义) / `LocalFs`(实现) / `registerFsTools` | 工具：`read_file` / `write_file`（需审批）/ `list_dir`。`LocalFs.resolve` 做 workspace confinement（symlink canonicalize 后校验）+ 敏感目录 `.ssh/.aws/.gnupg/.dsh` 全局拦截。 |
| `shell.js`（37） | shell 能力缝 | `ShellService` / `LocalShell` / `registerBashTool` | 工具：`bash`（需审批）。`execFile` 参数化执行（非字符串拼接），默认超时 30s，在 workspace 目录执行。 |
| `todo.js`（52） | `todo/tool-todo` | `registerTodoTools` | 工具：`todo_write`——整体快照替换清单（上限 50 条，content ≤200 字符，status ∈ pending/in_progress/completed），落 `todo/write` 事件（log-only UI 状态，不进模型历史）；无变化跳过写盘。 |
| `projects.js`（73）🆕 | —（P1 自研） | `ProjectStore` | 项目管理：`<projectsDir>/<id>/{project.json, AGENTS.md, docs/, skills/, agents/, outputs/, repos/<repo>/}`，默认 `~/.code-worker/projects`（`CW_PROJECTS_DIR` 可改）。`create/list/get/addRepo/repoDir/instructions`；创建自动建 `AGENTS.md` 模板 + `main` repo。 |
| `compaction.js`（35） | `compaction-basic` + `tool-result-pruner` | `pruneToolResults / estimateChars / summarizeMessages` | 两段式：① 每步免费剪枝旧工具结果（保留最近 `keepRecent` 条，头尾 + `[pruned]`）；② 估算字符超 `maxContextChars`（默认 60000）时 LLM 摘要旧轮次为一条耐久 `compaction/summary` 事件，投影只保留摘要之后。 |
| `profile.js`（60） | profile + bundle | `bootProfile()` | 按 `profiles/personal.json` 有序装配插件树，所有注册走可逆 effect。解析顺序：sessions → tools → fs/tool-fs → shell/tool-bash → todo → projects → settings/modelConfig → llm → agentLoop → guard-approval。 |
| `cli.js`（82） | `dsh --profile personal` | — | 参数解析、最小 `.env` 加载（不覆盖已有 env）、三模式入口：一次性 / `--repl` / `--web`。`approval` 可变 ref 与审批守卫、Web 开关共享。 |

## Web 层

| 文件 | 职责 |
|---|---|
| `src/web/server.js`（272） | Web Host：Node 原生 `http` 服务静态页 + 会话 RPC/SSE。路由、token 鉴权、workspace 切换（allowlist：启动 root / home / tmp 子树，realpath 后校验）、逐次审批通知、项目 CRUD、文件上传（`POST /api/upload`，5MB 上限，落 `uploads/`）、会话导出（`GET /api/sessions/:id/export` 下载 .jsonl）。 |
| `src/web/settings.js`（63） | 设置存储：`settings.json`（非密钥）+ `credentials.json`（API key，**GET 永不回显，只回 `hasApiKey`**），原子写 + 文件 mode 保护。 |
| `web/app.js`（266）、`web/index.html`（75）、`web/style.css`（75）、`web/md.js`（43）🆕 | 浏览器客户端：按 session 事件渲染 user/assistant/tool 结果，侧栏会话管理、审批开关、composer 模型选择、`/compact`；新建 `web/md.js` 零依赖 Markdown 渲染（代码块复制按钮、工具卡片区分呈现）；`+` 菜单（上传文件、goal/plan/feedback、compact、permission、model、export）。 |

## Profile（`profiles/personal.json`）

```json
{
  "name": "personal",
  "home": ".code-worker",
  "plugins": ["session","system-prompt","tools","fs-local","tool-fs",
              "shell-local","tool-bash","llm-deepseek","agent-loop","guard-approval"],
  "config": {
    "workspace": ".",
    "maxSteps": 8,
    "toolResultMaxBytes": 20000,
    "compaction": { "maxContextChars": 60000, "pruneBytes": 2000, "keepRecent": 4 }
  }
}
```

> `plugins` 列表仅作声明，`profile.js` 按固定顺序手写装配，不解析此数组。

## 已注册工具（5 个）

| 工具 | 参数 | 审批 | 后端 |
|---|---|---|---|
| `read_file` | `path` 必需 | 否 | `LocalFs.readFile` |
| `write_file` | `path`, `content` 必需 | ✅ | `LocalFs.writeFile` |
| `list_dir` | `path` 可选，默认 `"."` | 否 | `LocalFs.listDir` |
| `bash` | `command` 必需 | ✅ | `LocalShell.run` |
| `todo_write` | `todos[]` 必需（≤50） | 否 | `session.writeTodos` |

## 设计不变量

1. **Model-visible ⟺ Logged**：发给模型的一切都在 append-only 日志里，日志即完整可重放历史。
2. **Definition / Provider / Consumer 分离**：扩展插件只依赖 `FsService` / `ShellService` / `LlmService` 接口，不依赖具体实现。
3. **审批在 executor 层**，不在 schema 层：`write_file`/`bash` 未批准时在 `tools/pre-execute` 被拒，而非从工具列表过滤。
4. **可逆注册**：`ctx.effect(() => register(...))` 在 `dispose` 时自动注销。
5. **密钥 write-only**：`credentials.json` 的 API key 任何 GET 都不返回。
6. **Profile 有序装配**：`profile.js` 按固定顺序应用，配置项来自 profile（默认值见上）。
7. **项目隔离**：有 binding 的会话每轮把 `fs`/`shell` 根指向本项目 repo 目录，轮后恢复；`AGENTS.md` 每轮实时重读，编辑即时生效。
8. **窄能力**：工具只能通过 `appendTodo` 写日志，不能直接访问 Session 全量。

## 扩展点

- **新工具**：`ctx.tools.register({name, description, schema, execute})`，后端经 `ctx.fs` / `ctx.shell` 缝。
- **拦截**：`ctx.on("agent/pre-step" | "tools/pre-execute" | "system-prompt/assemble", fn, "waterfall")`（必须 `next()`）。
- **新 Provider**：`ctx.get("llm").registerAdapter(name, adapter)`，loop 不变。
- **会话**：`.code-worker/<id>/session.v1.jsonl` 即完整可重放日志（同目录 `meta.json` 存项目 binding）。

## 测试（`test/`，18 个 `node:test` 文件）

`harness`（waterfall / 可逆 effect / 端到端日志 / confinement / 审批）、`web`、`settings`、`streaming`、`compaction`、`session-identity`、`retry`、`title`、`usage`、`model-override`、`approval`、`workspace`、`status`、`review2`、`blocked`、`todo`🆕、`render`🆕、`projects`🆕。

运行：`npm test`。

## 已知局限

- 无子代理 / Web 检索 / SQLite 检索；无 compaction 以外的记忆机制（项目记忆靠 `AGENTS.md` 人工维护）。
- `bash` 在 workspace 本地执行 shell（个人使用，默认需 `--yes` 或 Web 批准）；命令文本层无法可靠拦截敏感路径访问。
- Web 服务直接暴露文件读写与命令执行能力（受审批开关控制），仅可信 LAN 使用，勿做公网端口转发。
- `settings/test` 只打已配置 host；token 只走 header/query bootstrap，CLI 打印用占位符。
