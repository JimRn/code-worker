# DeepSeek Harness 设计要点总结

> 来源：仓库 `AGENTS.md`、`../../reference/deepseek-harness/docs/architecture.md`、`../../reference/deepseek-harness/docs/cordis-primer.md`、`../../reference/deepseek-harness/packages/README.md` 及核心包 README 归纳。本文为新人阅读入口，权威细节以链接的源文档为准。

## 1. 一句话定位

DeepSeek Harness（DSH）是一个全插件 Cordis Agent Harness：模型适配、工具注册、会话日志、Agent Loop 本身都是可替换插件，没有需要直接改 priviliged core 的地方；扩展 = 在旁边挂载插件。

## 2. Cordis 五大思想

1. 插件 = 实现 `Service` 的对象（函数带 `inject/apply(ctx)`，或 `Service` 子类）。
2. Context = 服务仓库，稳定键 `ctx.<key>`（`ctx.tools`、`ctx.llm`、`ctx.sessions`），通过键发现服务，不 import 具体实现。
3. `inject` 声明依赖，运行时等待服务就绪，加载顺序由服务需求表达，而非手动排序。
4. 类型化事件通信：声明合并声明事件名，按 `emit/waterfall/parallel/serial/bail` 分发（观察/环绕/扇出/顺序/首个 bail 止）。
5. 注册即效果：提示词段、工具 schema、适配器、监听器都经 `ctx.effect()/ctx.on()` 安装，卸载时可逆回滚。

关键语义：`waterfall` 监听器必须调用 `next()` 才能继续链，返回不调用即短路；可选服务用 `ctx.get(name)`，已声明注入才用 `ctx.<name>`。

## 3. Profiles 与 Bundles（组合层）

- 运行的 `dsh` = 启动时按有序层叠加的插件树。
- Profile：命名组合，存 Harness home，列出所叠 bundles + 外部插件 + `cordis.patch.yml`。 shipped: `web/headless/sdk/sdk-minimal/acp`。
- Bundle：分发 Cordis config 行 + 代码的格式；包 `package.json` 的 `dsh.profile/dsh.bundle` 声明。`dsh-base` 是 `web/headless/sdk/acp` 的共同第一层（模型适配、工具、持久化、沙箱审批、设置、凭据、遥测）;`sdk-minimal` 是例外，独立完整树不叠 base。
- 层叠顺序：空入口 → profile 有序 bundles → `cordis.patch.yml` → home patch → `--patch` overlays。Patch 按 id 整体替换 config 或插入新行。查看实际树：`dsh --profile web --dump-config`。

## 4. 应用启动约束

唯一受支持的 Node 应用启动方式是 `dsh --profile <name>`；禁止 package bin、demo、SDK argv 逃逸、直接 in-process 挂载、WebWorker 预览作为启动器（`verify-application-entrypoints` 把关）。Python SDK 亦然：runtime wheel 内含 `dsh` CLI，默认以 `dsh --profile sdk` + 显式 Harness home 启动。

## 5. 核心包（脊柱）

