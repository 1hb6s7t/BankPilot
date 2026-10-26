# G8：持久对话、澄清续接与原命令恢复契约（设计稿）

日期：2026-10-23。本文件保留实施前契约与基线；下述“现状/未执行”描述对应设计时点。G8A 已进入实现及验证，当前状态以 [G8 验证报告](phase8-verification.md) 为准；G8B 尚未接入。契约条目不会因为局部测试通过而自动标为全部验收完成。

## 1. 可验收的目标与现状

最低交付是：用户刷新页面、重新登录或 API 重启后，可恢复服务端已接收的完整聊天文本、顺序、澄清上下文、原命令身份与待审阅动作；重试同一命令不产生第二份草稿。恢复对话不代表重新授权，恢复计划不代表已执行。

现状来自本轮直接读码，不能把这些描述当成新增功能：

| 现有位置 | 已有行为 | G8 缺口 |
|---|---|---|
| `apps/web/src/App.tsx` 的 `ChatPanel` | `useState<ChatMessage[]>` 保存欢迎语及本次组件生命周期的对话；`useExternalStoreRuntime` 负责显示 | 没有服务端聊天加载、消息确认状态、稳定的重试身份 |
| 同文件 `runPlan` | 每次调用新建 `crypto.randomUUID()`，提交单条 message | 用户刷新后重试会成为新 command；原 command 未作为对话实体保留 |
| `apps/api/src/app.ts` `/api/dashboard` | 返回当前用户最近一次完成计划，并刷新关联动作状态 | 不是完整聊天历史，不能定位全部待澄清命令 |
| `bp_plan_commands` 与 `/api/plan` | `(user_id,command_id)` 唯一；保存 message hash、proposal、result；4 分钟租约接管及 token 条件写 | 不保存原文；没有 conversation/message/revision 关系；不能把澄清回答安全关联到原请求 |
| API → Core | 先保存提案快照，再使用稳定子命令创建草稿；重放已完成命令刷新动作状态 | 必须保留，不能被对话框架替换 |
| `packages/agents/src/recovery.ts` | 隔离 schema 的真实 PostgresSaver interrupt/resume PoC | 尚未接主图；其 `approved` 布尔不是业务授权凭据 |
| `packages/agents/src/index.ts` | 当前主图 `compile().invoke(initial)` | 没有主流程 graph checkpoint；不可声称任意业务节点可恢复 |

现有 `tests/api.integration.test.ts` 已有“同参重放”“不同 message 拒绝”“草稿落库而 envelope 未保存”“过期租约隔离旧 planner”的用例；`tests/agents-persistence.test.ts` 仅证明独立图基础设施恢复。实施前扩展这些测试，不将旧测试名称当成 G8 验收结果。

## 2. 分阶段交付边界

**8A 必做：应用层持久对话及命令恢复。** 复用当前 PostgreSQL、API command journal 与 Core。完整聊天来自应用表；助手框架读取该表的投影。先实现线性聊天、原命令状态查询、同 command 重试及明确的澄清续接。无需引入第二套存储服务，也无需先把全部图改成 checkpoint 驱动。

**8B 可选、单独验收：主规划图检查点。** 只对语义解释、领域建议、独立复核等规划节点接 PostgresSaver。先满足第 8 节的版本、身份、租约与副作用隔离条件，再决定上线。不能为了显示“可恢复”而把已有 Core 动作复制到图状态中重执行。

8A 完成时应报告“完整对话和应用命令恢复通过，主图任意节点恢复仍未验收”。8B 完成后也只能声称已测过的规划节点边界可恢复，不能宣称银行调用 exactly-once 来自 checkpoint。

## 3. 身份、命令与消息命名空间

全部读写身份来自 Better Auth 服务端 session。请求体中的 `userId`、图 thread id 或授权等级不能决定 owner。建议采用下列标识，含义不能混用：

