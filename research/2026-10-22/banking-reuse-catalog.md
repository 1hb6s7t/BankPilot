# BankPilot 开源业务项目复用目录

**核验日期：** 2026-10-22（Asia/Shanghai；浏览时为 15:32–15:35）。本报告只依据各项目官方 GitHub 仓库、GitHub 官方文件页/Release/PR/Issue 及项目自有文档，做源码静态审阅。**没有部署、运行、联调或验收任何候选项目。**GitHub connector 在主线程未登录；本次以官方 GitHub 页面和官方仓库浅层 Git 树回退核验。公开 REST API 遇到未认证限流；没有把失败请求误记成不存在。

## 结论先行

BankPilot 的 TS React/Hono/Postgres 技术栈和“1 总控 + 6 领域 + 1 复核”组织无需被候选项目替换。首版边界是**合成理财产品**、卡状态查询/挂失/解挂和生日目标；行情接入、家庭共享授权、PIN 完整生命周期均属后续扩展，不作为首版要求。建议把 Azure 样例仅作为 supervisor/MCP/HITL/SSE 的交互参考；把 Actual 的分类、规则、预算和周期计划当作可借鉴的业务行为；Firefly III 作为转账、账单、规则与重复交易的领域参考（AGPL-3.0 带 copyleft）；Fineract 仅在确实要建设贷款、储蓄等核心银行账务时评估成独立平台服务。Maybe 的丰富交易和转账建模值得阅读，但仓库已归档停止积极维护。Stripe 的订阅样例适合作为商户侧周期收费生命周期参考；它依赖 Stripe 真实测试 API，不是离线模拟商户。

确定性执行边界：模型和领域 Agent 只能生成意图/草案；转账、扣款、挂失/解挂和合成理财申购/赎回必须由 TS 后端的确定性授权与业务校验服务执行。先按用户、账户、余额、额度、设备/会话与风险规则生成可审阅的报价/预览，再要求明确确认；确认后校验一次性授权和幂等键，以数据库事务写入审计事件、双边账务变更/执行请求并可重放核对。LLM 工具不能拥有跳过授权的直接写库/付款通道。

## 候选核验