| 包 | 拥有 | Key |
|---|---|---|
| `core/session` | append-only `SessionEvent` 日志 + 内存存储 | `ctx.sessions` |
| `core/system-prompt` | 提示词段与工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 作用域工具注册 + 安全执行管线 | `ctx.tools` |
| `core/agent` | `Agent` 接口、实时注册表、`agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 默认驱动实现 | `ctx.agentLoop` |
| `core/scope` | per-agent 作用域注册原语 | （库，无 key）|
| `llm/llm` | 消息/流式词汇 + 适配器缝 | `ctx.llm` |

## 6. 事件三大域

- Session 事件：耐久事实，写入日志并经 `session/event` 广播，需要抗重载时用。
- Agent 事件（`agent/*`）：携带实时 `Agent` 的 inbox/step/status/request/validation/continuation，用于飞行中观察/拦截。
- Capability 事件（`fs/*, tools/*, telemetry/*`）：给缝挂策略与适配器，不 import loop。
另：`agent/pre-step、agent/request、llm/stream、tools/{pre-execute,execute,post-execute}` 为 waterfall（必须 `next()`），`agent/turn-stopping` 为 serial 无 `next()`，`agent/assistant-stream` 只发进程内 start/chunk/end 帧。

## 7. Turn/Step 流程

Step = 一次模型请求 + 其调用的工具；Turn = 零或多 Step。串行：`turn/start → claim 输入 → snapshot 模型选择 → 组装 prompt+admitted 工具 schema → agent/pre-step → prepareCall 绑定适配器 → 提交 system/user → 冻结请求 → llm/stream 流式 → tool/call* 走 tools 管线 → step/end → 需要再请求则下一 step → agent/turn-stopping → turn/end`。失败 step 补记缺失工具结果；取消在组装/绑定阶段不提交 system/user。

## 8. 会话日志是唯一真相

- `deriveMessages()` 从日志投影模型历史；`assistant/message` 内嵌产生它的完整紧凑流，`assistant/attempt` 保留失败/重试/取消/流错尝试（不进模型历史）。
- Model-visible ⟺ Logged：任何进入模型请求的东西都必须能从日志重建；新增模型可见输入必须新增 session event。改消息内容用纯消息投影，detached reader 显式传同一定义。
- 分叉/恢复/转录/遥测/持久化全源于耐久结算；进程硬丢失在结算前则无耐久 attempt 流。
- 格式迁移：消费者只懂当前逻辑格式；`stat/list` 只读 header 选最高 canonical generation；`open` 拒绝未来版本或经静态相邻迁移链解码；写 open 先编码校验再排他发布新版本名后继，永不移动/覆盖/删除已提交世代；JSONL v0 用 `session.jsonl[.zstd]`，v1+ 用 `session.vN.jsonl[.zstd]`。SQLite 单调 `SCHEMA_VERSION`。

## 9. Capability Seam（能力缝）

一个缝 = Service Definition（接口）+ Service Provider（实现）+ Consumer（通常是模型工具），三者缺一不可；只有一端不是缝。一个 Provider 切换即可整产品迁移：fs+subprocess 共享执行世界，指向远端沙箱后 Bash/PTY/LSP 一起走，无 provider fork。子代理、浏览器/电脑使用、PTY、Shell、FS、LSP、Web、Skill、Compaction、Jobs、MCP 等均为缝。

## 10. 新行为放哪（对照表）

| 目标 | 机制 |
|---|---|
| 新模型 Provider | `ctx.llm` 注册适配器 |
| 新模型能力 | `ctx.tools` 注册，schema 进 prompt 组装 |
| 单 Session 换能力集 | Agent preset，服务行需 `isolate` realm |
| Shell/PTY 执行 | `ctx.shell` / `ctx.terminals` |
| 人类命令 | `ctx.commands`（不走模型 turn）|
| 后台任务 | `ctx.jobs` + `job_*` 工具 |
| webhook 触发 Session | `ctx.webhookRuntime` 可信规则 + adapter |
| FS 访问/策略 | `ctx.fs` provider 或 `fs/*` 事件 |
| 进程 confinement | `ctx.sandbox` 后端，consumer 包 argv |
| 拦截 request/tool/turn | `agent/*` 或 `tools/*` 事件 |
| 模型上下文 | `agent.inject()` 下一已准入请求 |
| UI/编辑器集成 | 驱动 `ctx.agents`，渲染 `session/event` |
| 耐久 Session 状态 | 扩展 `SessionEventMap`，从日志渲染/回放 |
| 新持久化后端 | 实现 `SessionPersistence(create/open/stat/list/export)` |

改 `agent-loop` 必须同步更新 `../../reference/deepseek-harness/docs/architecture.md`；优先挂文档扩展点而非改 loop。

## 11. 包分组速览（`packages/<group>/<pkg>`，`@deepseek-ai/dsh-*`）

core(agent/session API)、api(BFF)、typert、llm、shell/subprocess/ssh/terminal/sandbox、fs/lsp、skill、web、computer-use/browser-use、compaction/context、subagent/team、jobs、bundle、workflow、todo/plan/goal/schedule、preset/guard/extensions、session/session-query、attachment/spill/storage/workspace、settings/credentials、acp/interaction、boot/sdk/host/client、mcp、experimental（独立于是否交付的产品支持状态）、test-support、util。每个 group README 为该族权威包图；依赖图由 `docs/module-graph.md` 生成。

## 12. 工程规约（Agent 必须遵守）

- ESM 全域；ESM-only 的 tsx source-launch 可达模块禁止 CJS-only 导出；包间用包名，相对导入带 `.ts`。
- 注册即效果：`ctx.effect()/ctx.on()`，`register()` 返回 disposer。
- 类型化事件用声明合并 + merge-extensible map；事件 JSDoc 写 `@mode` 与载荷 `@param`；判别联合 switch 以 `assertNever` 兜底。
- 跨界 opaque id 用 `Branded<B>`，不用裸 `string`；`strict+noImplicitAny`，剩余 `any` 需说明；禁止新增 `as unknown`。
- 类型化同进程边界信任 TS，不加运行时校验；parser/config/队列/模型-工具 JSON/耐久文件/worker/进程/wire 边界才校验。
- 配置错误 loud fail，不静默跳过；插件无硬编码 tunable，部署可变项进 validated `Config`（cordis.yml 可改）；`resolve(request): Spec` 显式默认，`run()` 内不隐藏 `?? default`。
- 共享状态挂服务/实例，禁止模块级缓存/单例/`globalThis` 全局；业务规则独立成包，运行时层只做编排。
- 模型可见文案从模型视角写，不含 UI/传输/实现词；工具 UI 表现先行设计，Host presenter 纯函数，Web card 由原始事件 + 持久化元数据派生。
- 错误：类型化结构化失败 + 可操作报告，明确 ownership/containment/保证；空 `catch` 写明错误与原因，`try` 只包一条语句。
- 注释/JSDoc 只写完整合同，不写推理过程/测试 walkthrough/代码复述；术语精确（用 response fields 而非 response shape）。
- 测试描述行为非正确性；模型/产品可见变更必更新 keyless recorded-session snapshot；`test:coverage` 是 CI 覆盖门；开发用 `build:artifacts`，宣称完成前跑 `build:check`。

## 13. 关键源文档索引

架构：`../../reference/deepseek-harness/docs/architecture.md`；Cordis：`../../reference/deepseek-harness/docs/cordis-primer.md`、`../../reference/deepseek-harness/docs/cordis-tutorial/`；包图：`../../reference/deepseek-harness/packages/README.md`；子系统类型：`../../reference/deepseek-harness/docs/subsystems/`；缝图：`../../reference/deepseek-harness/docs/capability-seams.md`；工具管线：`../../reference/deepseek-harness/docs/tool-execution-pipeline.md`；生命周期：`../../reference/deepseek-harness/docs/agent-lifecycle.md`；事件生产消费：`../../reference/deepseek-harness/docs/event-producer-consumer.md`；防御模式：`../../reference/deepseek-harness/docs/defensive-patterns/`；测试：`../../reference/deepseek-harness/docs/testing.md`；教程 cookbook：`../../reference/deepseek-harness/docs/cookbook/`。
