# G9E 订阅查询授权后的原请求接续设计

状态：只读代码调查与实现建议；尚未实现、迁移或验证。范围是聊天中明确要求取消商户订阅或阻止银行扣款、当前没有可用订阅查询授权的请求。查询仍须用户单独黄色确认，后续取消和阻止仍须各自确认。本设计不改变 G9D 冻结评测或结果。

## 当前断点

1. `apps/api/src/planning.ts` 的 `prepareRecognitionInput` 只从 `management.dashboard().subscriptionQueryActionId` 读取短时快照；无 grant 时 `managementContext.subscriptions` 缺席。`packages/agents/src/semantic-intent.ts` 的 `catalog` 仅从该快照收录订阅实体，`validateSemanticIntent` 对取消/阻止使用 `requireEntity('subscription')`。因此具名原请求可能在进入 `resolveSubscription` 的“先提出 `SUBSCRIPTION_QUERY`”分支前变成语义澄清，不能把现有 resolver 单测等同于完整 API 路径。
2. `packages/agents/src/management.ts` 的 `resolveSubscription` 和 `management-batch.ts` 能在无有效快照时提出单个查询候选；它们没有保存“查询后继续哪条原请求”的身份。`apps/api/src/plan-runner.ts` 只把 `managementSuggestions` 逐项准备为动作，并将当前命令完成。`packages/core/src/management.ts` 的 `authorize` 对查询动作创建五分钟 grant，但不触发原请求续办。
3. `apps/api/src/conversations.ts` 的 `bp_plan_commands`、`bp_chat_messages` 和澄清版本支持命令恢复，但澄清只接受转账/目标字段。聊天 history/recovery 当前用 `user_message_id` 对应 `role='user'` 校验待恢复命令；自动子命令不能用一条伪造的用户消息充当新请求。`apps/web/src/ConversationsPanel.tsx` 只在运行、待提交或待澄清时轮询；查询候选完成后，确认查询动作的 `refreshAll` 只刷新 dashboard 和管理列表，不会启动聊天接续展示。
4. `packages/core/src/preparations.ts` 保存的是单个已验证管理 spec 的准备请求，不能代表尚未授权查询、尚未确定订阅 ID 的原自然语言任务。`apps/worker/src/main.ts` 当前只消费转账和理财队列，没有 planner/management 接续执行器。

## 最小完整流程

```text
原用户消息（原文与 messageId 持久化）
  → 仅识别可等待查询的订阅写意图，冻结每个原文任务范围和操作
  → 准备一个 SUBSCRIPTION_QUERY 候选，标记原任务 WAITING_QUERY
  → 用户确认查询；Core 原子创建短时 grant
  → 服务端以同一原文和所绑定的 queryActionId 自动启动子规划命令
  → 用当前授权快照重新绑定全部订阅对象并核对冻结的任务数、顺序、操作、范围
  → 全部核对成功才准备取消/阻止候选，分别等待本人确认
```

“自动”只适用于**查询确认后的规划和候选准备**。不能代替用户确认查询，也不能自动授权或执行取消/阻止。若查询未确认、过期、撤销，或任何原任务没有被完整核对，保持原任务可见并停止写候选。显式查询请求仍只查询，不因为已有原任务而附加写操作。

### 1. 无 grant 时的窄范围入口

- 在 `plan-runner.execute` 调用常规语义解释前，增加服务端专用的 `recognizePendingSubscriptionWrites(originalMessage)` 路径。复用 `subscriptionRequestClauses` 的原文范围处理，但将它仅作为候选入口；最终必须验证明确的取消或银行阻止意图、非否定/撤回/引用/假设、每个范围的完整覆盖和不重叠。返回最多八个 `{operation: 'subscription_cancel'|'subscription_block', source:{text,start,end}}`，其中 `text === originalMessage.slice(start,end)`。此时不产生订阅 ID、版本或写 spec，也不通过商户名称推测身份。混合其他领域、同一对象连续变更或无法确定操作的请求沿现有澄清路径，不静默删掉其余任务。
- 将这个 **待授权意图** 与正式 `SemanticPlan.status='ready'` 区分。建议在 `packages/contracts/src/index.ts` 增加服务端专用 `SubscriptionQueryPrerequisite` 契约，并在 `bp_plan_commands` 保存版本、原文 SHA-256、来源范围/操作及摘要。`semantic-intent.ts` 的结构化提取可提供原文范围，但仍由确定性校验拒绝新增、丢失或改写操作；无 grant 不把无法识别的商户强行绑定成 catalog 实体。
- 该分支只生成一个 `SUBSCRIPTION_QUERY` 待黄色确认动作和可信、无订阅事实的提示。“原取消/阻止请求仍在等待查询授权，尚未办理”必须写入公共结果。不要用模型生成的 `canonicalMessage`、新文本或“查询订阅”替换 `original_message`/`planning_input.message`。只有原始用户消息可作为续办输入。

