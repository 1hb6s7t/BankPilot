# G8J 对话历史与规划恢复：独立验收口径

> 阶段说明：下文保留首轮审查时的发现和建议，描述的是修复前候选，不能用“当前发现”推断最终源码仍有 N+1 或缺少 stateVersion。G8J 已修复批量查询、状态版本、旧计划选择与消息缺页；后续静态复核未在这些限定路径确认新缺陷。动态验收又发现并修复了账户旧快照及确认响应丢失的展示问题。最终通过和未完成范围以 [G8J 验收报告](g8j-history-recovery.md)及[最终核验](evidence/2026-10-24-g8j-final-verification.json)为准；有界响应与超过 100 个聊天仍是后续事项。

本文件为只读审查与验收设计，不是通过报告。检查范围包括 `apps/api/src/conversations.ts`、对话路由、`ConversationHistory` 契约、`ConversationsPanel` / `chatState` 和现有 conversation API/process recovery 测试。没有运行 DB、云模型或浏览器，也没有修改生产代码。

## 当前发现

当前 `GET /api/conversations/:id/messages` 以 `beforeSequence` / `limit` 分页消息，但每页都返回整个会话的全部 `bp_plan_commands` 和全部 `bp_clarifications`；随后对每个 command 调一次 `commandView()`，再逐个读取 clarification，构成随会话命令数线性增长的 N+1 查询。50 条消息的响应大小因此不受 message limit 约束，长期会话中的模型运行历史、计划及失败记录也会反复发送。缩小 `commands` / `clarifications` 到当前消息页若没有独立恢复索引，会让旧 pending、running、failed 请求与 waiting clarification 从 UI 消失。

当前命令展示及合并仍主要按 `createdAt` / `updatedAt` 字符串排序。多个请求或多次状态更新可在同一毫秒内发生，updatedAt 相同会让旧状态覆盖新状态或让“最新”命令顺序依赖随机 command ID。`Conversation.version` 目前由消息追加更新，命令状态变化未必改变 conversation version；晚到的旧 history/list 响应因此可能回退 conversation 元数据。消息 `sequence` 是 PostgreSQL bigint，但 API 与契约将其转成 JS number；超过 `Number.MAX_SAFE_INTEGER` 时 cursor 精度会丢失，导致重复页或漏页。当前 sequence 唯一索引和一条会话行上的原子递增避免通常情况下的同 sequence tie，但不能消除大整数精度边界。

前端已有 generation gate 丢弃切换会话后的迟到响应、按 message id/sequence 合并页、保留用户已选的 `selectedCommandId`，并提供 `getCommand` 精确读取。继续沿用这些保护；分页后的计划入口必须始终使用那条历史消息的 command ID，不能退回到全会话最新命令。当前 API 既有分页集成测试只用 4 个请求、limit=3，验证无副作用、message 序列唯一和首包有 4 个命令；尚未证明长历史响应有界、控制事项不会因分页消失、同时间戳新旧状态不会倒退。

## 最小兼容策略

