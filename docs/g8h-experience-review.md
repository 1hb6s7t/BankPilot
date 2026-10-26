# G8H 六领域受控体验：独立初审与最小验收清单

状态：**G8H final-v2 六域受控浏览器与最终自动化报告独立复核完成。** 本轮只读核对浏览器报告、逐测试附件、167 文件冻结清单、全量测试结果、typecheck/build 摘要与服务重启证据；我没有自行运行 DB、浏览器、测试、云或全量验收。

## G8H final-v2：独立证据复核

- Playwright 报告列出六个预定体验用例，6/6 passed、0 skipped、0 flaky，耗时 45.754 秒。逐项覆盖账单来源与缺月/资金拒绝、T+0 与 T+2 理财、目标失败恢复及分步授权、转账 UNKNOWN 原单对账、卡片签名挂失/解挂、订阅查询授权与取消/拦截。这里的“通过”限定为这些受控流程与断言。
- 六个用例的附件均有独立 `cleanup.json`；每份都为 `success=true`、`clean=true`、planning drained、worker stopped、业务与 jobs schema dropped、auth user deleted、ports closed、owned connections closed、temporary directory removed，且 `errors=[]`。页面错误断言也在 fixture teardown 中执行。浏览器 fixture 使用真实登录、API、Planner、隔离 PG schema 与专属 outbox Worker；模型请求由本地控制式 HTTP 响应完成，附件均标出 `cloudCalls=0`。这轮不验证真实云模型质量。
- `evals/results/2026-10-23-g8h-snapshot-reference.json` 指向 `evals/baselines/g8h-experience-2026-10-23T14-51-04-672Z/source-manifest.json`，共 167 文件。本次独立 SHA-256 对比确认当前工作树 0 漂移，冻结副本 0 漂移。
- 学费目标链在最终附件中终态为 goal `SUCCEEDED`，三个节点均成功。赎回 100000 分的 provider original key 只有一行且为 `SETTLED`；acceptedAt 与 dueAt 相同，原回执与投资动作一致；只有两条对应 debit/credit redemption entries。投资动作 `SUCCEEDED`、reservation 已释放，且对应强验证 proof 恰一条。之后另外创建并由本人确认 60075 分转账，provider transfer 恰一条且对应两条 ledger entries，转账 proof 为 `CONFIRMATION`。最终账户余额 839925 分、reserved 0；目标重放后 provider transfer/redemption 行不变；退出重登后目标与同一转账引用仍可读取。
- 本轮目标链还覆盖 reviewer 的受控 502 失败和同一 command 恢复：失败时无 goal、无账务写入；重试只调用 reviewer，已成功的 semantic/domain 阶段复用。赎回必须先以 Passkey 强验证；其后目标 advance 只准备独立转账，未替用户授权付款。
- 第三次之前的目标测试曾因供应方 T+0 已结算、本地投资动作仍 `SUBMITTING` 而失败，原报告保留在 `docs/evidence/g8h-controlled-browser-final-2026-10-23/`，不得改述为通过。修复后独立复核的投资时间戳/异步核验契约：provider `acceptedAt` 与其派生 `dueAt` 使用同一接受时点；首次 `reconcile` 使用 `await`，使异步失败进入 `UNKNOWN` 处理。父线程提供的 `evals/results/2026-10-23-g8h-investment-acceptance-green.json` 显示新增 4 项加既有 20 项共 24/24；前序 red 0/3 与 intermediate 23/24 仍作为失败历史保留。本审查没有重新运行这些 PG 测试。
- 初审提到的通用目标“生日”误称和转账状态英文枚举，已在当前冻结源中分别改为生活目标通用文案及共享中文状态映射；最初建议统一补全账单月份、条目证明、cleanup 分项和重复管理审计的风险已逐项核到最终 spec 或附件中，作为本轮体验验收边界关闭。原初审和 attempt3 失败记录仍保留在本文后续章节/历史报告。

## 最终自动化与运行态证据（报告只读复核）

