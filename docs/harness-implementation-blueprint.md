# Harness 实施蓝图（供 AI Agent 按图索骥）

> 与 [设计要点](harness-design-summary.md)、[实施提示词](harness-ai-agent-prompt.md) 配套。按任务类型挑一条路径执行。

## A. 新增 LLm Provider

```
ctx.llm (llm/llm Definition)
  └─ Provider: packages/llm/<name>（提交适配器：消息/流式词汇、model 选择、reasoning effort 默认、prepareCall 绑定）
  └─ Consumer: agent-loop（只经 prepareCall 拿 bound call，不直连 provider）
```
要点：重试保留 pre-step 快照的 `modelSelection`；`agent/request` 只调 controls，不换 provider/model/effort；流终态提交为一条 message 或 attempt。

## B. 新增模型工具（最常见路径）

```
Consumer: packages/<family>/tool-<x>（schema→ctx.tools 注册→进 prompt 组装）
  ├─ executor: ctx.tools.execute() 管线 tools/pre-execute→execute→post-execute（waterfall 必须 next()）
  ├─ 后端缝: ctx.fs / ctx.shell / ctx.terminals / ctx.web / ctx.lsp 等（Definition+Provider）
  └─ UI: Host presenter（纯）+ Web card（原始事件+result 元数据）
```
要点：request/spec 分离（`resolve(request): Spec`，不在 `run()` 藏默认）；结果施加 byte/token/item/time 界；denial 经 executor 测。

## C. 新增持久能力缝（如 fs remote / sandbox backend / jobs backend）

```
1. Definition 包：ctx.<key>、类型、事件（fs/* 等）、Config schema
2. Provider 包：实现并注册，effects 可逆，sandbox 场景包 argv
3. Consumer 包：工具/命令层；共享执行世界（如 fs+subprocess）一起切换
4. bundle：挂进 dsh-base 或对应 profile，cordis.yml 行可 patch
```
要点：同一执行世界内的 provider 成对替换（fs+subprocess+sandbox→ssh/sandbox 实例）；preset 单 session 隔离需 `isolate` realm。

## D. 拦截 / 策略 / 审批

拦截点：`agent/pre-step`（accept/rewrite/reject；首个 enter 被拒或空则无 step 关闭 turn）、`agent/request`、`tools/pre-execute`（审批/策略短路）、`agent/turn-stopping`（serial 停 turn）。策略监听器拥有决策时可不 `next()` 短路；仅标注的必须委托。模型上下文经 `agent.inject()`，下一已准入请求注入。

## E. 耐久状态与会话

新事实 → `SessionEventMap` 新成员 → 投影 `ctx.sessionProjections`（fold 事件）→ `snapshot()` 供 carrier 读取。持久化新后端实现 `SessionPersistence` 五方法。格式变更：既有判别符可防不安全解释则同版本兼容读；否则 bump `SESSION_FORMAT_VERSION` 并写相邻迁移 + upgrade guide。

## F. UI 与客户端

Web/Host：经 `ctx.agents` 驱动、`session/event` 渲染；Chat 节点注册 `ConversationNodeDefinition` + keyed renderer；文案走 typed dictionary `t`，禁硬编码；Electron Desktop 复用同一 dsh runtime（Host 进程 + Web 资源，Node IPC 传 boot 注入/就绪/致命错/shutdown）。

## G. 测试与门禁最小清单

| 变更面 | 必须证据 |
|---|---|
| 工具/模型输出 | keyless recorded-session snapshot 更新 |
| 包行为 | 包级 `tests/` 行为测试 + HMR dispose 测试 |
| composition | 经 Loader 的 REAL-composition 测试（手搭 ctx 不足）|
| TS/文档 | `typecheck`、`lint`；文档改跑 `doc-sync` |
| 产物 | `build:artifacts` 后 `build:check` |
| SDK 影响 | TS+Python SDK expected outputs 同 PR 更新（loop/lifecycle/SessionEventMap 变更）|

## H. 目录与文件约定

- 包：`packages/<group>/<pkg>/`，`src/types.ts` 纯类型，测试 `tests/`，README 含 Model Experience 与 Known Limitations。
- 配置：`cordis.yml` 行经 patch 层可替换；`!!js` 仅限 plugin `config` 与 entry `disabled`。
- 启动：`dsh --profile web|headless|sdk|sdk-minimal|acp`，查看树 `dsh --profile web --dump-config`。
- 密钥：真实 API 读 `OPENAI_API_KEY`（`DEEPSEEK_*` fallback）（根 `.env`），永不提交凭据；CI 无 key 自跳过 e2e。
