**安心办 BankPilot：开源复用与模块化决策报告**

调研日期：2026-10-22，Asia/Shanghai。基线：面向生活目标、带资金与时间约束的银行事务智能体；产品采用 1 总控 + 6 领域 + 1 独立复核 Agent；六场景覆盖，转账、账单与生日联动做深。首版为状态可变、可复位的合成银行与商户环境。

本轮由主 Agent 与三个不同模型的子 Agent 并行完成。已完成官方仓库、文档、许可证、发布/提交与维护样本核验，以及若干关键源码/目录的静态审阅；**尚未安装候选系统、跑兼容性 PoC 或完成银行业务验收**。以下是有证据的选型建议与接入计划。

**建议采用的复用组合**

继续采用 LangGraphJS + PostgreSQL + pg-boss；聊天组件复用 assistant-ui，计划图按需复用 React Flow；认证协议复用 SimpleWebAuthn，登录优先评估 Better Auth；账单规则优先适配 Actual；测试采用 Vitest + Playwright + Promptfoo，任务评测方法借鉴 Sierra τ-bench。Azure 银行助手作为角色组织、交互和服务契约参考，不整体搬入其 Python/Java/Azure 技术栈。

自研集中在：资金时间约束、任务与提案版本、业务冲突、红黄绿策略、逐动作授权、外部交易幂等与查单、六场景的具体状态语义和审计证据。这里“自研”是依托成熟数据库与库编写产品规则，不是重写数据库、密码学、队列或通用 Agent 引擎。

**一、范围、证据与筛选标准**

纳入六类候选：Agent 编排与协议；银行/预算/订阅业务；任务与账本；身份/策略；前端；可观测性与评测。主选与备选表共 26 个项目，另核对 Hono、Zod、Vitest、Playwright 等基础依赖。优先项目官方组织、基金会、维护者主仓库及官方文档，不以第三方排行榜、star 数或宣传视频作为功能证明。基础 HTTP/schema/test 工具只做用途与许可证核对，核心候选再核对源码落点和维护样本。

不扩大到模型训练平台、完整核心银行替换、全渠道 IM、真实行情、全商户浏览器代操作或任意生成代码沙箱。它们不属于当前首版的必要依赖。调研不是所有开源项目的穷举。

| 筛选项 | 本轮检查方法 | 决策规则 |
|---|---|---|
| 能力匹配 | README/官方 API + 实际目录、接口或测试文件 | 必须能说明复用到哪个模块；演示结果不等于实现边界 |
| 许可证 | 根 LICENSE + 相关包/目录 LICENSE + 企业目录 | 无明确许可不复制；MIT/Apache 优先；AGPL、商业目录逐项保留边界，不凭根 badge 推定全仓 |
| 活跃与维护 | 最近 release、默认分支 commit、归档声明、相关 PR/issue | 高频变化框架优先看近 90 天；稳定基础组件看近 180 天及维护政策。时间是筛查信号，不机械淘汰稳定项目 |
| 社区支持 | 官方文档、贡献/安全渠道、维护者参与、已合并修复样本 | star/fork 仅辅助；开放 issue 不能证明有人响应；不凭 1–3 个样本推算 SLA |
| 可靠性 | 持久化/重试/取消/恢复文档、测试落点、相关缺陷 | 影响资金/授权/恢复的未决问题必须转为 PoC 门槛 |
| 接入成本 | TS 与 React 匹配、存储模型、服务数、云依赖、版本升级路径 | 优先库依赖与薄适配器；避免为一个小能力引入整套平台 |
| 可替换性 | 是否可自托管、是否支持薄接口隔离、数据与状态可否导出 | 业务契约独立于框架；不同时维护多个顶层工作流引擎 |

证据分级：E1＝官方说明/许可；E2＝另有源码落点、维护样本；E3＝项目自己的接入与故障 PoC 通过。本轮最高到 E2，不把上游测试文件存在当作我们已通过测试。未获得的字段注明未知。GitHub 连接器未登录，公开 API 后续限流，因此结合官方网页与固定 commit 原文；原始证据在同目录及 evidence/。

**二、分类与优先级的含义**