1. **分开“时间线页”与“恢复/控制索引”。** message endpoint 每次只返回一页消息及该页 message 所关联的 command/clarification 快照，按 `requestSequence`（或明确的 message sequence）关联；另提供 conversation-scoped 的 open-items/recovery 查询，返回所有必须继续操作或处理的 pending、running、failed 命令及 waiting clarifications。若这组待办也可能很大，应给它独立稳定 cursor 并由 UI 完整遍历/继续加载，不能静默截断或只取最近 N 条。不要把所有完成命令和历史 clarification 随每页重复发回。历史页看到旧请求时，可通过已有 command-by-id 端点惰性加载完整计划；页面切换不会丢失数据库中的 command。
2. **响应有界且复杂度可预测。** 对 page size `N`，时间线 API 读取消息和与之关联的 records 用固定数量批量查询（page query、bulk commands、bulk clarifications）；复杂度应为 O(1) SQL round trips，而不是每个 command 多一条 SQL。大型完整计划/模型尝试可从详情端点按需读，或以有界摘要进入时间线。一个 50 条消息页不能无界带回数千条完成命令。
3. **明确索引字段且前后兼容。** 为 command 添加稳定 `requestSequence`，由已提交的用户请求消息 sequence 赋值；澄清续问是新 command/revision，保留 `rootCommandId`、`parentCommandId` 和 revision 链接。添加单调 `stateVersion`（bigint 在 JSON 中用十进制 string），每次命令状态、result/failure、lease/attempt projection 变化时递增；不要用同毫秒 `updatedAt` 推断新旧。历史行可回填或以 `updatedAt` 作一次性 legacy fallback，写入新版本后比较逻辑只接受更大的 stateVersion。cursor 也用字符串/opaque 编码，或在 number unsafe 时拒绝，避免 bigint→number 静默丢精度。
4. **保留 conversation snapshot fence。** `Conversation.version` 负责消息集合/标题等 conversation 元数据的单调版本；命令 `stateVersion` 独立 fence 命令状态。应用 history/list 合并时只接纳更高 conversation version；command、clarification 各自只接纳更高版本。旧页只合并消息和相关命令，不得覆盖新页的 conversation 元数据、状态或用户当前选择。分页查询的消息/关联命令/clarification应来自同一 repeatable-read snapshot，避免一页内 message 与关联 command revision 不一致。
5. **统一端点语义。** `/messages` 读取不得触发 planner、claim lease、retry 或任何授权/动作；恢复只能通过相同 command ID 的显式继续/重试。`clientMessageId` 重放始终返回原 message/command，不创建第二 revision；若 command 已提交但 dispatch 前进程退出，恢复 UI 必须能从 open-items 找到 pending command，并提供原 command ID 的显式继续入口。

如果暂时不改 API 形状，安全的过渡可以保留现有 `commands` / `clarifications` 全集字段并做批量查询，同时新增 page-local 关联/active summary，再逐步切换客户端；一旦移除全集字段，必须先让 UI 从独立 open-items 索引恢复全部待处理记录，并为旧页命令保留按 ID 加载计划。不要直接将全集裁成“最近 50 个 command”。

## 可复现反例与验收门槛

### 长历史、分页关联与边界

- 建立至少 120 条请求/回复消息、超过 60 个不同 command，夹杂澄清回答形成的 root/child revision。page size 取 10；遍历所有页后按 message ID/sequence 比较数据库，证明无遗漏、无重复、exclusive cursor 向旧方向严格递减。
- 在最旧页关联一个还在 `pending` 的 command、一个 `running` 命令、一个可重试/不可重试 `failed` 命令，以及一个 `waiting` clarification；响应对每页有限制后，fresh session 首屏仍能恢复全部 open items，旧请求页能找到对应原文、command ID、revision、澄清问句和状态。对它们执行继续/重试/回答/取消时只作用于明确 ID，不新建替代任务。
- 让第一页返回后并发追加一条新用户消息/assistant 结果，再读旧页。旧页不能重复第一页的消息、跳过 cursor 前后消息、移动会话选择或以低版本回滚列表时间；下一次最新页能看见新追加记录。
- 填充数万条消息并把 `next_sequence` 推到安全整数边界附近/以上；cursor 精确、单调、可往返。若 API 暂不支持超安全整数，必须对外拒绝该范围，而不是将 `9007199254740993` 转为相邻整数继续分页。
- 同时插入多个 command，固定 clock 使 `created_at` 和 `updated_at` 相同；返回顺序仍按 requestSequence 稳定。同一个 command 的 running→complete/failure 在相同时间戳下，晚到旧响应不能覆盖新 `stateVersion`。
- 发送数百个 command 后记录 history 查询数；SQL round trips 不随命令数增长，响应字节数由 page size、该页关联详情和明确的 open-items page size 限定，而不是全历史详情总量。断言 owner/conversation scope 不得被批量 join 混淆。
- 从旧 message page 打开旧 completed plan，再让较新的 command 完成/刷新；右侧 pane仍显示所选旧 command 的结果/动作，不能偷偷换成最新计划。切换 chat、logout/login 和上一页迟到响应都不能改当前 selectedCommandId。

