# G4 前端与编排复用范围建议（实施前记录）

日期：2026-10-22（Asia/Shanghai）。本轮只读审阅当前 App、管理页、资金计划 UI、已有业务复用资料和上游官方文档，并规划 G4 复用边界；未修改应用、API、contracts，也未调用模型。以下是实施建议，不是阶段四验收结果。

> 本文保留实施前的调查与取舍。第四阶段现已实现，当前代码与验收状态以 [阶段契约](phase4-contract.md) 和 [验证记录](phase4-verification.md) 为准；下文的“当前”指调查时基线，提醒调度等建议不代表已经交付。

## 实施前基线与最小前端文件范围

当前“理财”在 `apps/web/src/App.tsx` 导航中标为不可用，并由 `ScopeNotice` 显示首阶段说明。现有“资金计划”页 `FundsPlanPage` 已通过 `api.funds` 展示最低生活保留、未来30日义务和服务端预演，编辑义务支持添加/删除，保存带 `expectedVersion` 并在版本冲突后刷新。转账 `ActionReview` 展示资金占用与风险档位，并串接 Passkey；`ManagementActionCard` 展示管理动作明细，也有黄档确认、红档 Passkey、取消和状态刷新。但这两张卡目前分别绑定转账 API 与管理 API，不是可以直接套用到理财操作的通用组件。

建议新增两页，再做一次很窄的 App 接线：

| 文件 | 职责 |
|---|---|
| `apps/web/src/InvestmentPages.tsx`（新增） | 合成产品列表与说明、用户持仓、赎回金额/份额预览、确认动作卡、服务端状态与到账时间线。只呈现 API 返回的模拟结算日/时间，不推导收益或保证到账。 |
| `apps/web/src/GoalsPage.tsx`（新增） | 生日目标的目标金额/日期、储蓄节奏、依赖 DAG 与“计划变化”提示。计划数字来自服务端确定性预演；保留既有资金计划页的最低余额/房租保护提示。 |
| `apps/web/src/App.tsx`（接线时修改） | 将“理财”导航启用；保留现有“资金计划”；另增“生日目标”入口和路由，传递当前账户与刷新回调。此前确认导航名字/类型前不改。 |
| `apps/web/src/styles.css`（接线时少量追加） | 复用 `business-page`、`panel`、`business-page-heading`、`button`、`notice`、`management-action-card` 等现有视觉规范，补充小屏 DAG 与到账时间线布局。 |
| `apps/web/src/api.ts`（仅 contracts 冻结后） | 为冻结的理财/目标 endpoints 增加类型化请求函数；当前不改。 |

确认卡和强验证：不应直接复用 `ActionReview`，它要求转账 payee、金额及资金预演字段；也不能直接复用 `ManagementActionCard` 的管理 API。两者已有的档位、摘要、失效时间、确认/取消、Passkey 操作视觉和反馈可以复用。最小的无逻辑重复方案是在契约冻结后抽一张回调驱动的 `SensitiveActionCard`（action summary/details/tier/hash/expiry/status + confirm/cancel/strong-auth callbacks），再用薄适配器连接投资动作；若合同动作 shape 不一致，则沿用现有样式并通过既有 SimpleWebAuthn 流程，但不另造授权规则。是否提取由冻结的动作类型决定。

不建议现在接入 React Flow 等新依赖。G4 用户需要看懂的是生日目标的阶段顺序、每一项的时间/预算依赖和变更原因；用可访问的 HTML 列表/有序步骤加 CSS 连线，足够表达一个固定的 DAG，并更适合移动视口。若以后出现多路径编辑或大量节点，再评估图编辑库。现有前端依赖已有 React、lucide-react 与 CSS。

## 理财页的数据与授权边界建议

产品和持仓只读展示应使用服务端合成数据，并显著标注“模拟产品 / 非真实行情”。每个产品只展示契约定义的本金/净值说明和风险提示；不接外部行情，不把预期收益作为承诺。申赎是独立的确定性业务状态，不是 LangGraph/LLM 的写库工具。

