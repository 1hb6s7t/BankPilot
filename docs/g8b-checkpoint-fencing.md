# G8B：PostgresSaver 租约 fencing 与输入恢复进度

日期：2026-10-23，续记：2026-10-23。本页记录 G8B 冻结版本：全仓自动化 **889/889（39 个测试文件）通过**，`tsc --noEmit` 与前端 build 通过；其中 checkpoint fencing、生产图恢复、显式重试 API、冻结输入、锁异常清理与退出排空共 **8 个文件、40/40 PostgreSQL 集成测试通过**。现在已有 checkpoint 迁移事务两个提交前 SIGKILL 窗口、生产 Planner 的 reviewer 与并行领域中断恢复，以及真实 SIGTERM/SIGINT 排空证据。后续源码与全仓结果见 [G8C](g8c-semantic-completion.md)。API 默认仍关闭恢复，需 `BANKPILOT_CHECKPOINT_RECOVERY=true` 才启用；数据库断连、提交响应未知和主机断电不在本次已证实范围。

原始全仓结果：[889 项测试报告](../evals/results/2026-10-23T06-32-23-140Z-g8b-process-tests.json)。[118 个文件的源码快照](../evals/baselines/g8b-process-2026-10-23T06-33-36-431Z/source-manifest.json)用于复核本次实现；不包含 `.env`。构建 JS 为 735.44 kB / gzip 214.55 kB，仍有单包超过 500 kB 提示。

## 为什么先做 fencing

本地安装版本是 `@langchain/langgraph 1.5.2`、`@langchain/langgraph-checkpoint-postgres 1.1.2`。源码核对发现，PostgresSaver 的 `put` 和 `putWrites` 各自开启短 PostgreSQL 事务；`getTuple` 固定 `checkpoint_id` 时仍联查该 checkpoint 的 `checkpoint_writes`。因此仅把 checkpoint 编号写入命令表，不能冻结它对应的待处理写入；调用 saver 前单独查询 lease token 也有检查与写入之间的竞态。

审查由能力分工并行完成：Agent Orchestration 核对主图生命周期、已安装 LangGraph 内部配置归一化和恢复接口；Execution Security 独立分析旧 runner 迟到写入、租约竞争和 pending writes 污染；主 Agent 实现隔离的 PostgreSQL PoC 并运行真实数据库验证。两个审查均未编辑实现文件。

本次进程验收继续并行分工：恢复 Agent 负责生产图并行分支的跨进程测试；竞态复核 Agent 检查迁移锁、Pool 排队与异常清理，并另写故障注入测试；GPT-6.1-Sol（high）负责边界明确的 SIGTERM 生命周期抽取及两条子进程集成路径；主 Agent 处理 fencing 修复、测试门槛复核、整合与统一运行。高风险锁/租约逻辑与验收条件由不同执行者交叉复核；数据库测试由主线程顺序调度，避免独立 Vitest 进程共享数据库相互干扰。这是开发协作分工，与产品的总控/领域/复核拓扑分别记录。

## 已实现的隔离证明

[checkpoint-fencing.ts](../packages/agents/src/checkpoint-fencing.ts) 保留官方 PostgresSaver 的编码、表和事务，仅增加固定 schema 内的 attempt registry 及写入触发器。每个 attempt 绑定 `userId/commandId/rootCommandId/revision/leaseToken/graphVersion/graphSchemaVersion/inputDigest` 和服务端生成的独立 `thread_id`。注册时及每次 `checkpoints`、`checkpoint_writes` 的 INSERT/UPDATE 时，数据库都锁定相应 `bp_plan_commands` 行，并逐项比较当前运行状态与绑定身份。

