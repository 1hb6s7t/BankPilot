# G8 复用与集成建议（只读调研）

日期：2026-10-23。范围：完整聊天、澄清续接、原命令恢复，以及将现有 PostgresSaver 有条件接入主规划图。本文件仅给方案与证据；不表示代码已经接入或测试已通过。

## 现有事实优先

当前项目已经安装 assistant-ui、LangGraphJS、PostgresSaver、PostgreSQL/pg、Better Auth 和 pg-boss。`THIRD_PARTY_NOTICES.md` 记录本地锁定版本与许可证：`@assistant-ui/react 0.15.30`、`@langchain/langgraph 1.5.2`、`@langchain/langgraph-checkpoint-postgres 1.1.2`，这些包声明 MIT；PostgreSQL 为 PostgreSQL License。实施时继续保留原 LICENSE/NOTICE，并以锁文件和包内容核对，不能用官网最新版本替换冻结依赖。

本轮直接检查 `App.tsx`、`app.ts`、`recovery.ts` 与持久化测试：前端已有 ExternalStore adapter，API 已有 owner 绑定的 command journal/租约/不可变 proposal，Core 已有稳定子命令和副作用幂等，PostgresSaver 已有独立基础设施 PoC。优先填补这些模块之间的应用契约，不新增第二套聊天云服务或数据库。

## A/B/C 决策矩阵

A = 直接复用；B = 适配复用；C = 业务必须自建。评估不是按项目知名度或星数选择。

| 模块 | 类别 | 复用什么 | 必须补的边界/验收 | 集成建议 |
|---|---|---|---|---|
| assistant-ui ExternalStoreRuntime | B | 既有 `messages/convertMessage/onNew/isRunning` 适配和消息渲染 | PG hydration、稳定 ID、owner 变化清缓存、命令状态、澄清引用 | 保留现有 React 页面；应用 store 管聊天，框架管显示 |
| PostgreSQL + pg | A/B | 已有数据库、连接池、事务和迁移入口 | 新消息/对话/澄清表；唯一键、顺序分配、原文与 hash 持久化 | 同一数据库扩展应用 schema；不加另一台存储服务 |
| API `bp_plan_commands` | B | 同 command 同参重放、异参拒绝、租约 token CAS、proposal/result | 持久原文、conversation/message/revision 关联、状态查询与恢复入口 | 抽共享内部 command service，聊天与旧 `/api/plan` 共用 |
| Core actions/management/investment/goals | A | 动作身份、版本/哈希、原有 command 幂等、授权、占额、回执/查单 | 为聊天恢复加断点验证，确保没有重复 draft 或授权 | 不迁移到图中，不复制聊天“余额状态” |
| Better Auth | A/B | 服务端 session owner | 每个聊天端点的 owner 验证、跨用户 ID 和迟到 UI 响应测试 | 不信任客户端 userId 或 graph threadId |
| LangGraphJS 状态图 | B，8B 才接主图 | 当前并行领域/复核拓扑、持久化接口与 interrupt | graph version、每 command revision 隔离、状态兼容、旧 lease 写入隔离 | 先只 checkpoint 规划节点，不包裹执行调用 |
| PostgresSaver | B，已有 PoC | 现有依赖、真实 PG checkpoint 与恢复测试 | 主图集成、可信 checkpoint 引用、CAS/fencing、版本和保留策略 | 接现有 PG；不以 PoC 的 approved 布尔恢复金融授权 |
| pg-boss/Outbox Worker | A | 原有授权后派发/恢复流程 | 聊天刷新不投递新工作；不把 replay 当新执行 | 保持唯一执行后端；不是聊天历史库 |
| 澄清状态机与字段来源 | C | 可复用 Zod 和 G7 grounded slots | rootCommand/revision、候选事实版本、回答槽位限制、并发 CAS、取消语义 | 必须自建；框架不能替代银行请求含义 |
| UI 消息与业务命令投影 | C | 可以复用原 plan summary/evidence | stable response ID、result→message 补齐、历史文本与当前 action 区分 | 构建小型应用 service，避免不可控双写 |
| 任意节点业务副作用恢复 | 不纳入 8A；8B 也不自动获得 | 只能复用现有 Core command 幂等 | 外部副作用与 checkpoint 之间的提交窗口、旧 runner/新 runner 竞争 | 禁止宣称仅添加 saver 就实现 exactly-once |

## 官方能力核对

