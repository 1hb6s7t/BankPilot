# BankPilot：Agent 编排与协议复用决策

调研截止：2026-10-22，Asia/Shanghai（UTC+8）。范围为 React/Vite/TS + Hono/Node + Postgres 的模块化单体，1 总控、6 个按需领域 Agent、1 个独立复核 Agent。本稿是静态选型与 PoC 方案，未搭建、未跑业务验收。GitHub connector 经主线程实测未连接；回退官方网页、公开 GitHub API 和官方源码。API 部分触发 403 限流，未取到的字段不补猜。原始响应保存在 `evidence/agent-*.json`。

**建议保留 LangGraphJS 为唯一主编排引擎，Mastra 为替代候选，OpenAI Agents SDK JS 为轻量领域运行器候选。** 不同时引入多个顶层状态机。MCP 仅用于确有跨进程、外部工具互通需求的边界；单体内部委派用受类型检查的函数契约。以下接入与成本判断属于面向 BankPilot 的工程推论。

## 1. LangGraph 可以直接复用到哪一层

| 模块 | 分类 | 复用接口与落点 | BankPilot 要补的部分 |
|---|---|---|---|
| 图执行与按需并行 | 直接复用机制 | `@langchain/langgraph` 的 `StateGraph`、条件边、`Send`，将选中的领域映射为动态分支，再汇聚 | 领域选择白名单、依赖 DAG、最大并发、业务截止时间 |
| 独立上下文 | 微调适配 | 每个领域单独子图 schema，由包装节点只映射获准输入与结构化输出 | 身份、可见账户、字段脱敏、工具集合由服务端注入；不向所有领域广播对话 |
| 图状态持久化 | 直接复用机制 | `@langchain/langgraph-checkpoint-postgres` 的 `PostgresSaver`、稳定 `thread_id`、checkpoint namespace | tenant/user 绑定、同线程单写者、保留期、图/schema 版本与迁移 |
| 暂停与继续 | 微调适配 | `interrupt()`、`Command({resume})`；持久化待确认界面 | 确认主体、一次性 nonce、`actionVersion/normalizedActionHash`、风险与有效期；计划版本单独用于提案归属及过期检查 |
| 重试、超时、流事件 | 直接复用机制 | 节点 `retryPolicy`、timeout、stream，取消信号传到模型/HTTP 客户端 | 重试分类、费用预留、取消后的结算、对外稳定进度事件 |
| 状态归并 | 微调适配 | reducer 合并分支返回值 | 按 `proposalId` 去重、稳定排序、过期版本拒收；reducer 不理解业务冲突 |
| 输出与工具参数 | 微调适配 | Zod schema、模型结构化输出/工具调用接口 | 再做服务端 parse、金额/币种/日期/证据/适用条件校验；解析成功不等于业务允许 |

官方 [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) 提供条件路由、并行与 reducer；[子图指南](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) 明确支持父子不同 schema 和各 Agent 私有消息历史。这里的隔离是输入映射与 checkpoint 命名空间，不构成数据库权限或进程安全沙箱。