- `docs/evidence/2026-10-23-g8h-final-verification.json` 指向同一 167 文件 manifest，`currentSourceDrift=[]`、`frozenCopyDrift=[]`，fixture/scorer manifest drift 为空。报告记录全量 1524/1524（67 files，43.548 秒），其中 35+12+1+4=52 项新增测试；typecheck/build exit code 均为 0。Vite build 输出仍保留 bundle 大于 500 kB 的提示。本审查核对了 JSON、报告与测试摘要，没有重跑其中的命令。
- 同一最终证据复述六项浏览器 6/6、0 skip/flaky/retries、45.754 秒、62 个受控模型 HTTP 请求、0 cloud calls；六个 cleanup 均成功。六项的具体业务结论与最终余额/赎回/转账证据见上节和 [受控浏览器摘要](evidence/2026-10-23-g8h-controlled-browser-summary.json)。
- `docs/evidence/2026-10-23-g8h-runtime-refresh.json` 显示旧 API/Worker 正常退出，新 API health=200、Worker started、Web=200 并通过 Vite HMR 提供源码。48 张表的只读摘要比较里，46 张完全一致；只有 `investment_actions` 与 `investment_outbox` 两张表在正常 Worker reconciliation 中变化，6 笔赎回仍为 `SETTLING`。现金、账本、provider records、goals、messages、auth 和 command journals 属于未变集合；两条 2026-10-22 historical running plan 被保留且未重试。该证据没有声称全部 48 张表都保持不变，核验触发的 cloud requests 为 0。
- README、`docs/ideal-state-acceptance.md`、`docs/phase8-verification.md` 和 `docs/g8h-experience-verification.md` 的当前 G8H 数字与最终核验摘要一致，并把云调用 0、合成范围及真实模型/外部机构未验收写清楚。初次读取时，phase8 的 G8G 段落仍将其写成“当前续记”并称六领域体验待继续；文档负责人随后已将其明确改为“历史续记（当时状态）”并说明 G8H 已接续完成，当前版本此处无冲突。ideal-state 也已将六领域受控体验缺口标为完成，并收窄剩余故障验收范围。

六项浏览器成功只证明当前冻结代码在指定合成模型输入、合成数据、软件 Passkey 和受控本地环境中的可观察流程；不证明云模型开放语义质量、生产账户/真实金融机构/商户行为、真实 Passkey 硬件、真实网络故障覆盖或未见输入泛化。1524/1524 为最终核验报告记载的自动化结果，本审查只读核对报告，没有亲自重跑全量。

## 初始审查记录（历史）

以下内容记录 G8H 开始时的源码问题与证据计划。代码现状和验收状态以本节顶部 final-v2 独立复核为准；“尚无结果/待验证”字样仅指当时的初审时点，不能作为当前状态。

## 已确认的用户可见体验缺陷

- 生活目标页面把通用目标固定写成“生日目标”：标题、引导、创建/空状态、保存成功/失败、错误兜底、列表空状态和节点转账标签都用了生日措辞。用户创建“学费”“应急金”等目标时，界面会把真实目标错误归类为生日目标。证据见 `apps/web/src/GoalsPage.tsx` 的 `refresh/create` 提示和页面 JSX；这不是测试 fixture 的文案问题。
- 目标内转账卡片直接向用户展示 `action.status`，值是 `AWAITING_CONFIRMATION` 等英文枚举；同页赎回卡片通过 `statusName()` 转成中文。此处属于体验不一致且把内部状态码暴露给用户。见 `GoalTransferActionCard`。
- 投资页对赎回状态已有中文映射，`SETTLING` 文案明确表示模拟结算中、未到账且不计可用现金；这项保护在代码里存在，仍需验收 UI 与 API/账本终态一致。投资摘要还显示产品日历代码和业务日期；应确认代码是否属于普通用户可理解的说明。

初始 review 只记录这些可由源码直接复现的体验问题；不在本轮改 UI，也不将其扩展为产品设计重构。

## 六域受控验收最小断言

每域均使用独立新用户/业务 schema，保存原始输入、PlanResult/阶段输出、最终 API 状态及同一隔离 schema 的 DB 账本快照。每个场景至少包括：未授权时状态和金额/占用不变；执行/管理终态以服务端事实核对；刷新后仍是同一业务对象与原动作引用；重复点击/重试不产生第二笔动作。只验证指定的受控 fixture 与真实业务链，不把返回 200、按钮出现或模型批准当成功。