- A 可直接复用：作为依赖使用公开接口，无需 fork 核心；仍需配置、锁版本、集成验证。
- B 需适配：已有机制或代码与目标接近，需要字段、接口、事件、存储或交互适配；明确轻量/中等成本。此处“微调”指软件适配，不要求训练模型。
- C 必须自研：本次已核验候选没有覆盖 BankPilot 具体规则的现成实现，需要自行编写该业务模块；不声称全世界不存在类似代码。
- P0：第一笔正确授权、只执行一次、可恢复的转账所需；P1：六场景与生日主线完整展示所需；P2：有触发条件再加入。

模块数量不能换算代码复用率或节省工时。少量 C 类资金规则可能比多项 A 类接入更费时间。

**三、目标功能框架逐项拆解**

| ID | 模块 | 分类 | 主选/参考 | 优先级 | 具体复用与自建边界 |
|---|---|---|---|---|---|
| M01 | HTTP、路由、SSE 接入 | A | Hono/Node | P0 | 复用服务框架；业务端点、鉴权中间件和事件协议由项目定义 |
| M02 | 类型与结构校验 | A | Zod | P0 | 复用 schema parse；金额、时间、授权、证据有效性另做业务校验 |
| M03 | 对话输入与消息渲染 | A | assistant-ui React | P1 | 复用输入、流式消息、滚动；薄 adapter 接自建后端，不引入额外 Agent 平台 |
| M04 | 明细确认与强验证卡 | B | assistant-ui 插槽 + SimpleWebAuthn browser | P0 | 中等适配：渲染服务端 PreparedAction、处理失效/撤销；客户端批准标志不等于授权 |
| M05 | 计划图与协作进度 | B | React Flow | P1 | 轻量适配：节点/边/缩放直接用；映射业务状态、证据与版本差异，默认只读 |
| M06 | 图调度、分支与并行机制 | A | LangGraphJS | P0 | 复用 StateGraph、Send、条件边、stream；不重新实现图运行器 |
| M07 | 总控与领域 Agent 运行包装 | B | LangGraph 子图；Azure 角色组织参考 | P0 | 中等适配：独立上下文、工具白名单、领域 prompts、按需激活；保持一个顶层编排器 |
| M08 | 委派、提案、证据契约与版本 | C | Zod 为实现底座 | P0 | task/invocation/proposal/planVersion、证据引用、过期结果拒收，无现成银行契约 |
| M09 | 跨领域冲突与调用预算 | C | LangGraph reducer 仅提供归并机制 | P0 | 同资金/卡/订阅冲突、任务级调用预算、截止时间、取消后结果处理 |
| M10 | 检查点与中断恢复集成 | B | LangGraph PostgresSaver、interrupt/Command | P0 | 中等适配：同线程串行写、命名空间、身份绑定、schema迁移；恢复先查业务状态 |
| M11 | 登录与会话 | B | Better Auth；已有 IdP 则 OIDC/Keycloak | P0 | 轻至中等：数据库与会话接入、主体映射、撤销检查；不重写密码/会话协议 |
| M12 | WebAuthn 注册及认证协议 | A | SimpleWebAuthn | P0 | 直接复用 challenge/origin/RPID/签名/UV 校验；保留可替换 AuthProvider |
| M13 | 逐动作授权与失效 | C | M12 仅提供认证证明 | P0 | actionVersion/hash、主体、精确金额/收款对象/费用/窗口、一次消费、撤销与到期 |
| M14 | 红黄绿与执行前策略 | C | 版本化 TS Policy；OPA 为后续评估器 | P0 | 题面风险矩阵、可信事实、累计含在途、风险升级；模型无权修改 |
| M15 | 持久存储、事务、锁和唯一约束 | A | PostgreSQL | P0 | 复用成熟数据库能力；schema、业务不变量与隔离级别由项目定义 |
| M16 | 定时、重试、任务领取 | A | pg-boss | P0 | 复用队列/调度；同事务入队能力需核对选定版本；队列成功不等于银行成功 |
| M17 | 合成银行窄账本及额度占用 | C | PostgreSQL；独立账本升级候选 TigerBeetle | P0 | 建小范围账户/双边记录/占额规则；不建设通用核心银行。真实多资产账本优先再评估成熟引擎 |
| M18 | 幂等提交、outbox、查单与回调 | C | PG/pg-boss 提供基础机制 | P0 | 稳定业务身份、同键异参拒绝、UNKNOWN查单、重复/乱序回调、终态与补偿 |
| M19 | 联系人/收款人解析与消歧 | B | Azure 收款对象与工具接口参考 | P0 | 中等：中文别名、手机号、同名消歧与归属；未确认不能保存错误映射 |
| M20 | 转账、定时转账与 AA 业务 | C | M06/M16/M18 复用基础设施 | P0 | 含本次日累计、授权、预约重检、AA请求及到账跟踪，不能代扣其他人账户 |
| M21 | 分类规则与商户归一 | B | Actual rules/payees/transactions | P1 | 中等：抽取纯规则或参考规则DSL，适配银行字段与中文商户；人工确认分类候选 |
| M22 | 账单统计与报告 | B | Actual 行为 + PostgreSQL 聚合 | P1 | 中等：月年统计、退款/内部转账排除、金额对账、原始流水追溯；LLM只解释 |
| M23 | 资金时间表与整体计划预演 | C | PG/日期与金额基础类型 | P0 | 已结算/预期到账/占额/既有支出/生活费底线；预期到账不视为可立即支用 |
| M24 | 理财产品、问卷与申赎状态 | C | Fineract仅领域参考 | P1 | 合成产品、显式问卷、适当性、份额/费用/结算日期、红档授权；首版不接真实行情 |
| M25 | 卡状态、挂失与解挂 | C | 统一策略与状态服务 | P1 | 首版只覆盖已定能力；强验证、状态变更与相关支付影响；不扩建发卡核心 |
| M26 | 已确认周期计划与续期计算 | B | Actual schedules；Stripe生命周期参考 | P1 | 中等：复用周期表达和用户确认流程；已知schedule不等于自动识别未知订阅 |
| M27 | 订阅候选识别与扣费限制 | C | 交易归一/周期规则可辅助 | P1 | 从流水推断候选、证据和确认；查询也走黄色；银行阻止扣款与合同取消分开 |
| M28 | 模拟商户报价、订单、退订 | C | Stripe样例仅API生命周期参考 | P1 | 自建小型确定性provider、可复位状态/回调fixture；不引入Stripe真实测试API作为离线沙箱 |
| M29 | 生日目标与跨域重规划 | C | LangGraph作为执行机制 | P1 | 日期、预算、订单依赖、到账冲突、定时准备/执行、方案差异与局部再授权 |
| M30 | 独立复核的业务评判 | C | 复用领域运行包装与结构化输出 | P1 | 目标完整性、证据一致性、待修订问题；复核不产生资金权限 |
| M31 | 链路遥测与模型诊断 | A | OpenTelemetry；Langfuse可选 | P1 | 复用trace/latency/error；发送前脱敏，Langfuse引入单独评估许可与部署成本 |
| M32 | 业务审计与只读回放 | C | PG事件表/独立备份 | P0 | 主体、计划/动作、策略、授权、工具、回执关联；不重执行，不用采样trace代替审计 |
| M33 | 单元、集成与浏览器测试设施 | A | Vitest/Playwright | P0 | 工具直接用；金额、权限、恢复断言自建，避免只验证界面文字 |
| M34 | 多模型/多Agent批量评测 | B | Promptfoo | P1 | 中等：自定义provider连接任务API，返回账本/授权/回执快照并做程序断言 |
| M35 | 任务环境与终态评分设计 | B | Sierra tau2-bench/当前τ-bench | P1 | 中等：借方法并改编中文人民币任务；冻结版本，改编分数独立报告 |
| M36 | 外部工具协议 | B | MCP TypeScript SDK | P2 | 有跨进程/外部服务需求再加；复用transport/schema，身份与业务权限仍在网关 |
| M37 | 银行接口适配 | B | Azure工具边界 + 官方API合同 | P0 | 中至高：统一submit/query/callback接口，验证提供方幂等和查单语义；实际API未确认，不能承诺少量改动即可接通 |