| 标识 | 含义与约束 |
|---|---|
| `conversationId` | 服务端生成的聊天 UUID；每次访问以 `(actor.userId, conversationId)` 验证所有权 |
| `messageId` | 稳定消息 UUID；用于恢复、去重和 assistant-ui 渲染，不是执行 command |
| `clientMessageId` | 客户端发送前生成的幂等键；只在已验证 owner/conversation 内唯一 |
| `rootCommandId` | 一次业务意图的逻辑根请求；澄清各版本共享它 |
| `commandId` | 一份不可变规划输入的身份；同 ID 同 payload 返回原状态，不同 payload 409 |
| `revision` | 根请求的澄清版本；由服务器在 CAS/行锁下递增 |
| `clarificationId` | 指向具体问题、候选与版本；不能仅凭“最近一条助手消息”推断 |
| `actionId/actionHash/version` | Core 的原有动作及授权绑定；独立于聊天和图状态 |
| `graphThreadId`（8B） | 由服务器计算、含应用环境/owner/conversation/root command/revision/graph version 的短 hash，不能直接使用客户端传来的 conversationId |

同一个 commandId 可以出现在两个不同用户的命名空间，二者不能读到或影响对方。单用户跨聊天复用同 commandId 时应返回绑定冲突，不能把 A 聊天动作悄悄挂到 B 聊天。

前端按真实会话 owner 和 conversationId 管理缓存；登录状态变化即清除已渲染历史、待发送队列及进行中的请求。每个异步响应带 session generation/conversation generation，旧用户或旧聊天的迟到响应不得重新填充当前 UI。`localStorage` 不能成为服务器已接收消息的权威存储，也不能包含会话令牌或授权证明。可选本地未发送草稿必须与用户隔离并明确标记“未发送”。

## 4. PostgreSQL 最小数据契约

建议新增应用表，沿用现有 pool/migrations；以下是逻辑字段，不是已经存在的 SQL：

- `bp_conversations`：`id, user_id, title, version, created_at, updated_at`，唯一 `(user_id,id)`。
- `bp_chat_messages`：`id, user_id, conversation_id, sequence, role, content, kind, client_message_id?, command_id?, root_command_id?, revision?, reply_to_message_id?, created_at`。`content` 保存可渲染文本及少量安全 metadata，不存 cookie/API key/passkey 原始响应。唯一 `(user_id,conversation_id,sequence)`、`(user_id,conversation_id,client_message_id)`（非空时）。服务端响应消息另有 `(user_id,command_id,response_key)` 唯一约束：最终答复使用稳定 final key，实际展示的失败答复绑定恢复 attempt/event ID，避免轮询重复追加，也不覆盖此前已经展示的错误。内部模型重试诊断不自动变成聊天消息。
- 扩展 `bp_plan_commands`：保留原有键和租约字段，增加 `conversation_id, user_message_id, original_message, input_version, input_hash, root_command_id, revision, parent_command_id?, clarification_id?`。原请求文本与 hash 一起保存；不能只保存 hash 后声称原命令可恢复。已有 message hash 与新输入 envelope hash 明确版本化，不静默改变旧命令语义。
- `bp_clarifications`：`id, user_id, conversation_id, root_command_id, parent_command_id, version, status, requested_slots, validated_slots, source_refs, candidate_refs, resolved_by_command_id?, created_at`。候选只引用本人的服务端实体，附必要事实版本。`status` 至少区分 waiting/resolved/cancelled/superseded。

接收用户消息、分配顺序号、创建/关联 command journal 必须同一数据库事务。事务提交以后才调用模型，不能跨长模型请求持有数据库事务。conversation 行锁或等价序列分配避免多标签页顺序碰撞。数据库故障时不得返回“消息已保存”；客户端保留同 clientMessageId 重试。

proposal/result 仍由 command journal 负责。聊天助手答复是 plan result 的显示投影，动作状态来自 Core；不得建立另一个可编辑“聊天动作状态”。最终 command result 与助手消息尽量同事务提交；若保留分段提交，必须有可证明的幂等 materializer 通过已完成 command 补齐缺失消息，读取历史不能额外调用模型或创建动作。

历史消息保留当时的文字和“截至当时”的事实；当前动作卡按 actionId 拉取最新状态。不能为了显示最新余额而篡改旧聊天文字，也不能把旧订阅快照当成仍有效的查询授权。

## 5. 接口和原命令恢复顺序