赎回体验建议拆成三个可审阅步骤：先选择产品与金额/份额；服务端返回当前可赎回量、费用/规则（如契约支持）、发起时间、模拟结算时间和资金保护影响；用户核对候选后确认；最终回执逐事件列出“已确认—处理中—模拟结算完成/失败”。不能因为已确认或已提交就把金额加到可用现金。只有服务端确认模拟结算进入明确终态后，资金面板才反映入账。若发生超时/未知，查原请求 ID，不创建新的赎回单。

这些是 UX 与领域边界建议；赎回档位、时限算法、费用、账户资金联动和动作状态必须由父侧 contract/backend 冻结。本页不自行设阈值或倒推出现金到帐日期。

## 生日目标 DAG 建议

目标作为用户确认的独立记录，包含至少生日日期、目标金额/用途、当前目标版本和阶段计划；将“资金准备、可选模拟赎回、模拟结算等待、目标日”显示为因果节点，并在边上解释前置条件和天数。服务端确定性逻辑负责日历、时区、可用资金/已有义务、赎回模拟到账日和方案约束；模型可以解释方案或提出备选，但不可更改金额事实、授权时间或已确认状态。

每次输入变动或新证据都应形成有版本的计划差异：例如预估赎回模拟到账日晚于目标所需日期，则显示“计划冲突/需要调整”，重新计算储蓄节奏或提示更换合成产品；旧方案不能悄悄覆盖已确认节点。预期收入/未结算赎回不可被当作当前可支用资金，任何实际资金转账继续走现有授权/账本边界。多个目标同时出现时，计划图要显示竞争资金及冲突来源，不能只生成一条无解释的总建议。

实际节点/事件 shape、动作状态、审批级别、冲突码、预测时间字段等待共享 contracts 冻结。前端按返回的 DAG/事件逐项显示，不猜测某个字段或在 UI 本地运行金融规则。

## 官方项目确认与复用判断

### pg-boss：定时唤醒和可重试任务，适配复用