对于 `checkpoints` 写入，触发器在 saver 的同一事务内，以当前可信引用做父 checkpoint CAS：仅允许空引用接收根 checkpoint、当前引用作为 parent 的新 checkpoint，或当前 head 的同 ID、同内容幂等更新。已存在但不再是 head 的 checkpoint ID 无论调用方提供什么 parent 都不能重新提升；当前 ID 的 checkpoint/metadata 内容改写也会失败。attempt registry 对同一 owner/command/revision/lease 只允许注册一个 thread，且根 checkpoint namespace 固定为空。唯一索引单独创建，因此也会应用于既有 attempt 表；若迁移时检测到重复记录则明确失败关闭。对于 `checkpoint_writes`，触发器同样在 saver 事务内校验并持有 journal 行锁。lease claim 更新同一行，所以可证明以下先后关系：

- saver 先取得行锁时，它的短写事务先提交，之后 lease 才能接管；其 checkpoint 和 pending writes 是接管前的可信状态。
- lease 接管先提交时，旧 attempt 的 `put` 或 `putWrites` 拿到锁后发现 token 已变，整个 saver 写事务失败，不会改变可信引用或其关联的 pending writes。

这证明了单个 attempt 内 saver 写入和 lease claim 的事务 fencing，不证明旧 thread 可以安全复制或恢复到新 attempt。PoC 里的可选 `testLockDelayMs` 只用于制造数据库并发屏障，生产调用不得启用。

真实 PostgreSQL 验收位于 [agents-checkpoint-fencing.test.ts](../tests/agents-checkpoint-fencing.test.ts)：

1. `put` 建立可信 checkpoint，后继只沿已发布 parent 前进；用 `config=C2, checkpoint=C1` 和根 config 重放旧 C1 均被拒绝。当前 head 同 ID、同内容 UPSERT 成功，同 ID 内容或 metadata 改写失败；非空 root namespace 被拒绝，失败写入的 blob 回滚。
2. 同一 checkpoint 的 `__interrupt__` pending write 正确读回。租约更换后，旧 attempt 的新 `put`、覆盖特殊通道和追加普通通道写入都被拒绝；固定引用读取到的 state 与 pending writes 不变。
3. 用数据库屏障让 saver `put` 先锁住 journal 行；旧 `putWrites` 排队后再启动 lease 更新。前两项 saver 写入提交后接管才完成，journal 指针准确指向 checkpoint，pending write 可回读。
4. 接管事务先锁住 journal 行，旧 attempt 的 `put` 和 `putWrites` 已在数据库等待时再提交接管；两者均拒绝，指针与 pending writes 不变，失败 `put` 预写的 blob 已回滚。
5. owner、command、root、revision、lease、graph version、state schema、input digest 和运行状态分别独立不匹配时，注册均失败。同 lease 第二个 attempt 被拒绝；模拟旧表缺少唯一索引时，setup 会补索引，已有重复 attempt 则令 setup 明确失败。
6. 两个并发 child checkpoint 竞争同一 trusted parent 时仅一个能晋升；败者的 checkpoint/blob 回滚，journal pointer 指向唯一胜者。

当前该文件 **10/10 通过**，包含后续增加的跨 attempt 迁移、并行分支恢复与迁移门禁检查。它使用临时 journal/checkpoint schema 和真实 PostgresSaver，不使用真实模型或银行副作用。`put` 与 takeover 的两种锁顺序均有真实数据库交错测试。

## 接入进展与下一步

### 阶段 1：生产命令上的完整输入冻结

`apps/api/src/conversations.ts` 为既有 `bp_plan_commands` 增加 `prepared_input_version`、graph/state schema 版本、输入 digest 和 checkpoint 引用列；这些列对既有命令保持 nullable，重复迁移可安全执行。

`apps/api/src/plan-runner.ts` 在调用领域 Planner 前先完成只读准备，再用当前 lease token、命令状态和空 proposal 条件 CAS 保存完整 `PlannerInput`。快照包括账户和收款人、reference date、语义解析与模型记录、账单和资金预演、管理及投资上下文。摘要排除 attempt 专属的 `deadlineAt`；恢复会按当前时间重新生成 deadline。重试从认领时同一 `UPDATE ... RETURNING` 行读取快照，校验版本和摘要后直接复用；proposal 写入不再覆盖或截短该快照。旧快照元数据不完整时拒绝规划，旧的 nullable 记录则重新准备后冻结。转账草稿仍引用冻结的账户 ID，并要求该账户在当前 dashboard 仍可用。