| 域 | 最小成功链和必须断言 | 失败/边界断言 |
|---|---|---|
| 转账 | 聊天精确金额、收款人、memo及风险级别→候选→本人确认/RED Passkey→真实 Worker→原单终态；核对 provider key、唯一借贷分录、余额/占额、刷新后同 action id。 | 澄清或未授权时零写入；取消不付款；提交后 UNKNOWN 只查原单、不换单；重复确认只记一笔。若 UI 声称成功，必须有终态收据。 |
| 账单 | 明确月份/区间查询→coverage提示→报告和原交易引用；若触发资金保护拒绝，核对保护版本、缺口、无资金动作。 | partial/missing 不能补零或声称完整月份/比较；IN/非支出不计消费；只读查询前后余额、占额及 provider/action 数不变；无许可不产生报告外推结论。 |
| 理财 | 聊天→真实持仓/产品与金额匹配→强验证候选→Worker执行→持仓/赎回 receipt/现金与动作状态回读。 | 授权前本金、占用、现金不变；T+2 为 SETTLING 时无 receipt/现金入账且不能下游使用；未知 position/金额先澄清；T+0成功也需唯一入账证据。 |
| 卡片 | 聊天按真实合成卡尾号查询；歧义先澄清；挂失候选→本人强验证→状态与版本、审计事件回读；需要时另行解挂并验证。 | 未授权前卡片状态不变；不能对错卡或多卡猜选；卡片管理成功不虚构转账/pg-boss执行回执；重复确认不重复审计变更。 |
| 订阅 | 显式查询授权 grant 后读取快照；明确支持取消的商户→候选→确认→取消终态；银行拦截路径单独确认并回读。 | 无 grant 不返回订阅内容；bankBlocked 与商户合同取消分别展示；不可取消商户不得显示“已退订”；不承诺周期扣款、退款或真实商户执行。 |
| 生活目标 | 自然语言给出目标目的、金额、年份明确截止日、收款人及可选筹资；goal 持久化为正确实体与依赖 DAG；赎回和后续转账各有独立授权、原动作引用、终态/receipt；刷新后节点状态与账本一致。 | 目标保存本身不产生付款；筹资金额可与目标金额不同且不能混淆；预计结算不满足依赖；到期日不是付款许可；缺失必要字段澄清；服务失败不推进 DAG；重复 advance 不生成新动作；重规划保留已完成回执，不重付。 |

六域核心外，建议一条分离用户的跨域演示线贯通“账单读取/资金保护→生活目标筹资→到账→单独转账”。该主线应检查节点依赖、每次授权边界与同一动作唯一记账，不能把其他五域短测的状态串到同一用户上。

## 旧证据的可复用范围与限制

- `tests/e2e/transfer.spec.ts`已有转账确认、真实虚拟认证器签名、TIMEOUT_AFTER_COMMIT 后原单查单和 provider transfer 计数；属于旧场景证据，不能证明新的隔离 G8H 六域 fixture 通过。
- `tests/e2e/investment-goals.spec.ts`已有 T+2 未到账、T+0 赎回、不同金额的生活目标、持久化 DAG/赎回引用/重规划与后续转账，且另有云 planner 目标专项。前者为直接表单受控链，后者依赖云；不得混作新的聊天端到端结果。
- `tests/e2e/management.spec.ts`覆盖卡片强验证、订阅查询授权、支持商户取消和另一商户银行拦截差异。它证明既有管理流程，不证明本轮隔离模型 fixture 的六域执行。
- `tests/e2e/finance.spec.ts`覆盖账单来源、交易引用与保护资金拒绝；`tests/e2e/bills-coverage.spec.ts`覆盖 partial/missing 展示。账单是只读证据，不能将其报告/引用伪装为已执行资金动作。

以上旧规格仅供复用 locator、业务断言和正确边界。readiness 已指出这些旧测试中部分使用共享 schema/user 或依赖真实云端模型；除非本轮证据明确重跑并检查清理，不得称为 G8H 成绩或资源已清理。

## 后续证据审查的硬边界

1. 受控模型 fixture 必须仍走真实浏览器请求、API、Planner/角色、来源校验、PG、Core/管理器及专属 Worker。仅替换明确的模型 HTTP 响应；不能 mock API 返回 PlanResult、授权结果、WebAuthn 验签、Core/Worker、receipt 或 DB 终态。
2. 对每次资金写入确认用户、schema、command/action id、幂等键、provider 引用、借贷/持仓唯一约束；在未授权、澄清、拒绝、错误和 UNKNOWN 时证明金额及占用不变或按业务保留原单，不凭 UI 文案推断。
3. `SETTLING`/UNKNOWN 与 `SUCCEEDED` 必须分开：预计到达/入队不是到账；UNKNOWN 只能 reconciliation 原动作；成功要有一致的执行 receipt 和账务证据。重试、页面刷新和重复 advance 不得制造重复账。
4. 复核前后源码快照与证据 manifest；每域报告独立通过数和链路实际范围。记录 CTAP2 虚拟认证器、合成模型 fixture、合成交易/产品等限制。确认浏览器/API/Worker/pool/临时 schema/auth 用户均在结束时清理。
5. 本轮受控链通过只说明这套确定性 fixture 下产品流程按协议工作；它不证明云模型对开放自然语言理解正确，不证明真实机构、商户、生产 Passkey、T+2自然时间长跑、外部支付/退款、未见样本泛化或物理 DB 故障恢复。