持久化复用 [checkpointer/store 机制](https://docs.langchain.com/oss/javascript/langgraph/persistence)。`MemorySaver` 不能跨进程重启；上线使用 PostgresSaver。业务交易表与 checkpoint 表分开：恢复图不能替代查询真实交易结果。

[interrupt 指南](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 明确说明恢复会从节点开头重跑，暂停前代码可能再次执行；因此确认节点之前不放资金副作用。[故障容错指南](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) 支持节点重试与超时，但外部已提交的交易不会因图节点失败自动撤销。

具体源码入口：[`libs/langgraph-core/src`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/langgraph-core/src)，不是旧资料常写的 `libs/langgraph/src`；后者目前是兼容包装。参考 `src/tests/parallel_interrupt_resume.test.ts`、`subgraph_resume.test.ts`、`concurrent-thread-isolation.test.ts`；Postgres 集成测试在 [`libs/checkpoint-postgres/src/tests`](https://github.com/langchain-ai/langgraphjs/tree/main/libs/checkpoint-postgres/src/tests)。本次核查了测试文件存在和 Vitest/unit/integration 脚本，未声称这些测试已由本项目通过。

## 2. 必须自研的业务契约

建议单体内定义 `DomainAgent.run(Delegation, ContextView) -> DomainProposal`。委派至少包含 `taskId/runId/planVersion/domain/dependencies/deadline/budget/allowedToolIds/contextRefs`；身份权限由服务端上下文提供，不接受模型自报。结果包含 `proposalId/planVersion/actions/evidenceRefs/preconditions/readSet/conflictKeys/estimatedCost/expiry/status`；具体动作包含稳定 `actionId`、`actionVersion` 和服务端计算的 `normalizedActionHash`，另存风险与授权有效期。各领域只能提案；复核 Agent 只读证据与提案，输出问题和建议，不能授予权限。

主图流程：意图 → 版本化计划 → 按依赖并行领域 → 确定性冲突/预算汇总 → 独立复核 → 用户确认 → 执行网关 → 对账 → 汇报。框架负责节点调度；下列规则由业务服务实现：

- **计划版本与动作授权分离**：全局 `planVersion` 表示当前编排快照，用于拒收旧分支提案；具体批准绑定 `actionId/actionVersion/normalizedActionHash`、确认主体、风险与有效期。只有受影响动作的金额、收款人、卡片、产品等关键字段，或风险、有效期改变时，才更新动作授权版本并要求重新授权。无关查询节点的增删、重跑或计划版本变化，不作废未变化且仍有效的动作授权；执行前仍须重新校验余额、依赖和授权状态。回调按 operation/action 身份归属与去重，不因计划升级丢弃真实执行结果。
- **冲突与资金约束**：识别同账户资金争用、冻结卡与扣款、同订阅重复取消；在最新余额及预约支出上统一计算，而非让多个 Agent 各自判断“余额够”。必要时串行执行依赖步骤。
- **预算**：区分模型费用、工具调用次数、墙钟时间与资金支出；并发前原子预留，完成后结算。`recursionLimit/maxTurns` 只是运行护栏，不能替代共享预算账本。
- **恢复与执行**：自建 operation ledger、幂等键、状态转换和 outbox/回调去重；状态不明时先向银行/支付接口查询，再决定重试。不可把 checkpoint 成功推导为付款成功，也不可承诺框架提供金融 exactly-once。
- **统一授权网关**：唯一持有资金写权限，重查主体/范围/金额/产品条件/确认有效性，记录审计证据。独立复核和 HITL 均不能取代这道校验。

Hono API 接受任务/确认并记录业务状态，Worker 持有图运行器与 PostgresSaver；Web 订阅 BankPilot 自有 SSE 事件 `taskId/node/status/attempt/sequence`。浏览器刷新从业务事件和持久化状态恢复。避免把供应商原始 token/event 类型变成前端业务协议。

## 3. 备选与协议的实际价值

| 候选 | 可复用模块、目录 | 决策与切换成本 |
|---|---|---|
| Mastra | `@mastra/core/workflows` 的 `createWorkflow/createStep`、`.then/.branch/.parallel`、suspend/resume；`@mastra/pg`；`packages/core`、`stores/pg` | 同 TS 栈，最佳整体备选。需重写图定义、状态/恢复适配和流事件映射；现存 checkpoint 不能直接沿用。工作流机制可复用，资金/确认/冲突仍自研。见[工作流文档](https://mastra.ai/docs/workflows/overview)。 |
| OpenAI Agents SDK JS | `@openai/agents-core` 的 Agent/Runner、typed tools、`outputType`、agent-as-tool、guardrails、可序列化运行状态；`examples/agent-patterns/{agents-as-tools-structured,parallelization,human-in-the-loop-server}.ts` | 适合固定主管调用领域工具，或替换单个领域内部循环。优先 agent-as-tool，让总控持续掌握流程；handoff 会改变对话控制权。顶层替换需自行补图调度/持久化与事件映射，成本中高。 |
| Microsoft Agent Framework | Python `agent-framework`；.NET `Microsoft.Agents.AI`；`python/samples/03-workflows`、`dotnet/samples/03-workflows` 的 concurrent/sequential/handoff | 官方完整主体为 Python/.NET，[仓库文档](https://github.com/microsoft/agent-framework)提供多模型、checkpoint、HITL、middleware。不能当作现成 Node 编排库；若采用需 Python/.NET 服务和额外部署、序列化、身份传播，成本高。 |
| Google ADK TypeScript | 官方 `google/adk-js`，`@google/adk`、`@google/adk-devtools`；`LlmAgent`、顺序/并行/循环与图工作流；`samples/workflows`、`tests/integration/docs_samples` | 官方 TS 版本确实存在，[README](https://github.com/google/adk-js)要求 Node ≥20.19。可作为 Google 生态候选；不可把 Python 特性直接视为 TS 已有。需验证所选 provider、持久会话和审批路径，整体替换成本中高。 |
| AutoGen | Python `autogen-agentchat/autogen-core/autogen-ext`，历史样例 | 不选新项目运行时；官方 10/16 已改为归档且不再维护，后继是 MAF，见[不可变提交](https://github.com/microsoft/autogen/commit/004749e6b7102c8fd317b9b1499ce5807223c278)。 |
| MCP TypeScript SDK | v2 `@modelcontextprotocol/server`、`client`，Hono 边界可用 `@modelcontextprotocol/hono`；`packages/{server,client,middleware}`、`examples` | 直接复用工具发现、schema、transport、取消与协议处理；外包工具或独立系统接入才引入。它不负责 Agent 委派、计划冲突、银行授权；内部领域调用无需绕一圈 MCP。见[官方包结构](https://github.com/modelcontextprotocol/typescript-sdk)。 |

OpenAI SDK **不强制 OpenAI 模型**：[官方模型文档](https://developers.openai.com/api/docs/guides/agents/models)指向非 OpenAI provider/adapter，源码 [`Model/ModelProvider`](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/model.ts) 允许实现 `getResponse/getStreamedResponse/getModel`，或用 `@openai/agents-extensions/ai-sdk` 的 `aisdk()`。不过兼容必须实测：[issue #2048](https://github.com/openai/openai-agents-js/issues/2048) 报告 Gemini 并行工具结果消息格式不兼容，截至观察仍打开；“provider-agnostic”不能推导所有模型行为一致。

## 4. 许可证与维护证据

版本为本次观察到的候选发布快照，均不是已通过 PoC 的锁定依赖。日期以 UTC 的 API/官方发布页为准；10/21 19:42 UTC 即北京时间 10/22 03:42。公开网页和 main 可变化，原始 JSON 留存检索时点；未发现已采用证据晚于截止日。不能用“PR 已合并”替代“锁定 npm 版本已包含”。

| 项目 | 发布/近期提交与维护样本 | 开源边界、测试与局限 |
|---|---|---|
| LangGraphJS | [`@langchain/langgraph` 1.5.2](https://github.com/langchain-ai/langgraphjs/releases/tag/%40langchain/langgraph%401.5.2)，10/21；commit `6a1f1f8` 10/22；[#3026](https://github.com/langchain-ai/langgraphjs/pull/3026) 10/21 合并；[#3078](https://github.com/langchain-ai/langgraphjs/issues/3078) 10/21 创建、仍打开，修复 [#3084](https://github.com/langchain-ai/langgraphjs/pull/3084) 10/22 提交且仍为 Draft | 核心与 Postgres 包 [MIT](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE)。Vitest、并行/恢复/PG 测试齐备。无归档提示，持续合并；API archived 字段限流未取到。LangSmith 自托管是[Enterprise 附加项](https://docs.langchain.com/langsmith/self-hosted)，不因库 MIT 获得平台授权。 |
| Mastra | [`core` 1.79.0](https://github.com/mastra-ai/mastra/releases/tag/%40mastra/core%401.79.0)，10/21；commit `846639e8` 10/22；[#27012](https://github.com/mastra-ai/mastra/issues/27012) 恢复丢 suspendData，修复 [#27127](https://github.com/mastra-ai/mastra/pull/27127) 10/15 合并并关闭问题 | API archived=false。核心 [Apache-2.0](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)，任意 `ee/` 目录是[企业 source-available 条款](https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE)，含部分 auth/agent-builder/editor；生产与再分发不能按开源推定。文档与测试活跃，当前只允许协作者建 PR。 |
| OpenAI Agents JS | [`0.21.0`](https://github.com/openai/openai-agents-js/releases/tag/%40openai/agents%400.21.0)，10/20，release commit `304e436`；[#2082](https://github.com/openai/openai-agents-js/issues/2082) 当日报 usage 嵌套字段导致流失败，已关闭且发布记录含对应修复；#2048 仍打开 | API archived=false；[MIT](https://github.com/openai/openai-agents-js/blob/main/LICENSE)，模型/托管服务另计。`packages/agents-core/test` 含 runState、审批恢复、guardrail、工具隔离等测试；当前外部 PR 提交受限。 |
| MAF | [Python 1.22.0 / .NET 1.25.0](https://github.com/microsoft/agent-framework/releases)，10/15、10/14；[#9535](https://github.com/microsoft/agent-framework/pull/9535) 审批匹配修复 10/21 合并 | [MIT](https://github.com/microsoft/agent-framework/blob/main/LICENSE)，Azure/Foundry 服务条款独立；有语言分离的样例、开发文档与测试要求。无归档提示，API archived/最新 commit 查询限流；合并记录证明近期维护，不是支持 SLA。 |
| ADK TS | [`2.3.0`](https://github.com/google/adk-js/releases/tag/adk-v2.3.0)，10/13，commit `ad0540e`；[#994](https://github.com/google/adk-js/pull/994) 10/21 合并且补回归测试 | [Apache-2.0](https://github.com/google/adk-js/blob/main/LICENSE)；无归档提示，archived/最新 commit API 限流。`samples/workflows/README.md` 明确样例独立类型检查及离线集成测试。[#1005](https://github.com/google/adk-js/issues/1005) 报 A2A 可伪造 HITL，仍打开，报告涉及 1.6.0；本次未动态复现，也不能断言 2.3.0 已修好。 |
| AutoGen | 最新观察 Python release [`0.7.5`](https://github.com/microsoft/autogen/releases/tag/python-v0.7.5) 为 2025-09-30；2026-10-16 最新提交是归档声明 | [代码 MIT](https://github.com/microsoft/autogen/blob/main/LICENSE-CODE)，[文档 CC-BY-4.0](https://github.com/microsoft/autogen/blob/main/LICENSE)。README 明确不再提供修复/支持；不应以历史测试与 star 推导未来维护。 |
| MCP TS | [`2.3.1`](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.3.1)，10/05，commit `fcef852`；[#2952](https://github.com/modelcontextprotocol/typescript-sdk/pull/2952) 当日合并补 token audience 选项，10 月仍有协议/validator PR | [LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/LICENSE) 正从 MIT 迁向 Apache-2.0，未同意改许可的旧贡献仍 MIT、一般文档 CC-BY-4.0；不能简写全仓 MIT。v2 为稳定 split 包，v1 `@modelcontextprotocol/sdk` 维护线仍存在；有 Vitest/E2E。archived API 限流，无归档提示。 |

## 5. 接入门槛与 PoC 验收（尚未执行）

1. **三领域真并行**：账单、订阅、目标在同一快照读取，记录重叠时间；只启动选中的领域。每个领域插入私有 canary，其他领域、复核与用户输出都不可见未经授权字段。
2. **版本与冲突**：转账与理财同时争用余额，确定性网关必须拒绝超额；升级 `planVersion` 后注入旧分支提案，必须拒收。修改某动作关键字段、风险或有效期后，注入旧 `actionVersion/normalizedActionHash` 批准，必须拒收并要求该动作重新授权；只新增或重跑无关查询时，未变化且仍有效的动作授权应继续有效。独立复核失败不得自动执行。
3. **恢复与副作用**：在确认前、网关提交后但 checkpoint 前、回调重复、Worker SIGKILL 等位置注入故障。刷新后待确认项、计划版本、动作授权版本与交易状态一致；执行凭幂等键/查询对账，无重复扣款；旧计划的真实执行回调仍归入对应 operation 并完成对账。
4. **框架已知风险**：照 #3078 复现 A 失败/B 被取消并带 errorHandler 的恢复，确保 B 不被误判完成。#3026 涉及约 61 MB checkpoint 崩溃；业务不存大 blob，同时验证锁定 Postgres 包包含修复。修复合并晚于 1.5.2 发布，须单独核对 checkpoint-postgres 版本，不可只升核心。
5. **双 provider 相同契约**：同一批任务在目标云/本地模型检验工具调用、严格 schema、流取消、并行结果、费用与恢复；无效输出不得落到资金网关。OpenAI 备选包含 #2048 回归，Google 备选包含审批来源不可由 A2A 自报的测试。
6. **预算与可替换性**：并行分支同时耗尽预算时总预留不超限；取消后统计仍在途费用。用脚本化模型重放同一 Delegation/Proposal/Review/Execution 合约；仅更换编排 adapter 即可保持 API、领域服务、资金网关和审计结构。

先锁定核心、checkpoint、模型 adapter 和 schema 依赖的确切版本及来源 SHA，再运行以上 PoC；每项留下输入、事件轨迹、数据库状态、模型费用与恢复证据。任何框架的 advertised durability、guardrails 或 human approval 都不能独立证明金融权限正确或交易仅执行一次。