真实 PostgreSQL 验收位于 [plan-runner-frozen-input.integration.test.ts](../tests/plan-runner-frozen-input.integration.test.ts)：既有旧表重复迁移保留 nullable 行；首次规划故障后的重试使用相同账单、资金、管理、投资及语义快照而只刷新 deadline；准备期间旧租约被新 attempt 接管后，旧 attempt 的冻结 CAS 失败并且不进入 `Planner.plan`；已有 proposal 即使来自旧 graph/schema 也校验 digest 与 command/task/message 绑定并沿用保存账户；篡改快照被拒绝，缺少账户身份的 legacy proposal 明确失败且不创建草稿。当前切片 **5/5 通过**，无真实模型或银行副作用。

语义解释仍发生在完整快照提交之前。如果进程恰好在语义调用完成、快照提交之前中断，重试仍可能再次调用解释模型；本切片不宣称模型调用 exactly-once。

### 阶段 2：生产 attempt 登记、启动门禁与请求排空

`scripts/setup.ts` 在 API journal migration 完成后初始化固定 checkpoint schema 中的 PostgresSaver 表、attempt registry 和 fencing triggers；API 运行时不执行迁移。LangGraph saver migration 与 fencing DDL 共用同一把 checkpoint-schema advisory lock，并在锁内重查 schema 版本。同一 Pool 的所有 schema setup 排队，相同配置的并发请求共享结果；Pool 上限至少为 2，保证持锁连接之外还有连接可运行 saver migration。已绑定的 journal schema 不允许被后续 setup 静默替换；遇到高于当前代码的 fencing 版本则拒绝修改，版本 marker 使用 `GREATEST` 防止降级。获取锁的响应失败或解锁失败时销毁该数据库连接，避免带着 session lock 返回连接池。

API 启动时通过实际解析到的 `bp_plan_commands` 关系确定 journal schema，并在监听前检查 fencing 配置绑定、必需 journal 列、Saver 表、已启用且指向预期函数的 BEFORE ROW INSERT/UPDATE triggers、删除保护，以及有效的一 lease 一 attempt 唯一索引。缺项时 fail closed。06:46 UTC 的 [全新数据库启动验证](evidence/fresh-local-database-startup-2026-10-23T06-46-53-293Z.json)已实际运行 setup、核验 schema v5、启动真实 API、检查 health 并正常退出清理。G8C 集成时也在无近期运行中命令后排空旧 API，完成本地演示库 setup 和服务更新；这是已安装依赖下的数据库与服务验证，尚非空机器复现。

`apps/api/src/plan-runner.ts` 仅在需要进入 `Planner.plan`、且完整输入已冻结或校验通过后注册 attempt。身份取自实际 journal claim：直接 `/api/plan` 保持 `root_command_id=NULL/revision=0`；聊天命令使用数据库返回的 root/revision。注册事务锁行并比较 lease、运行状态、graph/state 版本和输入摘要。接管竞态导致注册拒绝时映射为 `PLAN_SUPERSEDED`，不会进入 Planner。已有 result 重放和已保存 proposal 恢复不新建 attempt。服务端生成的 thread 与空 namespace 通过独立 `PlannerExecutionContext` 传递，不进入 `PlannerInput` 或模型上下文。

`apps/api/src/main.ts` 中的主恢复路径受 `BANKPILOT_CHECKPOINT_RECOVERY=true` 显式开关保护，默认不创建 saver、不登记 attempt，也不启用跨 attempt 恢复。开关启用时，API 用共享 Pool 创建 PostgresSaver，并将服务端 attempt context 传给生产 `createPlanner`；主图以同步 durability 保存 checkpoint。显式重试认领新 lease 后，PlanRunner 登记新 thread；若 journal 有可信旧 pointer，则在同一事务内迁移完整 lineage、所需 blobs 和 pending writes，再以 `invoke(null, {thread_id: 新线程})` 从该线程最新 checkpoint 恢复，避免显式 `checkpoint_id` 落入 replay/time-travel 语义。`PLANNER_GRAPH_VERSION` 已绑定安装的 LangGraph、checkpoint core 和 PostgresSaver 版本。