## 初审时的审查边界（历史）

当时只读检查 readiness、Goals/Investment 页面、相关旧 e2e 和 Core 目标依赖/幂等/资金保护路径。此处“尚未检查新 fixture/spec、最终证据待复核”的状态仅代表初审时点，已由本文顶部 final-v2 复核更新。

## G8H 新 e2e 初稿：只读合同复核（历史）

当时读取 `tests/e2e/g8h-finance-goals.spec.ts` 和 `tests/e2e/g8h-management-transfer.spec.ts`，对照 contracts/Core；没有执行 spec 或访问 DB/browser/cloud。下文的“fixture 仍在编写”和初审建议均是历史记录；final-v2 关闭状态见本文顶部及后续复核小节。

### 已对齐或证据充分的断言

- 账单合同 `BillReport` 的字段确为 `period/source/incomeMinor/expenseMinor/.../coverage/transactions/findings`；测试使用 `report.coverage.status`、`incomeMinor`、`findings[].transactionIds` 与 `transactions/evidenceTransactions[].id` 是合同有效的。预算拒绝 expected `policyVersion=2/protectedMinor=550000/shortfall=150000` 与前序余额/保护规则输入吻合。
- 目标 Core `create()` 在创建目标后会 `advance()`，可能立即准备未授权的赎回动作；因此成功 semantic 结果里 `goal.nodes[0].investmentAction.status === AWAITING_VERIFICATION` 与 `nodes.slice(1)` 无 actionRef 是正确的初始态。赎回金额 100000 分与目标金额 60075 分分开断言；原始学费 message 保存在 command，而 canonical title 是“林晓生活目标”，不要求标题逐字保留原始语义。
- 目标链里 `GOAL_ADVANCED`/`GOAL_REPLANNED` 是目标审计事件；管理动作实际审计类型是 `MANAGEMENT_SUCCEEDED`；转账成功/未知事件分别是 `TRANSFER_SUCCEEDED`、`TRANSFER_UNKNOWN`。spec 使用的最终事件名与实现吻合。
- 对被保护资金拒绝、未授权赎回、T+2 settling、目标审查失败时无目标/无动作、赎回后独立转账确认，测试覆盖了关键不变量。目标 reviewer 恢复沿原 command/root/revision 重试且仅 reviewer 角色重跑；最终通过对 provider rows、receipts、平衡分录和 `advance` replay 去重验证。同一真实转账 action 唯一记账的断言较强。
- 卡片挂失/解挂要求 `RED` 与 `AWAITING_VERIFICATION`，订阅查询/取消/银行拦截由 UI 普通确认完成；订阅查询必须先有 grant，取消只改 merchantStatus，银行拦截只改 bankStatus；均检查零余额变化及一次 `MANAGEMENT_SUCCEEDED`。实际 scope/审计名称正确。

### 初审建议及 final-v2 的关闭状态

1. **账单报告绑定：已验证。** final-v2 spec 对照业务日期检查 `source=SYNTHETIC`、当前月份 `period` 和聊天报告月份一致；missing 月份断言 `missing_data`、无金额且不写入。
2. **赎回账务证据：已验证。** 未授权前的 `unchangedMoney()` 对照包含账本/赎回双边分录；成功后按原 provider key 核对恰有匹配借贷两条 entries。目标 lifecycle 另外核对赎回行、收据、强验证 proof、最终余额和重放幂等。
3. **资源清理：已验证。** 六个逐测试附件均带 cleanup 结果，六份均 `clean=true`、`success=true`、所有 teardown 布尔字段为 true、`errors=[]`。finance/goal fixture 在 finally 中校验全部字段，management fixture 也断言主要清理字段，且 `clean=true` 汇总要求包括 owned connection 与临时目录。
4. **管理动作审计幂等：已验证。** 重复确认的卡片/订阅管理动作在最终快照逐 action 断言恰好一条 `MANAGEMENT_SUCCEEDED`；重复读授权快照则比较前后 action、grant、authorization proof 及模型调用数不变。