建议新增聊天端点或为现有端点增加兼容 envelope，避免一开始同时维护两套规划服务：

1. `POST /api/conversations`：创建本人聊天。
2. `GET /api/conversations` 与 `GET /api/conversations/:id/messages?beforeSequence=`：分页恢复消息、命令状态和当前待澄清引用。GET 无模型调用、无副作用。
3. `POST /api/conversations/:id/messages`：提交 `{ clientMessageId, text, clarificationId?, expectedClarificationVersion? }`。服务器确定 commandId 并先落库；返回已保存消息和 command 状态。
4. `GET /api/conversations/:id/commands/:commandId`：查询或重放已有 result；关联动作刷新为当前 Core 状态。
5. `POST .../commands/:commandId/retry`：只从服务器保存的不可变输入恢复原 command，不接受新的 message。running 且租约未过期返回可轮询状态；失败/过期走既有 token 接管；有 proposal 时必须复用，不再请求模型重写。

若选择兼容 `/api/plan`，只允许新聊天服务以同一内部 command service 调用它的逻辑，不做 HTTP 自调用。现有确认/Passkey/取消/查单端点保持唯一授权和执行入口。

断网后的客户端先按 clientMessageId 或 commandId 查服务器。未知响应不等于未接收，更不能立即生成新 UUID 重发原文本。server 已完成就展示原 result；正在运行就继续观察；可恢复失败才重试原命令。用户明确“再转一次”属于新消息、新 command 和新授权，与网络重试不同。

## 6. 澄清续接：补字段，不授予权限

最小支持面建议覆盖转账收款人/尾号消歧、缺金额，以及目标缺完整日期。其他未建模的澄清必须说明仍需完整重述，不得把任意聊天历史直接当作可信指令串。每一种支持类型都有 typed schema、原字段来源和固定验收样本。

收到原请求后，保存已验证字段、未解决字段、候选实体与来源。比如“给张伟转300元”产生 `payee` 待澄清，30000 分及原文 span 保持不变。刷新后回复“尾号3361”必须携带对应 clarificationId/version；服务端核对当前 owner、候选和版本，并仅填充请求的 payee 字段。不能把同聊天更早的金额、其他任务的姓名或模型补出的年份用于填空。

澄清回答是新消息，也是新 revision 的规划输入，拥有新的 commandId；原 commandId 不变且不可覆盖。逻辑 rootCommandId 与 parentCommandId 保留。将修改后的文本复用原 commandId 会违反现有同命令异参拒绝，应明确禁止。

推荐每次续接保存不可变输入 envelope：原请求消息 ID、回答消息 ID、待补槽位、原有已验证槽位、回答新验证槽位及来源。以 typed slot 合并构造当前规划输入；不要把历史角色文本拼成“新的用户原话”，再让模型任意覆盖金额/收款人。根请求若变更金额或对象，须走显式 revision/替换规则，并重新展示完整摘要。

同一 clarification 的两个并发回答以 version CAS 决出唯一后继；同 clientMessageId 重发返回原后继；另一个不同回答收到冲突并加载当前状态。新话题默认是新命令，不能自动吸附到旧的“等待补充”；UI 应明确显示“正在补充哪笔请求”并提供“新建请求”。“算了/取消这次请求”关闭对应澄清，不取消任何已授权动作。

生成新 revision 前检查原请求是否已生成动作：若已存在，只返回原动作或引导显式取消/重规划，不能因为澄清重放而新建第二份草稿。已授权、派发中、UNKNOWN、已成功动作不得通过聊天修订替换。旧版本澄清、旧商品版本、过期订阅授权必须重新核对；图 resume、普通聊天“确认”或恢复登录不能代替现有的动作确认/Passkey。

## 7. assistant-ui 接法与最小 UI

继续使用现有 `useExternalStoreRuntime`，把 React 本地数组改为 PG 消息的客户端投影即可。稳定 messageId、服务器 createdAt、sequence 和完成/失败/待澄清状态通过 adapter 转换。欢迎语可作为 UI 固定说明，不能在每次 hydration 时追加成一条新持久消息。初始化历史期间禁用重复发送，失败显示重新加载；消息分页不改变当前待澄清对象。

