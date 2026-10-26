# 第三阶段：联系人、卡片与订阅管理契约

日期：2026-10-22（Asia/Shanghai）。本阶段在本地合成银行沙箱中补齐联系人别名、卡状态管理和订阅查询/扣款管理。余额不因这些管理动作改变；不接入真实商户、真实银行或卡组织。此文定义阶段边界与接口行为，不代表部署或验收结果。

## 范围与授权

用户必须持有 Better Auth 登录会话。API 从会话确定用户，输入不能指定用户身份；写操作沿用现有可信 Origin 检查、Zod 严格解析、用户数据隔离、动作摘要、幂等命令号、动作有效期和审计记录。管理动作授权只说明用户确认了对应的合成管理操作，不移动资金，也不替代真实机构中的验证流程。

| 动作 | 契约档位 | 授权 | 生效范围 |
|---|---|---|---|
| 保存联系人别名 | 黄档 `YELLOW` | 查看冻结动作明细后明确点击确认 | 别名绑定当前用户的一个已有合成收款人；已保存后刷新联系人，转账规划可识别此别名 |
| 查询订阅 | 黄档 `YELLOW` | 明确准备查询并确认查询动作 | 只在短时授权有效期内读取当前用户的合成订阅快照；查询不改变订阅、扣款状态或余额 |
| 商户侧取消 | 黄档 `YELLOW` | 使用有效查询授权准备候选，再核对商户和状态后明确确认 | 若 `cancellationSupported` 为真，仅把合成商户合同状态改为 `CANCELLED`；银行拦截状态独立不变，不退款 |
| 银行侧拦截扣款 | 黄档 `YELLOW` | 使用有效查询授权准备候选，再核对账户影响后明确确认 | 把合成银行扣款限制改为 `BLOCKED`；不取消商户合同，可能仍有合同义务，不退款 |
| 卡挂失 / 解挂 | 红档 `RED` | 每个动作逐笔使用与该动作摘要绑定的 Passkey 强验证；不得用普通确认代替 | 将合成卡片状态在 `ACTIVE` / `LOST` 间变更；影响该卡后续模拟扣款能力，不取消订阅 |