M20 的 AA、M19 的复杂别名等可随 P1 扩展；它们标 P0 是所在模块的基础转账路径先落地，并非要求第一阶段一次实现全部子功能。

**四、核心候选的选择理由与维护结论**

| 候选 | 许可/维护证据摘要 | 对 BankPilot 的判断 |
|---|---|---|
| [LangGraphJS](https://github.com/langchain-ai/langgraphjs) | 核心及PG包MIT；候选1.5.2；10月有并行/PG恢复修复活动。相关[#3078](https://github.com/langchain-ai/langgraphjs/issues/3078)仍开放，修复[#3084](https://github.com/langchain-ai/langgraphjs/pull/3084)观察时Draft | 主编排首选；先过并行失败/恢复PoC。平台商业条款不随库MIT自动开放 |
| [pg-boss](https://github.com/timgit/pg-boss) | MIT；12.38.0；10月持续提交，API快照未归档 | 首版队列首选，复用现有PG；不能保证银行HTTP副作用一次 |
| [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn) | MIT；v14.0.3；9月发行、未归档、官方协议校验源码可读 | 协议直接用；交易绑定、可信明细展示及赛事认可方式另处理 |
| [Better Auth](https://github.com/better-auth/better-auth) | MIT；v1.7.12；10月活跃、未归档；会话权威读取相关PR仍open | 首版登录候选，须验证撤销/缓存；已有银行IdP优先接现成IdP |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT；React0.15.30；10/22有LangChain消息修复合并 | 直接复用聊天基础；BankPilot业务卡与自建Hono后端适配 |
| [React Flow](https://github.com/xyflow/xyflow) | MIT；React12.12.0；10/21有内存释放修复合并；付费Pro示例独立 | 计划图适配优先，复杂图编辑器暂不需要 |
| [Actual](https://github.com/actualbudget/actual) | MIT；v26.10.0；10月活跃；源码rules/payees/schedules与需求接近 | 业务复用价值高，优先分类/周期/预算；其本地优先存储与同步栈不整套搬入 |
| [Azure Banking Assistant](https://github.com/Azure-Samples/agent-openai-python-banking-assistant) | MIT；无正式release；最后可见默认分支提交4/7，7月有问题报告；官方明确PoC限制 | 交互与架构参考，维护证据弱于通用核心库；不能当交易底座 |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | 核验根许可MIT；CLI0.124.1；10月持续发行/修复，云与企业服务独立 | 批量评测主选，适配数据库和过程断言；不以LLM judge代替资金核对 |
| [Sierra τ-bench](https://github.com/sierra-research/tau2-bench) | MIT；当前可见v2.0.0，10/20发布；持续维护 | 借任务环境/终态评分，固定版本；不照搬旧版任务数量或分数 |
| [OpenTelemetry](https://github.com/open-telemetry/opentelemetry-js) | Apache-2.0；JS v3.0.0；10月活跃 | 直接复用遥测，业务审计独立保存 |

以上版本为检索时的候选快照，不是已通过兼容测试的安装清单。特别是 monorepo 的 `/releases/latest` 可能指向子包或GitHub Action，已结合具体包源码/发布页核对 assistant-ui、React Flow、Promptfoo；不使用仓库级latest盲目锁版。

**五、备选、暂缓与排除**

| 候选 | 复用判断与触发条件 |
|---|---|
| [Mastra](https://github.com/mastra-ai/mastra) | TS整体备选；核心Apache-2.0，ee目录独立企业许可。当前LangGraph PoC若失败且无法合理规避，再比较迁移；不同时装两套主编排 |
| [OpenAI Agents SDK JS](https://github.com/openai/openai-agents-js) | MIT，轻量Agent循环/agent-as-tool备选；有非OpenAI模型适配，但并行工具与恢复须实测。首版不为角色数量引入第二套运行器 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | MIT，Python/.NET主体；若未来团队改语言或已有成熟服务可用，当前跨语言成本高 |
| [Google ADK TS](https://github.com/google/adk-js) | Apache-2.0，官方TS版本已存在；Google生态备选，按目标provider、恢复与审批来源再验证 |
| [AutoGen](https://github.com/microsoft/autogen/commit/004749e6b7102c8fd317b9b1499ce5807223c278) | 官方10/16提交已写明归档且不再维护，排除新项目运行依赖；保留历史设计参考 |
| [Temporal](https://github.com/temporalio/temporal) | MIT，成熟持久流程候选；当长期等待/复杂补偿/流程升级成为主要成本再适配。Activity仍需幂等 |
| [TigerBeetle](https://github.com/tigerbeetle/tigerbeetle) | Apache-2.0，适合专门余额/多资产/高并发账本；内部transfer不等于银行划款，生产部署与PG跨库对账增加成本。当前窄沙箱先不引入 |
| [Keycloak](https://github.com/keycloak/keycloak) | Apache-2.0，成熟IdP/OIDC/step-up；已有身份平台优先复用，首版没有必要再运营独立IdP |
| [OPA](https://github.com/open-policy-agent/opa) | Apache-2.0，策略评估器可适配；规则目前少，版本化TS更轻。多系统共享策略时再引入，额度锁仍留数据库 |
| [Langfuse](https://github.com/langfuse/langfuse/blob/main/LICENSE) | 开源部分MIT Expat，ee/web/src/ee/worker/src/ee商业许可；模型诊断可选，不能替代业务审计 |
| [Apache Fineract](https://github.com/apache/fineract) | Apache-2.0、仍活跃；是后台核心银行平台，Java/多模块/租户运维成本高，竞赛首版暂不整套部署 |
| [Firefly III](https://github.com/firefly-iii/firefly-iii) | AGPL-3.0、仍维护，PHP/Laravel；功能可参考但代码直接抽取有许可与结构成本，优先选择MIT的Actual |
| [Maybe](https://github.com/maybe-finance/maybe/releases/tag/v0.6.0) | AGPL-3.0、2025年停止积极维护/归档；排除运行依赖 |
| [Stripe订阅样例](https://github.com/stripe-samples/subscription-use-cases) | MIT，可借订单/退订/webhook契约；依赖Stripe测试API，不是可离线复位的商户模拟器 |
| [MCP TS](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/LICENSE) | v2拆包已稳定；许可为Apache-2.0/MIT贡献过渡，文档另有CC-BY条款，不能沿用“全仓MIT”。外部工具边界再引入 |

许可证判断针对已查看的版本/目录；进入代码复制或分发阶段仍逐文件保留声明与检查依赖。当前不把AGPL项目的源代码复制到主工程，也不采用受商业条款约束的企业功能。

**六、具体复用方案与接入顺序**

**编排。** `StateGraph`承担总控流转，`Send`只分发本任务所需领域；领域子图使用隔离输入/输出schema与per-invocation上下文，父图用PostgresSaver持久化。同一task的用户回复、授权恢复和定时唤醒串行进入，图内部允许领域并行。`DomainAgent.run(Delegation, ContextView) -> Proposal`作为项目接口，不让前端或业务层依赖框架原始消息结构。[Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)、[子图](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs)

`planVersion`用于计划与提案一致性；`actionVersion + normalizedActionHash`用于交易授权。新增无关查询不会让未变化动作全部重新授权；金额、对象、商品、费用、执行窗口、风险或有效期的实质变化使受影响授权失效。独立复核仅输出finding，不具备授权或付款工具。

已派发的动作保持不可变，进入UNKNOWN后继续查原单。计划修订、授权撤销或取消任务不会撤销已经发出的银行交易，也不得生成替代扣款身份；与其冲突的新动作须先确认旧动作终态，必要补偿作为独立授权操作。旧动作真实回调仍按action/operation身份去重和对账，不能因全局计划升级而丢弃。

**队列与交易。** `pg-boss`负责定时唤醒、查单、重试；用官方数据库adapter在短事务内将业务状态与job/outbox一起提交。HTTP银行操作在事务外执行；服务端保存稳定actionId/providerKey。UNKNOWN状态只查原单并保留必要占额，普通not-found不能立刻当失败。已成功动作恢复时返回原回执。框架重跑与队列重投均不得生成新扣款身份。[pg-boss事务adapter](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/docs/api/adapters.md)

策略按Asia/Shanghai业务日计算：成功金额+在途占用+本次，≤1,000元为黄，>1,000元为红；订阅查询/取消为黄，申购、挂失、解挂及首版赎回为红。额度锁须跨task按策略的累计主体与业务日串行；若按用户跨账户累计，不能因账户分开而拆散额度锁。账户余额另外锁定。UNKNOWN不释放必要占额，提交前风险升级则补强验证。同一task串行进入图，不能替代这些跨task业务锁。

**身份与强验证。** Better Auth负责登录会话；与银行已有身份系统接通时通过AuthProvider替换。SimpleWebAuthn处理协议，后端将随机challenge绑定用户/会话/动作版本/hash/有效期，强验证成功后一次性消费并产生该动作的授权。确认页面使用同一不可变动作快照。不要把登录成功、图interrupt恢复或模型输出approved等同于授权。[SimpleWebAuthn校验源码](https://github.com/MasterKale/SimpleWebAuthn/blob/787ca8209e39bc5f868a6a42f6b98a1bc1c06206/packages/server/src/authentication/verifyAuthenticationResponse.ts)

红档显式要求 `userVerification:'required'` 与 `requireUserVerification:true`，缺失UV即拒绝。普通WebAuthn并不自动提供金额/收款人的独立可信显示，也不自动满足银行交易签名或赛题强验证认可要求；协议验证、页面明细、动作绑定和认可方式分别验证。[WebAuthn签名范围](https://www.w3.org/TR/webauthn-3/#sctn-authenticator-signature)

**Actual适配。** 优先审查 `packages/loot-core/src/server/rules`、`payees`、`schedules`、`budget` 与 `packages/api`。第一步定义独立账单DTO：金额最小单位、币种、记账/交易时间、商户、内部转账关联、原始流水引用。第二步用固定fixture对照规则行为，选择纯模块封装；若抽取代码牵出大量本地存储/同步依赖，则只复用规则格式与行为规范，用小型解释器实现，不整套迁移预算应用。第三步补中文商户、退款、转账配对与用户确认；金额聚合用SQL。其已有schedule不代表自动发现订阅，候选识别单独实现。[Actual规则/API](https://github.com/actualbudget/actual/tree/master/packages/loot-core/src/server/rules)

**前端。** assistant-ui复用聊天基础，`ExternalStoreRuntime`把自建Hono事件转换成消息；交易卡从服务端读取PreparedAction。React Flow只展示任务依赖及状态，不让用户拖边改变已批准执行计划。重新生成一条回复不能重放支付。资金时间表、计划差异、事实回执使用业务数据渲染。[官方自定义状态接入](https://www.assistant-ui.com/docs/runtimes/custom/external-store)

**评测。** Promptfoo custom provider调用隔离测试任务API，固定数据/时钟/主体/模型预算。执行后返回账本、授权与回执快照，JavaScript断言核验业务终态；状态型测试关闭输出缓存或使用独立运行身份。Sierra评测仅借可变环境、过程/终态断言方法和合适任务，改编中文人民币样例单独报告。[自定义Provider](https://www.promptfoo.dev/docs/providers/custom-api/)、[程序断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)

**七、PoC与阶段放行条件**

| 顺序 | 验证内容 | 放行标准 | 对应交付 |
|---|---|---|---|
| G0 | 依赖/许可/运行环境 | 核心、checkpoint、adapter分别锁定tag和lockfile；保留LICENSE；React/Node/PG版本兼容 | 依赖清单、许可清单、可重复环境 |
| G1 | 编排并行、隔离与恢复 | 真并行可观测；私有字段不泄露；旧提案拒收；同线程串行；复现#3078等故障后无误判完成 | 输入、事件轨迹、恢复结果 |
| G2 | 第一笔转账 | 正确授权、累计阈值、金额精度、同键异参拒绝、超时只查单、成功回执可核对 | 端到端转账与故障证据 |
| G3 | Actual与前端适配 | 分类/退款/内部转账可对账；确认动作不漂移；刷新后计划与回执恢复 | 账单fixture、确认/恢复用户流程 |
| G4 | 六域与生日联动 | 赎回晚于付款日不会当现金；预算底线不突破；跨域新证据导致可追踪修订 | 六域最小闭环、正常/变化/异常三条演示 |
| G5 | 公平评测 | 同模型/工具/资金/授权/预算比较单Agent、六领域、独立复核增量；资金错误/未授权写/重复扣款零放行 | 独立保留集报告、成本与延迟 |

G0–G5尚未执行。本轮确定了要验证什么，不能以“上游写有测试”“源码看起来能用”替代这些结果。120条任务和至少40条保留集继续作为先前设计的建议规模；本轮未生成测试成绩。

LangGraph [#3026](https://github.com/langchain-ai/langgraphjs/pull/3026) 的大checkpoint修复在本次核心候选1.5.2之后合并，必须分别核对checkpoint-postgres包，不把“PR已合并”当“所有包已发布”。业务检查点应只保存小型引用，不放账单/文档大blob。

**八、多 Agent 工作拆分与模型分配**

这是实际完成本轮研究的分工，与BankPilot产品中的八个业务角色分别管理。

| 工作Agent | 实际模型/推理档位 | 子任务 | 分配理由与交叉复核 |
|---|---|---|---|
| 可靠执行/授权评审 | gpt-6-astra / high | pg-boss/Temporal、交易幂等查单、WebAuthn、身份、策略、账本、审计 | 跨系统状态与失败恢复推理最复杂、误判代价最高；主Agent复核关键授权与资金边界 |
| 编排与协议评审 | gpt-6.1-sol / high | LangGraph/Mastra/官方SDK、并行/子图/恢复、版本与许可迁移 | 需要综合代码/API/已知缺陷，适合高能力通用模型；保持业务契约与框架机制分离 |
| 业务候选资料核验 | gpt-6-luna / high | Azure/Actual/Fineract/Maybe/Firefly/Stripe的许可、目录、版本、维护样本 | 范围固定、主要为证据提取与结构化比较；主Agent复核许可、功能范围和推荐，轻量模型不独立裁决资金逻辑 |
| 主Agent | 当前会话模型 | 标准统一、前端/评测核验、模块矩阵、冲突消解和报告 | 汇合独立证据，检查首版范围漂移、重复引擎、未证实功能与版本矛盾 |

实际先并行调研，再由主Agent统一分类并要求修订：区分planVersion与actionVersion；删除业务目录中非首版的真实行情/家庭共享等扩展；更正Stripe样例与离线模拟器的区别。子Agent结果不是自动接受。

后续实施仍按依赖图并行：先由强模型负责人定义共享业务契约和状态机；契约稳定后，执行/授权、Agent编排、前端/账单适配三线并行；最后独立复核测试轨迹。资金状态、权限与迁移由高能力Agent承担；标准组件接入、fixture转换、文档/许可证清单可由轻量Agent承担。每个Agent有文件/模块所有权，避免并行修改同一核心接口。

产品运行时不必给八个角色配置八套模型。建议复杂生活目标/跨域冲突用强规划模型；已结构化账单的分类解释/查询整理先试低延迟模型；独立复核保留独立上下文和严格schema。具体产品模型待同输入任务集验证后路由，工具调用或证据保真不达标时升级，不因任务“看起来简单”就接受较弱输出。资金计算、策略和执行始终不分配给LLM。

**九、已确认的结论边界与下一步**

目前足以支持“优先复用哪些组件、如何接入、哪些必须自行实现”的决策，但不支持宣称已部署完成、六场景已验收或模型表现更好。统一银行测试API、强验证认可方式、渠道验收仍待正式要求；它们通过适配接口隔离，不影响先验证核心机制。

下一步最小工程包：M01/M02/M06/M10/M11/M12/M13/M14/M15/M16/M17/M18/M23/M32/M33，加M19/M20的基础转账路径。先用脚本化工具/模型验证不可变业务不变量，再接真实模型；不能用假回复代替运行证据。通过G1/G2后，并行扩展账单、前端、其余领域和生日主线。

**附件与证据入口**

- [编排与协议详细报告](/Users/auriel/Desktop/银行agnet/research/2026-10-22/agent-orchestration.md)：具体包/目录、官方SDK对比、版本、相关问题、PoC。
- [执行与授权详细报告](/Users/auriel/Desktop/银行agnet/research/2026-10-22/execution-security.md)：9个仓库及TigerBeetle、身份/策略/幂等/审计接口。
- [银行业务项目详细目录](/Users/auriel/Desktop/银行agnet/research/2026-10-22/banking-reuse-catalog.md)：6个项目、准确许可、源码目录和业务适配边界。
- [前端与评测详细报告](/Users/auriel/Desktop/银行agnet/research/2026-10-22/frontend-evaluation.md)：组件集成、运行时、数据库断言和固定SHA。
- [模块矩阵JSON](/Users/auriel/Desktop/银行agnet/research/2026-10-22/module-reuse-matrix.json)：由本文M01–M37逐项导出，方便后续转成开发任务。
- [证据目录](/Users/auriel/Desktop/银行agnet/research/2026-10-22/evidence/)：主Agent与编排Agent的官方响应/源码快照；执行与业务的原始证据JSON在本报告同目录。

报告中具体源链接贴近对应结论；更多版本时间、完整SHA和维护样本见各详细报告及原始证据。日期展示使用北京时间或明确标注UTC原始字段。