工作区已使用 `pg-boss`，根依赖锁定 `12.38.0`。其官方文档提供一次性延迟 `sendAfter`、cron/RFC5545 计划 `schedule`、队列重试与退避、worker、死信队列等能力；项目 README 将其定位为建在 PostgreSQL 上的 Node 队列并声明 MIT 许可。可直接沿用现有 Worker/PG 设施做生日提醒唤醒、模拟赎回状态轮询和过期任务扫尾，减少新基础设施。[官方 jobs 文档](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md)、[queues](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md)、[workers](https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md)、[README 与 MIT 许可说明](https://github.com/timgit/pg-boss)。

使用建议：一次性生日提醒优先使用持久化的目标记录 + `sendAfter` 的具体时间；重复的周期性提醒才考虑 cron/RRULE。job payload 仅带 `goalId`、目标版本/事件 ID 等稳定引用；handler 运行时重新读数据库，验证版本、状态和用户通知偏好，再以业务事件幂等键写回提醒回执。编辑或删除目标时使旧版本任务失效，不依赖队列 payload 作为事实。pg-boss 的调度只“唤醒”工作，不承载目标 DAG 或权威计划。

pg-boss 失败自动重试适合无外部副作用的提醒/模拟步骤；操作必须可幂等。官方 worker 文档描述 worker 过期/心跳机制，并提示旧 worker 可能仍在运行而作业已重试，所以 handler 不能假设一次执行或无并发。业务状态与可恢复事件仍由 PG 服务控制；赎回模拟命令应有唯一 request/action ID 和终态检查。不要在未明确参数时只设 `retryBackoff: true`：官方 jobs API 把默认 `retryDelay` 列为 0，而退避基于该基数；本地队列配置应显式设 `retryLimit`、非零 `retryDelay`、`retryBackoff` 和 `retryDelayMax`。若该 PG 版本/场景需要死信与人工处理，也要明确 DLQ 运维路径。

### LangGraphJS：并行规划和检查点恢复，适配复用

工作区已经使用 `@langchain/langgraph` `1.5.2` 与 `@langchain/langgraph-checkpoint-postgres` `1.1.2`；`packages/agents/src/index.ts` 以 `StateGraph` fan-out 领域节点并汇总到 review，`packages/agents/src/recovery.ts` 有独立 PostgresSaver interrupt/resume PoC。现有开源复用报告确认 LangGraphJS 核心及 Postgres checkpoint 包为 MIT；不需另引第二个 Agent runtime。[官方 Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)说明 StateGraph 的并行节点在 super-step 并行执行；[官方 Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)区分 thread-scoped checkpointer 与跨 thread Store；[官方 Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)说明 interrupt 保存图状态并等待外部输入，再用相同 `thread_id` 以 Command 恢复，且被中断 node 恢复时会从 node 开始重跑。

可复用图能力：并行收集转账预算、账单、产品/赎回时间和生日目标计划所需的类型化事实；聚合为可解释的生日 DAG；由独立 reviewer 检查矛盾、缺证和时间约束；使用 checkpoint 恢复长流程的规划/说明状态。利用现有 Zod schema 和 reducer 管理分支结果。输入、资金约束和批准动作版本必须冻结并能辨别旧计划，恢复请求用稳定 thread/plan 关联，而不是再次生成一个新的候选。

边界：interrupt 是图执行控制机制，不等于资金授权或 Passkey。用户确认/强验证仍走 Hono API、动作哈希和服务端执行核心；LangGraph resume 数据只是用户输入，必须重新经过 deterministic contract/authorization gate。checkpointer 保存图快照，不替代生日目标、资金、持仓、赎回进度、审计或定时任务的业务表；长期跨计划事实在 Postgres domain tables 管理。图 node resume 会重入，node 内副作用必须避免，写业务事件优先放确定性 API/事务层。checkpoint 只保存轻量 ID/摘要，保留策略待定，不塞完整账单或敏感流水大对象。

## 文件与依赖决策

第一步等父侧冻结投资与生日目标 contracts，再新增 `InvestmentPages.tsx` 和 `GoalsPage.tsx`。前端路由与导航只改 `App.tsx`，新卡片/移动布局只追加 `styles.css`。`api.ts` 只在冻结接口后增请求函数。优先复用现有账户/资金事实、时间格式、错误状态样式、refresh pattern 和 Passkey API；不另引完整银行核心、计费产品或 workflow scheduler。

不新增 NPM 依赖；继续使用现有 pg-boss 与 LangGraphJS。需要呈现时序/DAG用 HTML/CSS 即可。完整业务执行逻辑、状态迁移、赎回到账计算和生日提醒合规时区处理由 server/contracts 决定，UI 不做影子实现。

## 建议的实现前验证清单

- 并行领域输出乱序、一个领域失败和 reviewer 否决后，前端状态与确定性事实仍一致。
- birthday date/目标金额/资金策略版本改变后旧计划候选失效，UI明示差异与重算原因。
- 模拟赎回只按 action ID执行一次；worker 超时/重试后仍能恢复到原单；未结算金额不进入可用余额。
- 截止生日日期前结算、恰好卡 cutoff、已超过 cutoff、目标延期/删除、时区跨日、重复提醒等模拟固定测试。
- 刷新页面恢复目标 DAG、赎回时间线和 action；恢复不是重新生成计划或授权。
- 小屏上图以顺序步骤/可滚动时间线呈现，风险卡和主操作始终可见；键盘可遍历并有状态文字，不只用颜色区分。

这些是未来验证条目，不是当前通过的测试。G4 的业务正确性和浏览器验收需另行报告。