这些项目是初审阶段的可审计性建议；上述关闭结论来自 final-v2 spec 和对应附件的只读核对，不表示本审查重新运行了它们。

## G8H 隔离 fixture：初版只读实现审阅（历史）

另外读取了 `tests/fixtures/g8h-browser-app.ts`、`tests/fixtures/g8h-controlled-model.ts` 与 `packages/core/src/worker.ts`，没有运行 fixture。该实现确实创建隔离业务 schema、schema 专属 pg-boss worker、随机用户和临时 Vite/API 端口；`startWorker(pool, core, investment)` 启动真实 Outbox/Worker 流程；Better Auth 只通过 `search_path=public` 访问公共 auth schema，并按本 fixture `userId` 删除 session/account/user，没有对公共 auth 表执行迁移/清空。Snapshot 的业务表查询按本次 `userId` 过滤，provider transfer/ledger 通过账户归属过滤，redemption entries 通过 provider redemption 用户过滤，outbox 通过所属 action 用户过滤；这些过滤路径与隔离目标相符。Close 明确先拒绝新 ingress、drain planning、停 Worker、关闭 Vite/API/fetch、关闭业务连接、删除本次 auth 行及两套 schema，最后探测端口和移除临时目录；成功布尔依赖多项实际校验，不单看 `errors=[]`。

### 可影响审计可信度的限制与风险

- 全局外网阻断是 `globalThis.fetch` 包装，不是 OS/socket 层 egress firewall：fixture 只允许 local hostname 或精确模型 origin/path，当前 provider 源码确实用 `fetch`，而应用其余受审服务为本地 PG/API，因此当前已知请求路径被覆盖；但若新代码改用 `node:http`、原生 socket 或其他未包装客户端，fixture 不能阻止其公网连接。报告应写“对当前 fetch 出口实施 allow/block”，不宣称物理外网封锁。
- `snapshot()` 先并发读取 dashboard/management/investment/goals service views，之后才在单独的 `REPEATABLE READ READ ONLY` 事务中读取 raw tables（约第103–118行）。Worker 在这些步骤之间提交时，API projections 与表快照可能来自不同提交边界。当前用例大都先等终态再 snapshot，降低了风险；但 snapshot 自身不是跨 view/table 的原子快照，审阅终态时应核实关键 action 状态、receipt、账本都属于同一稳定终态，必要时重复读取直到稳定，不能仅以这个函数返回一次就宣称所有投影具备同一事务时点。
- **已针对首轮发现修正，尚待运行时证据确认。** `startWorker()` 现在将 boss 启动、队列注册、worker 注册及首次 outbox flush 包在启动回滚路径内；失败时清 timer、等待已启动 flush 并尝试 graceful stop，保留原始启动错误。fixture 用 `workerStarting` 标记启动窗口；若初始化失败没有返回 handle，cleanup 把 `WORKER_STARTUP_NOT_CONFIRMED` 计为错误，不会把 `workerStopped` 记为成功。`tests/g8h-worker-startup.test.ts` 用例覆盖 start、两队列 createQueue/work、processDue、connect、select、send 阶段失败、stop/rollback 二次失败和服务 schema 不匹配；父任务报告该组 12/12 通过（本审查未运行）。启动失败的 pg-boss 实际资源回收仍需最终 fixture/运行证据确认。
- **signup 孤儿用户窗口已补防护，待执行结果验证。** fixture 在调用 signup 前设 `signupStarted`；若 promise 异常且尚未得到 `userId`，cleanup 用唯一随机 email 在 public user 表定向查找，发现多行则报错，唯一匹配时按该 id 删除 session/account/user。此避免对其他用户做全表清理；本审查未执行异常注入确认该路径.

以上是运行前的实现边界与风险提醒；final-v2 实际证据现已补齐逐例隔离信息和 cleanup 结果，六例全部 clean。仍保留两项边界：网络策略是对当前 `fetch` 出口的本地 allow/block，不是 OS/socket 级物理隔离；快照服务投影与 raw table 读不是单个跨来源事务，因此成功判断依赖终态轮询后再核对服务视图与原始 DB 账务证据。当前受控运行没观察到清理错误，但不据此推断所有未来 fixture 代码路径都无泄漏。