### 2. 持久接续与触发

- 在 `apps/api/src/conversations.ts` 迁移增设 `bp_subscription_continuations`，至少含 `user_id,conversation_id,source_command_id,source_user_message_id,root_command_id,original_message_sha256,prerequisite_version,prerequisite_digest,query_action_id,grant_cycle,state,state_version,successor_command_id,lease_token,lease_expires_at,last_error_code,created_at,updated_at`。主键 `(user_id,source_command_id)`，查询动作与子命令各有唯一约束。`source_user_message_id` 必须指向同 owner、同 conversation 的真实原始 `role='user'` 消息；原文从原命令读取，不再复制成另一条“用户请求”。继续所需的范围/操作存为受版本和摘要约束的服务端 JSON，不能由浏览器提交或改写。
- `plan-runner` 已在管理动作准备后调用 `conversations.onComplete`，可在完成原 query 计划的同一 DB 事务把 `query_action_id` 和 source command 绑定到上述记录。动作创建早于计划事务时的崩溃由现有确定性 `mgmt-plan:` commandId 及重试恢复；禁止把一个不匹配的 query action 绑定到原请求。
- 查询 `management.authorize` 仍只做原有授权事务。`/api/management/actions/:id/confirm` 在成功后可立即唤醒接续调度，但**不能把 HTTP 回调当唯一触发**。API 进程启动和有限周期扫描 `WAITING_QUERY` 记录，按精确 `query_action_id` 查到已成功查询动作和有效 grant，再用短租约/CAS 领取；在授权已提交但响应丢失、进程崩溃或刷新后仍能接续。当前 worker 不含 planner，先在 API 侧复用现有 `backgroundPlans`/`planRunner`，不扩大转账/理财 worker 的执行范围。
- 成功领取时创建一个服务端子 `bp_plan_commands`：`parent_command_id=source_command_id`，`root_command_id` 保持，`revision` 单调，`original_message` 和 `planning_input.message` **逐字等于原文**，`message_hash` 与原命令一致；新的 `commandId` 与 `(source_command_id,grant_cycle)` 唯一绑定。追加 `role='assistant', kind='continuation'` 的短消息“查询已获授权，正在按原请求核对”，指向子命令。它是系统事件，不是用户又说了一遍。`ConversationPlanningInput`/`ChatMessage.kind`/history/recovery 要认识这个来源；尤其 recovery 的“必须有 user 消息”检查需验证子命令指向的原始用户消息与 continuation 系统消息，不能简单移除 orphan 检查。`latestCommandId` 和聊天 UI 必须选择这个子命令并在刷新/重登后呈现。

### 3. 用精确 grant 重新核对原任务

- 给 `prepareRecognitionInput` 增加仅由服务端传入的 `subscriptionQueryActionId`，调用 `management.subscriptions(actor, boundId)`，不得退回 dashboard 的“最新 grant”。回执 `queryActionId` 必须等于记录绑定值，owner、动作 `SUCCEEDED`、类型 `SUBSCRIPTION_QUERY`、有效期均由 Core 再验。两个并发查询 grant 不能互换。
- 子命令在当前快照上对**原文**重新做语义识别。用冻结的 pregrant 范围与操作逐一比对新 `SemanticPlan.tasks` 的数量、顺序、原文 span、`subscription_cancel`/`subscription_block` 类型；仅接受与快照唯一对应的订阅 ID。重复同名、多目标歧义、未知商户、操作不支持、语义模型漏项或额外项，都不发布部分写候选。正式候选须带 `subscriptionId,expectedVersion,queryActionId`，继续交给 `resolveSubscription`/`resolveSubscriptionBatch`、独立 reviewer 和 `management.prepare` 核对。
- `bp_plan_commands` 的 recognition/semantic/prepared 快照可能含过期订阅事实。子命令每次继续、读取冻结快照、恢复 checkpoint、模型派发、准备 spec 前，必须重新检查绑定 grant 的有效期；过期后不能继续使用旧快照或将旧 spec 改绑到新 grant。`management.prepare` 与 `authorize` 的现有 grant/版本复核保留为最后防线。
- 对多项订阅，当前 `plan-runner` 顺序调用 `management.prepare`，第二项失败可能留下第一项候选。若 G9E 要宣称多项完整接续，需在 `ManagementService` 增加同一 owner 事务内“全部 evaluate 后一起插入”的 `prepareBatch`，每项独立确定性 commandId/确认卡；或将第一片明确限制为单项，并在多项时保留原请求、给出明确“尚不支持自动接续多项”的状态，绝不能只办第一项。现有 `resolveSubscriptionBatch` 对同目标/混合查询的拒绝和已满足项 no-op 规则继续适用。