`onNew` 发送有稳定 clientMessageId 的用户消息；“查看原请求/继续补充/查询进度/重试原命令”调用应用接口。8A 没有主图 checkpoint 时不启用通用 `canResume`，不把 `onReload` 当成网络重试。官方说明 ExternalStoreRuntime 的消息状态由应用负责，通用 resume 必须继续同一 checkpoint/message，而不能通过 append/reload 伪造恢复。参见 [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)。

当前安装为 `@assistant-ui/react 0.15.30`，官网文档可能领先；实施时以已安装 TypeScript 接口验证具体可选回调。不要求为本阶段升级依赖或接 assistant-cloud。线性聊天先不开放编辑、重新生成和分支 UI，以免把“重看旧计划”误变成创建新业务动作。

## 8. PostgresSaver 接主流程的受控路线（8B）

官方 checkpointer 保存图状态及节点输出；回放 checkpoint 之后的节点可能重新调用模型或 API。`interrupt` 恢复会重新进入中断所在节点，节点内中断之前的代码也会重新运行。这是规划状态恢复机制，不是数据库与外部交易的原子提交机制。[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。

复用现有依赖和 PostgreSQL，不新建另一台数据库或再引入 durable workflow 平台。应用聊天表是 UI 历史权威；command journal 是不可变规划输入/提案/草稿关联的权威；Core 是动作/授权/占额/回执权威；checkpoint 只负责规划节点进度与缓存结果。四者职责不互相替代，checkpoint 不再维护可执行余额副本。

接入步骤：

1. 在主 planner 的 graph factory 显式注入已配置 PostgresSaver；迁移/setup 放应用启动，不在每次请求重复执行。使用固定应用 schema，租户隔离靠服务端 owner 检查及不可伪造的映射，不能把动态用户输入拼成 schema。
2. 为每个不可变 command revision 保存 graphVersion/schemaVersion、输入 digest、可信 checkpoint 引用及运行状态。节点状态包含序列化后的解释结果、领域提案、复核结果和来源引用；不存 provider 实例、信号、连接池、授权秘密。
3. 一个聊天多笔 command 不直接共用同一个可累加图状态。每个 command revision 使用独立图运行命名空间，避免 reducer 把旧 suggestions/review approval 累积进新请求。
4. 优先只 checkpoint 纯规划节点；Core 草稿创建保留在“冻结 proposal 后”的应用逻辑中，复用现有稳定子命令。授权和派发继续由 Core/Outbox/Worker 处理，不放入会回放的普通节点。
5. 同版本、同输入且合法恢复点才恢复；部署后旧 graphVersion 无兼容迁移时返回明确“需要重新规划/人工处理”状态，不能用新图静默解释旧节点。已有 proposal 则优先应用快照恢复，不因图版本变化重写。
6. **必须解决 checkpoint 写入与过期租约的 fencing。** 当前 API token CAS 只保护 `bp_plan_commands`，不会自动限制旧 graph runner 对 PostgresSaver 表的迟到写入。仅在 invoke 前检查一次 token 不够；不能接管后无条件从共享 thread 的“最新 checkpoint”恢复。实施可选“带同事务 token 条件的 saver 写入适配”或“隔离 attempt 的 checkpoint 命名空间 + 服务器 CAS 提升可信 checkpoint 引用”，但须证明读取固定可信 checkpoint、旧 attempt 无法发布为新结果、跨 attempt 恢复不会借用旧授权。尚未证明前，8B 不上线自动并发接管。
7. 初期使用同步 durability 的规划节点检查点，测试实际数据库中断和性能，再决定能否采用异步；不把默认模式当作已验收。纯 LLM 节点重试可能重复产生费用，必须记录所有 provider attempts，不能宣称模型调用 exactly-once。
8. 若用 interrupt 表达澄清，payload 是 clarificationId/version/allowed slots，不是 `approved:true`。恢复前重新检查服务端会话、revision 与当前动作状态。接口不得允许客户端提交任意 graph `update/goto/checkpoint_ns`。

8B 的数据库事务和 Core 事务不天然相同；即使图同步落盘，也不能消除“副作用完成、节点 checkpoint 未写入”的窗口。现有稳定业务 command 和原单查单仍是处理该窗口的依据。PoC 中 `failAfterResume` 只中断基础设施节点，不是银行写入故障证明。

## 9. 故障与验收矩阵

所有用例使用隔离用户/schema；记录首次失败、修复后结果，不改既有 G7 标签或结果。以下保留原计划矩阵；当前执行状态见 [G8 验证记录](phase8-verification.md)与 [G8B 恢复记录](g8b-checkpoint-fencing.md)，不能仅凭本表列出用例就当作验收通过。

| 用例 | 注入点/操作 | 必须观察到的结果 |
|---|---|---|
| H01 完整恢复 | 进行正常、失败、澄清三类对话后刷新 | 所有已接收用户/助手消息原 ID、原顺序、原文本恢复；不只 latestPlan |
| H02 重登录 | 退出并同用户重新登录 | 历史和待澄清恢复；零新增授权/动作/模型调用 |
| H03 身份隔离 | 用户 A 的 conversation/message/command/clarification ID 被 B 使用 | 404/明确拒绝；B UI 无 A 的缓存或迟到回复 |
| H04 响应丢失 | 用户消息事务已提交，HTTP 响应丢失 | 同 clientMessageId 找回原 command，只一条用户消息 |
| H05 模型进行中刷新 | command 正在规划时刷新 | 显示原 command 运行状态；不创建新 UUID 规划 |
| H06 原提案恢复 | proposal 保存后、某个 draft 创建后进程退出 | 原 command 重试复用 proposal，模型次数不增加；同动作 ID，数据库草稿数不增加 |
| H07 已完成回复丢失 | result 已保存，助手消息/HTTP 返回前中断 | 幂等补齐唯一助手消息；当前动作状态正确，无新增 draft |
| H08 同 ID 异参 | command/clientMessageId 配不同内容 | 409；旧原文、提案、动作不变 |
| H09 澄清刷新 | 同名收款人或缺金额/日期，刷新后回答 | 只补指定槽位，原金额/对象/日期来源不丢；仍待授权 |
| H10 澄清并发 | 两标签页不同回答同 clarification version | 唯一后继 revision；失败方刷新，不创建第二份动作 |
| H11 跨话题误接 | 新请求或回答另一笔澄清 | 不默认填入最近槽位；明确目标或澄清 |
| H12 旧澄清重放 | 已 resolved/superseded 的回答重发 | 同幂等键返回原结果；不同内容冲突，不派生新 command |
| H13 陈旧授权 | 恢复过期订阅 grant/卡版本/动作 hash | 重新核对或拒绝；不延长 grant，不降级强验证 |
| H14 授权边界 | 恢复文字含“确认”、graph resume 含 approved | 不产生 authorization proof/Outbox；仅现有端点可授权 |
| H15 旧 runner 迟到 | 租约过期后第二实例接管，旧实例返回 | proposal/result/chat 状态均不被旧 token 覆盖；draft 幂等 |
| H16 分页/顺序 | 多页消息、多标签页同时发送 | sequence 唯一有序；无重复、缺页或跨 conversation 合并 |
| H17 数据库中断 | 写入前/提交后断连 | 未提交不宣称已保存；提交后重试找回同 ID，不丢原文 |
| G01（8B） | 已完成一个规划分支，另一分支崩溃 | 用真实 checkpoint 恢复，验证是否复用成功分支；所有额外模型调用如实记录 |
| G02（8B） | 澄清 interrupt 后重启 | 同 owner/command/version 恢复；过期/跨用户 resume 拒绝；无授权副作用 |
| G03（8B） | checkpoint 竞争与旧 runner 写入 | 可信引用不受旧 attempt 最新写入污染；否则 8B 不通过 |
| G04（8B） | graph schema/代码版本升级 | 明确兼容或拒绝，不把旧 state 作为新图的新动作指令 |

8A 的发布门槛：身份隔离、原 command 幂等、全部受支持澄清类型与授权边界必须通过真实 PG/API 测试；浏览器刷新/重新登录/断网恢复逐条取证。模型结构测试、API 测试、浏览器验收和可选 graph crash 验收分开汇报。
