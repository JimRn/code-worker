# code-worker-docs — 项目文档索引

> 本目录整理 `../code-worker/` 的模块与架构，源代码只读参考，不在此改代码。
> 若与源码冲突，以源码为准。

## 文档

| 文档 | 内容 |
|---|---|
| [architecture.md](./architecture.md) | 整体架构图（Mermaid + `architecture.png`）、分层、一次 Turn 的数据流、持久化布局 |
| [modules.md](./modules.md) | 逐模块职责、关键导出、与上游 DeepSeek Harness 的对照、设计不变量、扩展点、已知局限 |

## 速览

- **定位**：个人版 DeepSeek Harness（mini-Cordis），零依赖，仅 Node ≥ 20 内置，约 2377 行。
- **核心**：`Context`（服务注册 + 类型化事件） + `Session`（append-only 日志，唯一事实源） + 三段式能力缝（Definition / Provider / Consumer） + `ProjectStore`（项目隔离 + 逐轮 AGENTS.md 注入）。
- **工具**：5 个（`read_file` / `write_file` / `list_dir` / `bash` / `todo_write`），其中 `write_file`、`bash` 需审批。
- **入口**：`code-worker/src/cli.js`，经 `profiles/personal.json` + `src/profile.js` 的 `bootProfile()` 装配。
- **运行**：`node src/cli.js --mock --yes "list files in workspace"`（离线演示）；`npm test`（`node --test`）。

## 目录结构（源码）

```
code-worker/
├── src/                  # 核心运行时（ESM）
│   ├── context.js / session.js / agent-loop.js
│   ├── llm.js / tools.js / fs.js / shell.js / todo.js
│   ├── projects.js       # 项目 CRUD + repo 隔离 + AGENTS.md 注入
│   ├── compaction.js / profile.js / cli.js
│   └── web/server.js, web/settings.js
├── web/                  # 浏览器客户端（原生 JS，无构建，含 md.js）
├── profiles/personal.json
├── docs/                 # 设计文档（summary / blueprint + 本文档同步副本）
├── test/                 # 18 个 node:test 文件
├── .code-worker/         # 运行时数据（会话日志 + meta.json、settings、credentials）
└── ~/.code-worker/projects/  # 项目数据（项目 AGENTS.md + repos，CW_PROJECTS_DIR 可改）
```