[planner-checkpoint-resume.integration.test.ts](../tests/planner-checkpoint-resume.integration.test.ts) 覆盖了生产 Planner 图跑完、proposal 冻结前模拟中断，再使用全新 PostgreSQL Pool 和 PostgresSaver 继续：图内复核节点没有重复执行，提案完成后只创建一个草稿。另一项 [agents-checkpoint-fencing.test.ts](../tests/agents-checkpoint-fencing.test.ts) 使用真实并行 LangGraph superstep 验证已完成分支不重跑、失败分支恢复后完成；同时验证旧版 v3 pending-send 迁移与原始 pending-write 顺序元数据。

[checkpoint-transfer-process.integration.test.ts](../tests/checkpoint-transfer-process.integration.test.ts) 使用真实 Node 子进程，在 checkpoint lineage 复制验证后、可信指针切换前，以及指针已在事务内切换但尚未 COMMIT 的两个位置停在 IPC 屏障，再由父进程发送 SIGKILL。父连接确认未提交目标不可见；等待旧 PostgreSQL backend 退出后，确认源指针未变、目标 checkpoint/blob/write/transfer marker 无残留，新 lease 可再次完成迁移。这证明两个提交前窗口的整体回滚，不证明 COMMIT 已生效但客户端丢失响应时的全部网络行为。

[planner-checkpoint-process-recovery.integration.test.ts](../tests/planner-checkpoint-process-recovery.integration.test.ts) 的 reviewer 中断用例运行实际生产图：第一个进程在转账领域已完成、reviewer 执行期间被 SIGKILL；第二个进程使用新的 Pool 和 Saver 恢复。完成的转账节点只执行一次，受中断的 reviewer 执行两次，最终只生成一个合成待确认草稿。它使用脚本化领域适配器和合成 Core，不验证真实云模型在该故障中的表现。

该文件的第二个用例通过真实 HTTP 对话 API 运行转账与账单并行分支：账单节点停在屏障，父进程用官方 `getTuple` 读取 journal 指向的精确 checkpoint，并确认其中 pending writes 已包含指定收款人和金额的转账提案后才 SIGKILL。全新 API 进程启动不会自动规划，测试调用原 command 的显式 retry；转账分支总共执行一次，账单分支开始两次、恢复后返回一次，复核执行一次，最终只有一个冻结提案、一个合成草稿和一条结果消息。首测曾因只检查同 thread 任意 `proposals` 行而误在成功分支持久化前终止，得到 1/2；修正测试屏障后两个用例均通过，全量回归再次通过，未放宽不重复执行断言。

[checkpoint-setup-failure.integration.test.ts](../tests/checkpoint-setup-failure.integration.test.ts) 的两个返回点故障注入用例，分别模拟已获取 session lock 但客户端收到异常、以及解锁查询尚未发送便失败。独立 observer 先确认锁确实被持有，再确认旧 backend PID 消失、锁可重新获取，最后 setup/readiness 可以恢复。它们证明异常连接销毁路径，不能当作真实网络断连或断电实验。

显式重试边界也已修正：重复 `clientMessageId` 的 `POST /messages` 只返回原接受结果，不会隐式接管过期 lease；接管只能由用户发起 retry 路由或新的明确执行请求触发。真实 API 集成测试验证 replay 保持旧 lease、Planner 不重复启动，随后显式 retry 才能换 lease 并完成命令。

生产恢复功能仍为 opt-in。提交前 lineage 迁移回滚、reviewer 中断与并行领域中断已有独立进程级证据。不能把这些已测窗口推广为任意进程或数据库故障均可恢复，也不能把适配器调用计数当成真实云模型的额外费用记录。