红档 Passkey 流程依赖原有 SimpleWebAuthn 服务器注册及认证接口和动作专属管理认证接口。服务端须验证用户已登录、可信 Origin/RP、挑战与一次性使用，并将强验证凭证绑定 `actionHash`；过期或资源版本变化时拒绝旧动作并要求重新准备。前端发起认证只负责收集认证器响应，不能自行决定成功。SimpleWebAuthn 官方服务端指南按“生成选项、认证器响应、服务端验证”分步组织注册和认证；本阶段沿用项目现有实现与约束：[SimpleWebAuthn Server 文档](https://simplewebauthn.dev/docs/packages/server)。

## HTTP API

所有接口均要求 Better Auth 会话。JSON 写入遵循现有会话、Origin、Zod 和错误响应约定；客户端的 `commandId` 用于幂等，重复使用同一编号但传入不同参数必须报冲突。候选由服务端冻结标题、明细、档位、版本、摘要和失效时间，确认时重验状态与版本。

| 方法与路径 | 输入 / 行为 | 返回 |
|---|---|---|
| `GET /api/management` | 无；只读当前用户卡片和管理动作，并返回当前仍有效的最新订阅查询授权标识（如有） | `ManagementDashboard`；不因读取该端点而授权订阅明细 |
| `POST /api/management/actions` | `{commandId, taskId?, spec}`；创建联系人、卡片、订阅查询或订阅管理候选 | `ManagementAction`；仅候选，不执行授权 |
| `POST /api/management/actions/:id/confirm` | `{actionHash}`；黄档动作确认 | 最新 `ManagementAction`；若动作状态/哈希/资源版本不符则拒绝 |
| `POST /api/management/actions/:id/cancel` | `{}`；仅取消仍有效且待批准的候选 | 最新 `ManagementAction`；不可撤销已完成操作 |
| `POST /api/management/actions/:id/authentication/options` | `{}`；为红档卡动作生成绑定动作的 WebAuthn 认证选项 | 认证选项 JSON |
| `POST /api/management/actions/:id/authentication/verify` | `{response}`；提交 Passkey assertion 并由服务端验证 | 最新 `ManagementAction`；验证失败不产生卡状态变化 |
| `GET /api/subscriptions?queryActionId=...` | 必须提供当前用户已成功确认、且授权未过期的订阅查询动作 ID | `SubscriptionSnapshot`；无效/过期 grant 拒绝，不绕过查询确认 |
| `GET /api/dashboard` | 既有 dashboard，可包含联系人别名及计划恢复数据 | 供工作台刷新联系人、动作和最近计划状态 |
| `POST /api/plan` | 既有规划输入；如果模型/脚本提出管理意图，则候选仍通过管理动作服务生成 | `PlanResult` 附带 `managementActions`；计划结果不会自动授权或执行管理动作 |

`spec` 由共享契约严格区分：`CONTACT_ALIAS_SAVE {payeeId, alias}`、`CARD_REPORT_LOST {cardId, expectedVersion}`、`CARD_UNREPORT_LOST {cardId, expectedVersion}`、`SUBSCRIPTION_QUERY {}`、`SUBSCRIPTION_CANCEL {subscriptionId, expectedVersion, queryActionId}`、`SUBSCRIPTION_BLOCK {subscriptionId, expectedVersion, queryActionId}`。未知字段拒绝。订阅变更引用查询动作，是为了让服务端确认当前用户已获得并仍持有明细访问权；同时以 `expectedVersion` 防止基于旧快照操作。

查询授权应在有限期限后失效。页面首次打开订阅区域时不展示订阅项；用户显式准备并确认一条新的查询动作后，前端才以对应查询 ID 拉取快照。成功响应带 `queriedAt`、`queryActionId`、`accessExpiresAt`。过期、读取失败或用户切换会话时，旧快照应清除并提示重新授权；新查询生成新命令 ID 和动作，不应复用已过期 grant。已取消的查询候选不会开放读取权限。

## 数据模型与状态

权威类型位于 `packages/contracts/src/management.ts`，核心写入由 `packages/core/src/management.ts` 在 PostgreSQL 事务中执行。

- `ManagementAction` 包含 `id/taskId/spec/title/details/status/tier/actionVersion/actionHash/expiresAt`，可带 `receipt` 或 `failureReason`。动作状态沿用共享 `ActionStatus`：`AWAITING_CONFIRMATION`、`AWAITING_VERIFICATION`、`AUTHORIZED`、`SUBMITTING`、`UNKNOWN`、`SUCCEEDED`、`FAILED`、`CANCELLED`、`EXPIRED`。当前管理服务在明确授权后同步完成本地合成操作并返回 `SUCCEEDED`；状态联合类型保留通用中间/失败状态，不能据此宣称每条管理动作都经过异步银行执行。
- `CardView` 保存用户/账户关联、卡名、脱敏号、`ACTIVE|LOST`、版本和更新时间。卡动作引用预期版本；成功挂失/解挂后版本递增。相关订阅版本同步递增，旧订阅快照上的操作因此会被拒绝并需重新查询。
- `SubscriptionView` 分开表示 `merchantStatus: ACTIVE|CANCELLED` 和 `bankStatus: ALLOWED|BLOCKED`。`collectionStatus` 为派生状态，可呈现卡已挂失、银行拦截或商户已取消对收款的不同影响。每项含周期金额、币种、下次扣款日期、关联卡、版本、是否支持商户取消及 `source: SYNTHETIC_MERCHANT`。
- `SubscriptionSnapshot` 包含订阅项、查询时间、查询动作 ID 和访问失效时间。服务端授权表是是否可读的依据，不能仅因 dashboard 记录某个历史 query ID 就继续放行。
- `ManagementReceipt` 记录操作号、完成时间、摘要和固定 `balanceDeltaMinor: '0'`，并按动作附上更新后的联系人、卡片、订阅或查询快照。普通管理动作列表不返回查询快照；取消/拦截动作的冻结商户明细与回执仅在该动作绑定的原查询授权仍有效时可见，刷新不会丢失确认所需的商户与金额。成功查询动作的授权重试可返回原历史回执，但不重查、不续期，保留原查询与过期时间；当前列表读取仍须通过有效 grant 检查。
- 联系人别名存储在当前用户的命名空间内，并对该用户现有联系人姓名及别名做冲突检测。保存别名不是转账，不会自动创建转账动作。

## 六领域与实现分类

| 领域 | 可复用现成模块 | 适配复用 | 必须自建 / 本阶段边界 |
|---|---|---|---|
| 转账（既有重点） | 保留当前动作哈希、会话身份、金额/风险重算、幂等、审计、PostgreSQL 与 WebAuthn 授权骨架 | 联系人别名读入现有 `PayeeView` 和规划上下文；不会替代原转账确认流程 | 转账授权、余额/限额控制和合成账本仍由确定性 Core 执行；候选项目不直接提供本项目可用的银行支付执行模块 |
| 账单（既有） | 复用现有 `FinanceService`、历史流水和账单证据/分类规则 | 周期扣款识别可参考 Actual `schedules`/规则及 Firefly `Bill`/`Recurrence` 的领域语义；结果仍标为可能提示 | 本阶段不将订阅快照自动转成账单事实，不直接修改历史流水或断言异常已成立 |
| 理财 | 无可直接落地的阶段三管理模块 | Actual/Fineract 仅作个人财务或后台产品建模参考 | 当前仅意图路由与范围说明；产品、申购/赎回、到账时间预演均留待后续，不接真实行情或真实下单 |
| 卡片 | 复用现有会话、动作确认框架和 SimpleWebAuthn；没有参考候选可直接接入卡控制模块 | 仅借鉴参考项目对权限/审计与状态转换的设计，不复制第三方卡业务 | 卡查询/挂失/解挂状态表、版本检查、审计及扣款能力联动由当前 TS/Hono/Postgres 服务自建；本阶段不是发卡或卡网络接入 |
| 订阅 | 复用管理动作、候选哈希、明确确认、查询授权与审计框架 | Stripe 官方取消文档只作为区分“取消合同”和“暂停收款”等商户语义的参考；Stripe subscription 取消可能即时或到期生效、有计费与 prorate/refund 语义，本沙箱不实现这些计费语义，也不连接 Stripe | 合成商户快照、短时 query grant、商户取消与银行扣款拦截的独立状态/版本/权限由本项目自建；银行拦截不会伪装成商户取消 |
| 生日与生活目标 | 延用已有资金计划与生活保留规则的展示/确认模式 | Actual 预算目标、Firefly 储蓄目标仅供交互与目标状态建模参考 | 生日目标的用户输入、提醒及目标记录需按后续范围自建；本阶段不新增家庭共享授权 |

复用分类沿用 `research/2026-10-22/banking-reuse-catalog.md` 的源码静态审阅结论：Actual 可提炼分类/规则/预算行为，Fineract 是完整后台核心银行平台而非轻量组件，Maybe 已归档，Firefly III 使用 AGPL-3.0，Azure banking assistant 是多技术栈 PoC 且不是银行核心。本阶段不把这些项目作为运行依赖；Stripe 仅作语义参考，无 Stripe API、密钥、账单平台或商户同步。即使比赛演示或本地运行，引用/复制开源代码时仍须保留适用许可证和版权 notice，并按第三方许可证要求处理；非商业比赛用途不自动免除 notice 义务。此项是复用治理要求，不构成要求将上述项目引入产品的理由。

本项目继续沿用 LangGraphJS、Better Auth、SimpleWebAuthn、Hono、Zod、PostgreSQL 及现有 React 工作台。LangGraph 总控、六领域角色和独立复核只提出结构化意图；联系人、卡片与订阅操作的身份、档位、数据授权、状态重验和审计由后端确定性服务处理。此阶段不引入完整核心银行系统或计费平台。

## 明确不包含

- 真实银行账户、卡组织、卡片发行、真实挂失服务、真实商户合同或外部自动取消。
- Stripe API、商户后台同步、计费/发票/退款/比例退款、争议处理和对商户合同的真实法律效力。
- 将银行拦截说成商户取消；将任何管理动作或未来节省额记为现金收入；任何订阅取消自动退款。
- 自动批准或自动授权管理建议；模型输出不得调用数据库写权限或绕过 Passkey。
- 完整核心银行替换、借贷/储蓄核心账务、真实行情/理财下单、家庭共享授权和 PIN 完整生命周期。

Stripe 文档指出商户取消与暂停 payment collection 对订阅状态的影响不同，取消也可能涉及立即生效、周期末生效、未结账项或 prorations；本文仅据此区分商户合同状态与银行侧扣款拦截，不照搬 Stripe 的计费行为：[Stripe 官方取消订阅文档](https://docs.stripe.com/billing/subscriptions/cancel)。

**验收边界：**本契约与当前接口/源码用于定义实现范围。此文不报告测试成绩；功能验收、浏览器验收、部署验收和任何真实外部机构验证必须另行记录，不能从静态阅读或类型检查推断。