assistant-ui 官方说明 ExternalStoreRuntime 接受应用持有的状态；消息持久化和同步由应用控制。其通用恢复要求后端真实保留可恢复运行，并继续同一消息/工具状态，不能用 append 或 regenerate 代替。适合已有 BankPilot store/API 的增量适配，无需切换到另一个聊天托管平台。[ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)

LangGraph 将 checkpointer 定义为 thread 内图状态持久化，与跨 thread 的 application store 区分。G8 已有关系数据库应用表，没必要因为“长期对话”再加一个 Store 层来重复保存聊天权威数据。[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

官方 checkpointer 指南说明 checkpoint/super-step、节点 pending writes、同步/异步/退出时持久化模式及 PostgreSQL adapter；回放后续节点可重新发起模型/API 调用。因此业务副作用仍须用本项目已有稳定命令隔离。采用同步 durability 也不能把两个独立数据库事务变成一个原子事务。[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)

官方 interrupt 文档明确恢复需要相同 thread 引用，并重新执行中断所在节点的前部代码。G8 若用它等待补充字段，恢复 payload 应是版本化的澄清回答；不得沿用 PoC 的 `approved` 字段作为业务强验证证据。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

## 维护、活跃度与支持证据

本轮打开官方仓库 releases，LangGraphJS 可见 2026-10-22 发布记录及当前主包 1.5.2 的条目；assistant-ui 可见 2026-10-22 发布记录及 0.15.31 的条目，说明两者近期仍在发布。项目实际安装版本仍按锁文件，不因有新版就升级。[LangGraphJS releases](https://github.com/langchain-ai/langgraphjs/releases)、[assistant-ui releases](https://github.com/assistant-ui/assistant-ui/releases)

两者具备公开源码、维护中的官方文档、Issues/PR 与社区讨论入口。LangGraph 文档链接官方论坛，assistant-ui 仓库提供 Discussions。此处只能据此确认可用支持渠道，不能推断响应 SLA、未来维护承诺或商业支持保障。[LangGraph 官方论坛](https://forum.langchain.com/)、[assistant-ui Discussions](https://github.com/assistant-ui/assistant-ui/discussions)

已有项目使用这些库，并有真实 PostgresSaver 隔离测试，是适配风险低于整体换框架的本地证据。网上文档可能领先安装版本；在未改依赖前应先通过本地 TypeScript 接口和隔离 PG 测试验证 `canResume` 等具体接口，不能凭官网示例断言当前包已支持所有新功能。

## 推荐的最小实施顺序

1. 先建立应用 PG 消息/澄清数据和 command 原文关联，封装 owner 检查及 CAS；保证接收后刷新可恢复。
2. 把现有规划实现抽成可复用内部 command service，保留冻结 proposal 和稳定子 command 的恢复逻辑。新增 GET 状态和原 command retry；HTTP 响应丢失不重新创建 command。
3. 将 ChatPanel 的内存消息切为 API 投影；绑定会话 owner/conversation generation；先完成刷新、重登录、pending、错误状态和受支持澄清续接。
4. 在隔离 PG/API 与浏览器执行 `phase8-contract.md` 的 H01–H17；自动测试与浏览器验收分开保存，不重写 G7 首轮结果。
5. 只有 8A 稳定后才接 8B 规划 checkpoint。先解决 lease fencing 与 graph version，再接同步持久化和可选 interrupt；执行侧保持原实现。逐项跑 G01–G04，不用基础设施 PoC 替代。

## 不推荐的替代路线及理由

- 不先接 assistant-cloud/另一套聊天数据库：现有身份和业务持久化在本地 PG；同步两个 owner/消息系统增加未解决的边界，没有当前需求收益证据。
- 不先引入 Temporal 或另一个 durable runtime：当前执行可靠性已由 API/Core/Outbox/Worker 负责；引入会重叠职责。本阶段缺口是聊天身份与应用状态，不是缺一个调度平台。
- 不直接把 conversationId 传给 PostgresSaver 并开启 UI Resume：服务器仍需 owner 验证、command revision 隔离、checkpoint 写入 fencing 和恢复版本检查。
- 不用大模型自由总结历史来恢复命令：原文、已验证槽位及动作标识必须可精确还原；摘要只能辅助显示，不可作为转账/授权事实来源。
- 不复制银行卡、持仓、订阅、余额进聊天状态作为当前事实：历史显示可保存快照，但继续操作必须从各领域服务读取最新版本及有效授权。

本轮只完成证据核对与方案设计。具体 schema/migration、API、UI adapter 和主图 checkpoint 均由后续实施任务完成，再依据独立故障用例验收。