| 项目 | 许可、归档、最新版本/代码 | 维护样本（截至核验时间） | 可借点、成本与结论 |
|---|---|---|---|
| [Azure-Samples/agent-openai-python-banking-assistant](https://github.com/Azure-Samples/agent-openai-python-banking-assistant) | MIT；全文位置为仓库根目录 [`LICENSE`](https://github.com/Azure-Samples/agent-openai-python-banking-assistant/blob/main/LICENSE)，非 copyleft。未归档。没有正式 Release（[Releases](https://github.com/Azure-Samples/agent-openai-python-banking-assistant/releases)）；最新可见提交 `17cc9fa`，2026-04-07。 | Issue [#58](https://github.com/Azure-Samples/agent-openai-python-banking-assistant/issues/58)（2026-07-23，样例浏览器目录发布失败）；另有 #56 RAG 银行业务 Agent 需求（2026-03-25）。 | `app/backend/app/agents/`、`app/backend/app/routers/`、`app/business-api/java/{account,payment,transactions-history}/`、`app/frontend/banking-web/src/`。多 Agent、MCP 业务 API、HITL 工具审批、流式对话值得借交互模式；Python + Java/Spring + Azure IaC、ChatKit 协议、容器部署与现有栈差异大。README 明示 proof-of-concept 且缺端用户认证/授权、会话与账户隔离、审计。其余额、交易记录、支付属于演示业务 API，**绝非银行核心系统**，不能直接承载 BankPilot 的真实资金或授权逻辑。成本：中（只抄交互/编排概念），若搬后端则高。 |
| [actualbudget/actual](https://github.com/actualbudget/actual) | MIT；全文位置为仓库根 [`LICENSE.txt`](https://github.com/actualbudget/actual/blob/master/LICENSE.txt)，非 copyleft。未归档。最新 Release `v26.10.0`（2026-10-02）；提交 `d1a536f`（2026-10-21）。 | 合入 PR [#9298](https://github.com/actualbudget/actual/pull/9298)（2026-10-21，Node/Electron 安全更新）。 | 精确目录：`packages/loot-core/src/server/{budget,rules,transactions,accounts,payees,schedules}/`；API 包在 `packages/api/`。分类、payee/商户归一、条件/动作规则、envelope 预算、重复 Schedule 和交易导入流程与账单清洗/消费分析最接近。Actual API 文档明确区分原始 `addTransactions` 和会跑规则的 `importTransactions`，也提供规则、预算、周期计划、分类方法。适合提炼规则 DSL、分类建议与可解释规则编辑交互；不要复制其整套本地优先账本、同步服务器、UI 和客户端存储。规则需适配人民币、账单字段、转账配对及中文商户；不提供银行真实支付执行。成本：中。 |
| [apache/fineract](https://github.com/apache/fineract) | Apache License 2.0；准确全文为根目录 [`LICENSE_SOURCE`](https://github.com/apache/fineract/blob/develop/LICENSE_SOURCE) / [`LICENSE_RELEASE`](https://github.com/apache/fineract/blob/develop/LICENSE_RELEASE)，非 copyleft。未归档。最新 Release `1.15.0`（2026-07-14）；提交 `71c3973`（2026-10-21）。 | 合入 PR [#6703](https://github.com/apache/fineract/pull/6703)（2026-10-21，Java GitHub Action 更新）；PR 列表同日仍有储蓄复利计算、批量导入校验等活跃改动。 | 读到的业务模块包括 `fineract-provider/`、`fineract-accounting/`、`fineract-savings/`、`fineract-loan/`、`fineract-charge/`、`fineract-client/`。成熟的贷款、储蓄、会计、客户/账户 API 可作为银行核心建模和账务不变量的参考。官方安全范围说明其目标是后台核心银行 API、批处理和运营人员；它不是可嵌入库，也不面向终端客户自助直连。完整引入是 Java/Spring、多模块 Gradle、租户/权限/数据库迁移/运行拓扑的独立服务工程，远超 TS/Postgres 应用模块；若仅做 BankPilot 竞赛演示会过重。成本：极高；只有业务目标升为真实核心账务平台时才评估。 |
| [maybe-finance/maybe](https://github.com/maybe-finance/maybe) | AGPL-3.0；全文位置根 [`LICENSE`](https://github.com/maybe-finance/maybe/blob/main/LICENSE)，强 copyleft。GitHub 标记已归档（2025-07-27）。最终 Release `v0.6.0`（2025-07-24），仓库最后提交 `77b5469`（2025-07-24）。 | 归档后无近期 PR/Issue 维护样本。最终发行说明 [v0.6.0](https://github.com/maybe-finance/maybe/releases/tag/v0.6.0) 明确公司将不再积极维护或接受贡献；这是停止维护的直接证据。 | 源码路径 `app/models/{rule,transaction,transfer}/`、`app/controllers/transactions/`。转账是一等模型、双边账户变动、自动识别转账并排除不应进入预算的内部流；类别/标签/商户和自动分类规则也值得参考，尤其可帮助设计“转账与消费账单分离”的状态模型。Rails/Ruby 与 TS/Hono 不匹配，归档意味着漏洞、依赖和业务规则无人维护；AGPL-3.0 也使复制改造/集成分发需先做许可审查。建议只读设计参考，不引入运行依赖。成本：中高。 |
| [firefly-iii/firefly-iii](https://github.com/firefly-iii/firefly-iii) | GNU AGPL v3；准确全文为根目录 [`LICENSE`](https://github.com/firefly-iii/firefly-iii/blob/main/LICENSE)，强 copyleft。未归档。最新 Release `v6.7.2`（2026-09-16）；提交 `b9c3100`（2026-10-17）。 | Issue [#13079](https://github.com/firefly-iii/firefly-iii/issues/13079)（2026-10-18，订阅补充来源账户字段）；[#13083](https://github.com/firefly-iii/firefly-iii/issues/13083)（10-20 草稿交易）；Issue #13084（10-21 拖拽订阅分组）。 | 读到的目录 `app/Api/V1/Controllers/Models/{Transaction,Bill,Rule,Recurrence}/`、`app/Rules/`，以及 API 请求模型对应目录。个人财务管理器包含复式交易、分类/标签、重复交易、账单、规则、预算和目标储蓄（piggy banks），能给账单/转账关联及规则处理提供领域参照。PHP/Laravel + 自有 API/领域模型，不能当 TS 组件直接装；若通过网络服务调用，部署与改造传播边界要做 AGPL 评估。建议把 API/规则数据语义抽象出来自行实现，避免复制代码；许可和结构代价高。成本：高。 |

### 商户/订阅补充候选

[stripe-samples/subscription-use-cases](https://github.com/stripe-samples/subscription-use-cases) 是 Stripe 官方样例（MIT，根 [`LICENSE`](https://github.com/stripe-samples/subscription-use-cases/blob/main/LICENSE)，非 copyleft，未归档）。没有正式 Release；最新可见提交 `fb6e9d4`（2026-05-01），公开活动例子为 2026-09-01 的 PR #1227“Fix Node subscription cancellation”（[PR 列表](https://github.com/stripe-samples/subscription-use-cases/pulls) 中仍开放）。`fixed-price-subscriptions/server/nextjs/app/api/` 有创建/更新/取消/账单预览/webhook 端点；`usage-based-subscriptions/server/nextjs/app/api/` 有订阅、meter、计量事件和 webhook。适合学习商户侧订阅状态、取消、预览和回调契约；依赖 Stripe API/密钥与 Stripe 账单语义，**不是本地模拟商户/银行扣款引擎**，不能替代银行侧扣款授权和账单入账。对 BankPilot 可作交互契约样板，不建议作为运行依赖；成本：低至中。若必须全离线，应自行写小型 deterministic fake provider/webhook fixture。

## 六个业务域映射

| BankPilot 领域 | 现成模块 / 可适配部分 | 必须自行实现和边界 |
|---|---|---|
| 转账（重点） | Maybe `app/models/transfer/` 与 Firefly 转账 API/交易链接可借双边账户、内部划转与预算排除的状态模型；Azure `app/business-api/java/payment/` 仅演示工具路径。 | Hono 授权服务、收/付款账户校验、余额/限额、收款人风险、确认令牌、幂等、数据库原子双记账、冲正/对账、完整审计。每一笔操作由规则引擎判断并执行；Agent 仅给草案。不得把对话确认等同于认证或支付授权。 |
| 账单 | Actual `loot-core/.../rules`、`budget`、`transactions` 最适合分类和规则；Firefly `Bill`、`Rule`、`Recurrence` 适合账单周期与重复交易领域参考。 | 导入银行账单格式、商户归一/别名、重复与异常判定、费用/退款对账、追溯原始行和解释原因、人民币/中文场景；转账双边项需先配对并排除消费分析，避免重复计数。 |
| 理财 | Fineract `fineract-savings/`、`fineract-loan/`、`fineract-accounting/` 提供后台产品/账户建模参考；Actual 投资账户/交易可作个人资产记录参考。 | 首版使用自有合成产品与固定/确定性模拟数据，支持展示与模拟申购/赎回；外部行情接入、适当性/真实交易执行属于扩展。六 Agent 的理财 Agent 不按语言模型建议直接下单，所有模拟交易也通过确定性校验。 |
| 卡片 | 候选均无可直接复用的卡状态查询、挂失/解挂业务模块。Actual 仅有预算对信用卡消费的分类解释。 | 首版自研卡状态查询、挂失/解挂和审计；额度/渠道管控、PIN 与凭证全生命周期属于扩展。 |
| 订阅 | Stripe `fixed-price-subscriptions` / `usage-based-subscriptions` 的商户订阅生命周期和 webhook 示意；该官方样例调用 Stripe 测试 API。Firefly `Bill`/`Recurrence`、Actual `schedules` 可作银行侧周期扣款识别/计划概念。 | 两边必须分开：订阅商户合同/价格，与客户账户周期扣款授权/暂停/撤销/失败重试/争议。Stripe 样例需要 Stripe 测试 API，不是离线模拟商户，也不提供银行侧扣款授权；后者仍需自研确定性状态和账单对账。 |
| 生日与生活目标 | Actual 预算类别与预算结转/持有、Firefly piggy bank 储蓄目标，可参考目标金额/进度与定期预算安排。 | 首版自研生日信息、生日目标记录、提醒及进度展示；家庭共享授权和更复杂的家庭协作属于扩展。候选项目没有 BankPilot 的生日目标完整工作流。 |

## 与现有架构的组合建议

把六领域 Agent 视作只读查询/结构化意图提出者，领域服务只暴露类型化、最小权限 API：转账草案、账单分类候选、理财产品信息、卡片状态提议、订阅识别与目标进展。总控负责编排；独立复核 Agent 可检查意图与参数完整性，但授权结论应由规则化后端计算，不能由复核模型代替。Hono 执行入口验证用户身份、账户归属、操作权限、风控阈值、确认 token、幂等键和版本/余额条件，然后写审计记录并提交事务；拒绝、取消、超时和重复提交都应是明确状态。跨“转账 + 账单”先做双边流水配对/转账链接，再运行规则和分类；导入重跑须幂等，保留原账单行到标准交易/分类决定的来源链。

## 静态证据明细

- 最新代码：Azure commit [`17cc9fa`](https://github.com/Azure-Samples/agent-openai-python-banking-assistant/commit/17cc9faed6c26aff37a43072607d5a58644054df)（2026-04-07）；Actual [`d1a536f`](https://github.com/actualbudget/actual/commit/d1a536f35c5a114eda0582d5a1d744a9103cc90e)（2026-10-21）；Fineract [`71c3973`](https://github.com/apache/fineract/commit/71c39730e9178301b7ab949ba711238ce81fc66d)（2026-10-21）；Maybe [`77b5469`](https://github.com/maybe-finance/maybe/commit/77b5469832758d1cbee1a940f3012a1ae1c74cd3)（2025-07-24）；Firefly [`b9c3100`](https://github.com/firefly-iii/firefly-iii/commit/b9c31006e8d3008df3d12e23de86b66088c9480e)（2026-10-17）；Stripe [`fb6e9d4`](https://github.com/stripe-samples/subscription-use-cases/commit/fb6e9d4a01bcbaea17eb3ad686e0e97e79f1def2)（2026-05-01）。日期来自官方仓库默认分支浅层 Git 树/提交元数据。
- Actual 文档列有 transactions、categories、payees、rules、schedules、budgets 等 API；`importTransactions` 会执行规则，而 `addTransactions` 用于原始写入：[官方 API reference](https://github.com/actualbudget/actual/blob/master/packages/docs/docs/api/reference.md)。
- Actual 的开信封预算/账户分类行为见官方文档：[Starting Fresh](https://github.com/actualbudget/actual/blob/master/packages/docs/docs/getting-started/starting-fresh.md)。
- Fineract README 确认它是 API-only 核心银行平台并说明开发/生产依赖；安全威胁模型列出后台核心银行、批处理、运营角色，并说明不设计为嵌入库、客户自助直连在范围外：[README](https://github.com/apache/fineract)、[SECURITY.md](https://github.com/apache/fineract/blob/develop/SECURITY.md)。
- Azure README 记录多 Agent/MCP/HITL 与安全限制（PoC，不含 app authz/用户隔离/审计）：[README](https://github.com/Azure-Samples/agent-openai-python-banking-assistant)。
- Firefly 功能、API 和 AGPL 许可说明：[README](https://github.com/firefly-iii/firefly-iii)、[LICENSE 全文](https://github.com/firefly-iii/firefly-iii/blob/main/LICENSE)。
- Maybe 最终发行说明给出归档前业务和停止维护声明：[v0.6.0 Release](https://github.com/maybe-finance/maybe/releases/tag/v0.6.0)。
- Stripe 官方 README 展示固定价/用量订阅功能和 MIT 许可：[README](https://github.com/stripe-samples/subscription-use-cases)、[LICENSE](https://github.com/stripe-samples/subscription-use-cases/blob/main/LICENSE)。

**适用性限制：**以上为截至核验日期的源码静态审阅、目录与项目自述信息。Release、提交和 Issue/PR 只能证明公开的版本/维护迹象，不能证明代码正确、安全、符合银行监管要求或适配 BankPilot；没有部署验收，也没有确认任何代码可无修改集成。