关闭路径抽取为生产 main 与测试子进程共用的 `apps/api/src/lifecycle.ts`：先停止 HTTP 监听，等待所有活动请求和聊天后台规划 Promise 排空，再关闭共享 PostgreSQL Pool。[api-shutdown-process.integration.test.ts](../tests/api-shutdown-process.integration.test.ts) 的两个场景分别覆盖直接 `/api/plan` 客户端断连、以及聊天已返回 202 后的后台规划。真实 SIGTERM 后新 TCP 连接被拒绝，重复 SIGTERM/SIGINT 不重复关闭；慢 Planner 放行前命令仍 running、Pool 未关闭；放行后一个待确认草稿与必要结果消息落库，Pool 只关闭一次，进程自然以 code 0 退出且数据库连接归零。无授权证明、Outbox 或合成银行出账，余额不变。IPC 已 unref，不以通信通道人为保活。

### 升级、回滚与启用步骤

1. 记录当前代码与依赖版本：`PLANNER_GRAPH_VERSION=bankpilot-planner-g8b-v2-lg1.5.2-cp1.2.1-pg1.1.2`、`PLANNER_STATE_SCHEMA_VERSION=bankpilot-planner-state-v1`、`PLANNER_INPUT_SNAPSHOT_VERSION=1`，以及 fencing schema version `5`。升级 LangGraph、checkpoint core 或 PostgresSaver 时，重新核对序列化和恢复语义，并同步 graph version；不得只改 lockfile 继续读取旧图状态。
2. 在合成演示环境停止接入并排空旧 API 后执行 setup，再启动新 API 检查 readiness。setup 还会迁移其他模块并补建合成演示账户，按现有种子逻辑保留已有余额；这不是只运行 checkpoint DDL 的专用命令。schema 相同但 journal 绑定不同、必需触发器缺失或数据库版本过新时，应修复部署配置或使用匹配版本，不能手改 marker 绕过检查。
3. 图/state/snapshot 版本不兼容时，未冻结 proposal 的命令返回 `PLANNER_SNAPSHOT_INCOMPATIBLE`，保留原输入和历史。已经冻结的 proposal 走既有版本、digest、command/task/message 绑定检查，不重新解释原文生成替代动作。需要新的规划时，由用户提交明确的新请求；保留原命令用于审计。
4. 代码回滚前检查数据库 marker 与 graph 版本。较旧 setup 不得降低数据库版本；不能把新 checkpoint 强行转换成旧图输入。数据库版本不兼容时先保持 API 停用或部署匹配版本，关闭恢复开关不能绕过启动 readiness；保留原 checkpoint/journal，完成专门迁移和对应验证后再启用。
5. `BANKPILOT_CHECKPOINT_RECOVERY=true` 仅开启规划节点恢复。记录使用的源码、迁移版本、测试报告和启动 health；命令的显式 retry、owner/revision/lease 校验、Core 授权及交易执行边界仍然适用。

### 尚未完成的恢复验收

不能据此宣称 BankPilot 主 planner 已通过任意进程故障恢复验收。后续仍必须完成：

- 数据库网络中断、COMMIT 响应未知、数据库进程或主机断电尚无故障注入证据；保持这些边界独立，不由 SIGKILL 应用子进程的结果代替。
- 图内 `interrupt/resume` 澄清路径尚未接入；当前澄清由应用的持久化 revision 流程完成。G02 图内中断后的恢复不能从上述领域/复核中断测试推导。
- 全新数据库及本地演示数据库的 setup/readiness 已补验证；当前源码完整云模型浏览器恢复流程仍需重测。并行领域测试的模型、认证与 Core 适配器是合成测试组成，不代表整个演示部署已验收。G8C 业务图版本已更新，旧未完成图仍受版本门禁约束，见 [G8C](g8c-semantic-completion.md)。

Core 草稿、授权、Outbox、派发和银行模拟调用继续留在图外。即使之后 checkpoint 恢复通过，也只说明已测规划节点边界可恢复；不代表副作用 exactly-once 或授权已经发生。