### 数据库故障与提交未知

- **accept transaction 在 COMMIT 前断连：** user message、sequence increment、pending command 原子回滚；planner 调用数为 0。用同一 `clientMessageId`/原始 body 重试后恰好一条 user message、一条 command、一份 continuation dispatch；改变 body 复用相同 ID 必须 409。
- **COMMIT 已成功但 HTTP 响应丢失：** 先用独立连接确认用户消息和 command 已提交，再断开客户端/杀 API；完全相同的 POST 返回原 IDs、sequence 和原 command，不重复 dispatch。若进程死在 commit 与 `launchPlan` 之间，open-items 提供显式恢复同一个 pending command 的路径，且不能创建第二个 message 或 command。
- **规划/状态提交前后断连：** 覆盖 claimed-running 状态保存、planner proposal/确定性 Core draft 已保存但 command result 尚未写回、result/assistant message commit 后响应丢失、failure/assistant message commit 后响应丢失。结果应当是同一 command 可恢复，已成功 Core draft/授权状态不会重复，assistant result/failure 以稳定 response key 只出现一次；commit unknown 不被报告成确认回滚。
- **澄清 answer 与 cancel 并发：** answer transaction 对 clarification version/status 采用 CAS；COMMIT 前故障时仍为 waiting 且无 answer/child command；COMMIT 后响应丢失的同一 answer 重放返回同一 child，只有一个 revision；两个并发 answer 或 answer-vs-cancel 仅一个胜出，失败方不能创建孤儿 command，取消不会误称取消已授权银行动作。
- **history/list 在连接故障期间读取：** snapshot query 中途后端终止时，返回明确 DB 错误而非部分 history；新连接恢复后可读到完整提交版本。池不产生未处理 `PoolClient.error`，连接释放/淘汰，不吞掉 root error，也不在 GET history 上自动接管 lease。
- 每个 commit-response-loss 测例需保存故障屏障、独立连接的 commit 观察、API退出/HTTP结果、同一用户/会话范围的消息/command/clarification/checkpoint/action 计数及恢复后计数。若使用受控 PG fault proxy，要把它与 SIGKILL/postmaster 重启分开报告；不能仅用 mock throw 代表真实断连。

## 现有能力可复用

`tests/conversations-api.integration.test.ts` 已有 message cursor 全历史重建和不触发 planner、client ID 幂等、用户隔离、expired lease recovery、clarification version/CAS 与 retry；`tests/conversations-process-recovery.integration.test.ts` 有真实子进程 SIGKILL 后 frozen proposal 恢复；`tests/g8i-database-recovery.fault.spec.ts` 的独立 Postgres 容器、fault proxy、双连接提交观察可适配到对话 transaction。前端 `GenerationGate`、message ID merge、command-by-ID 与显式同 ID retry 可直接复用，但需新增 stale-version fences 和长历史/分页联动 e2e。无需新增开源依赖。

## 当前结论边界

G8I 的真实 DB 窗口只覆盖转账授权/提供方事务与 worker restart；此前的 process crash 测试覆盖 Core draft 后的 frozen proposal，不等于覆盖 conversation accept、clarification mutation、final result append 的 DB commit unknown。当前 history API 的全会话 command/clarification + N+1 是已观察到的真实扩展性问题；过渡时不得通过静默截断来“修复”性能。新测试/实现应分别报告 message pagination、open task retention、selected historical plan、DB recovery 与界面恢复，不合并成一个长历史通过率。
