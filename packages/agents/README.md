# BankPilot G1/G2/G3 Agent 编排

`createPlanner(options?)` 实现共享 `Planner` 契约，使用真实 `@langchain/langgraph@1.5.2`。条件边将按需激活的领域节点放入同一 superstep 并行运行，之后进入独立 reviewer。当前实现转账意图与结构提案、确定性账单报告解释、资金保护预演解释，以及卡片和订阅管理提案；理财业务尚未实现，不会为凑齐角色而伪造运行。

默认 `mode: scripted` 是可重复的基础设施验证适配器，摘要明确标注“非真实 LLM”。可选真实模型路径只读取显式 BankPilot 配置：

- `BANKPILOT_MODEL_BASE_URL`：根站自动补 `/v1`；已有 `/v1` 不重复，例如 `https://ai.anna.tf`。
- `BANKPILOT_MODEL_NAME`：明确选择的模型。
- `BANKPILOT_MODEL_API_KEY`：仅使用为本项目提供的值；不读取其他供应商密钥或用户已有配置。
- `BANKPILOT_MODEL_OUTPUT_MODE`：默认 `tools`；`json_object` 必须显式选择并使用相同 Zod 校验，没有自动降级。
- `BANKPILOT_MODEL_TIMEOUT_MS`：每次尝试超时，默认 60000，最大 120000。
- `BANKPILOT_MODEL_MAX_ATTEMPTS`：默认 2，最大 3；仅对网络、超时、408、429、5xx 等瞬态失败重试。

模型路径始终保留 `mode: model`；请求或结构校验失败会阻止转账建议并报告错误码，不返回冒充模型成功的 scripted 结果。`PlanResult.modelRuns` 记录每次尝试的角色、模型、状态、耗时、供应商 token 数据和错误码。输入 token 为 0 或缺失不能推导实际无输入或零费用；本模块不估算成本，也不记录 API key、请求头或 `.env`。

转账金额以整数分处理；收款人只能从保存名单匹配，同名须银行或尾号消歧。`300或500`、`300、500元`、`300和500元`、`300 or 500元`、`300/500元` 及中文并列金额必须澄清；`1,234.56元` 保持单一金额。模型返回的金额和收款人必须与确定性解析一致。模型只提出建议，权限、动作哈希与执行由 Core/API 网关负责。

transfer 必须返回结构化 `suggestion`，仅在 summary 描述收款人和金额会被拒收。reviewer 的 `approved` 只判断提案完整性及证据一致性，表示可进入待确认草稿和 Core 鉴权；红档、待人工确认或需要强验证本身不构成拒绝理由，真实证据问题仍可否决。`PlanResult.diagnostics` 保存领域有无 suggestion/clarification、接收状态，以及 reviewer 原始决定、说明和最终有效决定，区分缺提案与审核否决；事件按实际通过、未通过或失败展示。

账单节点使用传入的 `BillReport`，保留期间、合成数据来源、确定性收入/支出/净额、分类和 finding 交易引用。支出分类仅包含 OUT；上月对照交易放在 `evidenceTransactions`，周期提示保持“可能”，不把同额同商户自动当作已确认订阅。没有报告时明确说明缺失，不以余额冒充账单。

房租、生活费、不影响、余额、预算等表达会激活 goal。该节点解释服务端 `FundsPreview`，不由模型重新计算或覆盖金额和 `allowed`。`allowed=false`、预演金额/账户与转账不一致，或涉及预算的转账缺少预演，都会产生确定性 findings 并阻止资金建议。报告和预演原样附在 `PlanResult`；事实摘要与证据由服务端渲染，模型自由说明单独标为 `model-explanation:*`，不用于决定资金可行性，也不传给 reviewer。

卡片查询直接展示传入的已授权事实，不生成动作；挂失/解挂只对唯一卡片生成绑定 `expectedVersion` 的结构提案，否定句和操作说明不生成写操作。订阅显式查询始终生成 `SUBSCRIPTION_QUERY` 黄色确认请求；取消或银行扣款限制在缺少有效查询快照时也只提出查询，不能读取未授权明细。有快照后仍须唯一商户、单一操作，并绑定资源版本和 `queryActionId`。取消商户订阅与阻止银行扣款是不同操作，不能相互替代。最终权限、快照有效期、强验证和业务结果由 Core/API 检查与返回。模型的必填 schema 和确定性比较禁止新增、替换或修改管理目标；模型失败或 reviewer 否决不产生可执行提案。scripted/model 均使用同一份确定性事实摘要和证据。

局部上下文不广播完整对话、账户或收款人列表；账单分支不获取转账收款人/金额，账单及上月对照数据去除账户 ID。goal 不获取账户 ID；reviewer 仅接收必要提案、拒收记录与最小资金/账单事实，不接收完整账单、完整预演或义务明细。全局 `planVersion` 仅拒收旧提案，不生成或撤销动作 `actionVersion` 与授权；新增无关查询不改变同一转账意图。

`createPersistenceProbe/runPersistenceProbe/resumePersistenceProbe` 是独立的真实 PostgresSaver 基础设施 PoC，不是金融授权服务。它使用 `bankpilot_agents_` 隔离 schema，验证并行结果、interrupt、重新创建连接池/图恢复和批准后故障恢复。主 Planner 逐请求编图；API 通过命令、提案快照和租约实现恢复，不宣称生产 Planner 已接跨请求图 checkpoint。

专属测试：`vitest run tests/agents.test.ts tests/agents-phase2.test.ts tests/agents-persistence.test.ts tests/agents-management.test.ts`。PG 测试连接 `BANKPILOT_TEST_DATABASE_URL`，缺省为本地合成沙箱 `127.0.0.1:55432/bankpilot`，每进程独立 schema 并清理；不会跳过数据库验证。模型协议测试使用 mocked HTTP，不作为真实模型调用证据。

固定评测输入在 `evals/fixtures.ts`，显式运行 `tsx scripts/evaluate-model.ts --mode scripted --limit 12 --concurrency 2` 或由调用者加载本项目环境后选 `--mode live`。两模式输入相同，最多 12 例、并发最多 2、单例 90 秒截止；JSON/Markdown 输出到 `evals/results`，live 失败保留且退出码为 1。结构、系统输出语义、财务事实和安全拒绝采用确定性断言，不能替代模型自然语言全面质量或生产验收。

G3 独立的 8 个固定样本在 `evals/management-fixtures.ts`，导出 `managementEvaluationFixtures`（`input` 与 `expected`），不改变原 12 例。其查询凭据和资源仅为合成模型输入，不可用于真实服务；有效快照的远期失效日期用于保持固定输入可重复，不能代替服务的授权和到期验证。

避免上游 #3078 路径：领域包装节点把失败转为显式拒收，不配置节点 `errorHandler`；恢复测试验证不使用该路径的并行兄弟失败重跑。没有声称上游缺陷已修复，图恢复与测试成功也不能独立证明银行端 exactly-once。