## 状态、时效与隐私

| 状态 | 服务端动作 | 对用户显示 |
| --- | --- | --- |
| `WAITING_QUERY` | 原文和任务范围已冻结，只有查询候选；不读取订阅快照 | 等待本人确认查询；原取消/阻止尚未处理 |
| `PLANNING` | 精确 grant 验证后 CAS 领取，按原文规划 | 正在按原请求核对；不会自动授权写动作 |
| `WRITE_PREPARED` | 全部可执行候选已提交；每项等待独立确认 | 显示各确认卡及无操作项 |
| `NEEDS_QUERY_REAUTH` | 查询取消、过期或恢复时过期；不复用旧快照/旧 spec | 原请求仍保存，须重新明确确认查询 |
| `NEEDS_CLARIFICATION` / `UNSUPPORTED` | 无唯一目标或商户不支持取消；零写候选 | 指出哪项未能核对；不偷偷改成银行阻止 |
| `FAILED_RECOVERABLE` / `STOPPED` | 同一子命令可显式恢复，或用户终止续办 | 可查询状态；不会因刷新重复创建候选 |

重新查询须建立新的 `grant_cycle`、新 query 动作和新子命令，不能延长旧 grant 或改写已准备 action 的 `queryActionId`。Core 的查询 grant 默认五分钟，管理动作默认十分钟；即使写确认卡仍在十分钟内，所绑定 grant 已过期时不得确认，需重新查询、重新核对版本并准备新的确认卡。已成功的相同最终状态可作为无操作结果，不发第二个资金或管理动作。`(user_id,source_command_id,grant_cycle)` 的 CAS/唯一键、准备动作的确定性 commandId、原 `management_actions` 的 `(user_id,command_id)` 防重、授权证明去重共同覆盖重复确认、响应丢失和并发刷新。

`ManagementAction.details` 已按原 grant 遮挡；续办的 `PlanResult.summary/events/findings/evidence/diagnostics` 和聊天 assistant 文本也可能包含商户事实。建议查询计划和续办完成消息只保存可信、无商户/金额的状态句，受保护详情仅从 Core 的有效 grant 投影。若保留完整内部结果，`GET /api/conversations/.../commands`、history、`/api/dashboard.latestPlan` 和实时事件必须统一按**绑定 grant**清理，不可只遮挡 action card。快照和原任务范围不进入不受控日志；授权后 UI 明确标注其合成数据与短时权限。

## 待改函数与验证边界

| 模块 | 具体变更 |
| --- | --- |
| `packages/agents/src/semantic-intent.ts`, `intent.ts` | 增加受限 pregrant 原文范围/操作识别；保留现有正式 `validateSemanticIntent` 的实体绑定，授权后全任务重新核对。 |
| `packages/contracts/src/index.ts`, `conversations.ts`, `management.ts` | 服务端 prerequisite 与公开 continuation 状态契约、系统消息 kind、精确 query grant 参数；不接受客户端提交 trusted semantic 或 grant。 |
| `apps/api/src/plan-runner.ts`, `planning.ts`, `planning-journal.ts` | 查询前置分支、原命令绑定、精确 grant 的冻结/恢复校验、原文子命令、全部任务核对、写候选准备与隐私投影。 |
| `apps/api/src/conversations.ts`, `app.ts`, `main.ts` | continuation 表迁移、CAS/租约、确认后唤醒及启动扫描、history/recovery/latest 关联、明确停止或重新查询接口。 |
| `packages/core/src/management.ts`, `preparations.ts` | 保留 Core 的 owner/grant/version/独立确认；若覆盖多订阅，增加事务性 `prepareBatch` 与逐 spec 准备记录。 |
| `apps/web/src/ConversationsPanel.tsx`, `chatState.ts`, `ManagementPages.tsx`, `App.tsx`, `api.ts` | 展示原请求的等待查询→自动接续→各写候选状态；确认查询后刷新聊天；刷新/重登从服务端恢复；过期时只显示重新查询入口。 |

测试按层分别落地：纯测覆盖否定、引用、问句、混合领域、范围漂移、同名/未知商户、取消与银行阻止区别及多项不漏；真实 API/PG 测首轮无 grant 查询候选、确认后自动子命令、原文字节与 source FK、失联/重启/双确认幂等、过期边界、跨用户隔离、第二项失败不产生部分候选；浏览器测刷新/重登/导航后原请求及授权阶段仍可恢复、没有自动写授权、过期后隐藏商户事实。受控模型与真实模型结果需另记，单测或 query 动作成功都不足以声明完整接续。
