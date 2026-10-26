# G8G 评测失败、调用观测与评分兼容

2026-10-23。G8G 已完成实现和本地验证：**1472/1472 自动化，63 个测试文件，0 失败、0 跳过**；类型检查、构建通过。源码冻结 **157 文件**，当前树与冻结副本均无漂移。新增 55 项测试。完整证据见[最终核验](evidence/2026-10-23-g8g-final-verification.json)、[全量结果](../evals/results/2026-10-23-g8g-final-v2-tests.json)和[独立复核](g8g-evaluation-review.md)。

本阶段解决的是评测真实性：规划失败时，不能漏掉已经发生的语义、领域、并行 sibling 和复核调用，也不能把缺失 usage、未知结果或没有业务结果解释成零消耗或业务通过。产品交互、银行执行规则和指定模型配置未改变。本地 API 继续运行已验收的 G8F，API 与页面健康检查均为 200；本轮没有云端调用或新的浏览器验收。

## 实现与复用

本轮不新增依赖，沿用前期[开源复用决策](../research/2026-10-22/BankPilot-开源复用与模块化决策.md)与[恢复复用方案](phase8-reuse.md)。

| 模块 | 处理方式 | 实际改动及依据 |
|---|---|---|
| 现有 provider、LangGraph 规划及确定性业务 scorer | 直接复用 | 不重写传输或评分；受控测试运行实际规划器、结构校验和 scorer，替换 HTTP 响应即可触发真实失败链 |
| 持久化 attempt journal | 适配复用 | 沿用序列化写入、发送前 fsync、结束后 fsync 和失败锁定；summary 兼容增加脱敏只读 confirmedAttempts，原持久化语义不变 |
| 三个评测入口 | 适配复用 | evaluate-g7 / evaluate-model / evaluate-ablation 均绑定独立 attempts 日志、逐 case JSONL、稳定 sequence、源码起止哈希及新观测协议；G6 经公共 ablation 入口获得同一适配 |
| 错误分类与观测聚合 | 新增项目适配层 | scripts/evaluation-observation.ts 处理 BankPilot 阶段失败、失败局部历史、每 case 请求上限、未知 usage 和评分分母；这些契约依赖本项目，不另造通用 Agent 框架 |
| 无云验证与故障注入 | 复用 Vitest / Node 文件系统，新增业务断言 | 覆盖实际入口和持久化边界；不靠构造伪 PlanResult 为失败补分，也不使用另一个模型当裁判 |

现有文件改动只有 attempt-journal.ts 与三个评测入口。新增公共 helper 和三个测试文件。源码清单见[冻结引用](../evals/results/2026-10-23-g8g-snapshot-reference.json)。原 fixture、manifest、scorer 及 evaluate-model 内嵌三个评分函数与 G8F 保持一致。

## 失败、调用和预算口径

1. **保留精确失败。** `PlanningStageFailure` 保存 phase、stage、code、retryable；持久化异常保存可得的 requestOutcome；deadline 保留旧 CASE_DEADLINE_EXCEEDED 标签。存在更具体原因时，不用通用观测错误覆盖。错误 message、stack、任意 findings 文本、请求头及密钥不进入公共摘要；候选拒因仅保留固定白名单机器码。
2. **局部历史仅作诊断。** failure.localModelRuns 最多 32 条，明确标 selected-failure-stage-only。它可能缺少成功 sibling 和此前语义调用，因此不能与 journal 相加，也不能当全 case 调用总数。
3. **独立观测来自 durable starts/ends。** 每个 attemptId 只计一次。start 证明发送意图已落盘，不证明远端收到；没有 end 的结果是 unknown。dispatchAttempted 只统计已确认 end 中 requestStarted=true，不能据此判断所有未闭合 start 是否已发送。
4. **所有 start 都计请求上限。** 失败、发送前取消和 unknown 均不退还其 cap。预算逐 case 校验；多 case 总和可以超过单 case 上限。cap 缺失、非法、超额、journal 不完整时不能获得完整预算证明。32768/12288 是请求输出上限，不是已计费 token 或货币预算。
5. **缺失 usage 不补零。** reported sum 只累加供应商提供的部分；只要有未知，完整 input/output total 就为 null。输入 0 也不证明免费。scripted 零调用明确为 applicable=false、verified=null，不是模型能力或成本证据。
6. **并发与退出可核对。** model 入口领取样例时分配 sequence，不按完成顺序编号。G7曝光历史同时只读正式evals/results与当前输出目录并去重，避免换输出目录后把已知样本误标首次。若 case JSONL 写入失败，停止领取新样例、取消在途请求，等待所有已启动 worker 收尾后返回原错误，最后关闭 journal；不会提前返回并留下继续调用的 worker。

## 保持旧评分，补充业务可得性

原 `modelCalls` / `tokens` 等统计仍标明 `returned-plan-model-runs`，方便历史比较；完整独立统计在 `observedAttempts` / `observedCases`。全部样例、存在 durable start 的样例、存在 confirmed dispatch 的样例分别报告延迟。偶数中位数取两个中间值均值，空集合分位数为 null。

原 G7 v3 scorer 已定义语义服务失败返回的 PlanResult：observedStatus=failed，不满足 intentRecognition、modelComplete、businessSemanticsPass 或 passed。G8G 保留这一已存在的评分结果和分母。新领域/复核抛错没有可评分 PlanResult，继续为 unscored。合法 reviewer approved=false 则是有业务结果的拒绝；是否满足题目仍由原 scorer 判定。

`scoredCases` 只表示原 scorer 执行过；新增 `scoredSystemFailureCases`、`businessResultCases`、`businessUnavailableCases` 与 returned/thrown failure 来源，明确哪些记录仍缺业务结果。`validRun=true` 表示该协议下运行可评估，**不表示业务通过**。总体 passed 分母始终包含失败样例，未评分不会被删掉。Markdown 缺少 score 的单元格显示“未评分”，实际 false 仍保留 false。所有安全断言仅限已返回的规划结果；真实授权、扣款和恢复能力须另看 Core/API/E2E 证据。

观测协议单独记录为 `bankpilot-evaluation-observation-g8g-v1`，原 G7 v3 scoringProtocol 不改。三个入口同时记录实际尝试上限、结构修复上限和超时。ablation 现有 provider 默认允许一次结构重生成，本轮显式传入并如实声明 `maxStructureRepairs=1`，仍受总 maxAttempts=2 约束；不倒改历史“无结构重试”的旧文案。model 未设置 temperature 时仍省略 HTTP 参数，报告说明使用提供方默认，没有隐式改为 0。

## 验证结果

| 范围 | 结果 | 意义 |
|---|---:|---|
| 全仓自动化 | 1472/1472，63 文件 | 包含既有 Core/API/PG、checkpoint、真实子进程 SIGKILL 等回归；不推出所有故障窗口均覆盖 |
| 新公共观测测试 | 31/31 | 错误脱敏、局部历史、cap、usage、unknown、重复 attempt、分母、偶数中位数等 |
| 新入口基本测试 | 8/8 | 三 suite、G7、重复 ablation；稳定 case identity、脚本 N/A、日志与源码绑定，以及跨输出目录的样本曝光历史 |
| 新跨入口受控测试 | 16/16 | 实际 planner/provider 路径；领域/复核失败、HTTP 401、schema 修复、并行慢成功、乱序 case、start/end fsync 失败、写报告时并发退出、合法业务拒绝、依赖源码漂移 |
| 类型检查与构建 | 通过 | 保留既有主 JS 738.48 kB 的大 chunk 提示，非本轮新增 |
| 冻结与历史完整性 | 157/157 一致 | 当前树、冻结副本零漂移；G8F 冻结源码和原评分数据未改 |

完整脚本基线单独运行六组、212 条记录，严格禁止 fetch，实际网络调用 0；各组起止源码无漂移。原始 JSON/JSONL/attempts/Markdown 均保存，索引见[脚本基线](evidence/2026-10-23-g8g-final-scripted-baselines.json)。

| 脚本组 | 业务标签通过 | 运行可评估 | 模型观测 |
|---|---:|---|---|
| finance | 12/12 | true | 不适用，0 调用 |
| management | 8/8 | true | 不适用，0 调用 |
| phase4 | 8/8 | true | 不适用，0 调用 |
| G7 全集，无语义模型 | **3/24** | true | 不适用，0 调用 |
| ablation production | 40/40 | true | 不适用，0 调用 |
| ablation comparison | 120/120 | true，validComparison=true | 不适用，0 调用 |

G7 的 21 个失败保留，不能称六组全部业务通过。为区分本轮回归与旧脚本语义能力，另将 G8F 冻结源码拷贝到临时目录执行相同 G7 scripted all：旧新均 **3/24**，24 例 passed 与 failure labels 完全一致，起止源码零漂移，临时环境已清理。原始输出另存[冻结版本对照](evidence/2026-10-23-g8g-final-frozen-score-comparison.json)。这既不修复自由语言能力，也不代替云模型测试。

首次失败证据与前一轮核验均保留：

首轮完整回归为1469/1469，对应13:59 UTC的157文件快照。随后修复G7自定义输出目录隔离了正式曝光历史的问题，新增3项回归，重新冻结14:10 UTC快照并全量验证1472/1472。两个快照仅evaluate-g7.ts和入口测试不同；首轮[核验记录](evidence/2026-10-23-g8g-initial-verification.json)与[源码引用](../evals/results/2026-10-23-g8g-initial-snapshot-reference.json)保留。最终G7 cohort如实标为pilot-known + reserved-known-regression，业务标签仍逐例不变。

- [初轮 12/14](../evals/results/2026-10-23-g8g-runners-initial.json)：semantic 返回的 start/end 持久化失败已有精确 failure，但观测门将顶层错误改成通用码。三个入口已优先保留原码。
- [修后 15/15](../evals/results/2026-10-23-g8g-runners-fixed.json)：新增合法 reviewer 否决与系统失败区分。
- [并发退出红例](../evals/results/2026-10-23-g8g-reporter-shutdown-red.json)：case 写报告失败时 Promise.all 提前返回；改为取消并等待全部 worker 后，最终全量中的该例通过。

## 多 Agent 分工和独立复核

沿用 Astra / Sol / Luna 按难度分配的协作方式。Astra 负责预算、unknown 和错误脱敏的公共底层，集中处理最容易产生假零或双计的契约；Sol 适配三个入口及基本集成；主 Agent 设计跨入口故障注入、复现并修复判定、运行全仓和冻结旧版对照；Luna 独立核对分母、源码、报告和最终证据。源码 ownership 分开，数据库测试由主 Agent 串行统一执行。

复核曾提出删除返回型系统失败的 score。对照旧 G8F 和 scorer 后，确认这会改变原协议的历史分母；最终保留旧评分，增加业务可得性字段并明确 validRun 的含义。该决定有冻结版本与受控反例支持，不是为了提高通过率。独立复核自行重算了当前和副本的 157 个哈希；没有自行运行云、数据库或浏览器。

## 剩余目标与下一阶段

本轮没有重复探测暂停中的指定云服务。最近真实接入专项仍为 G8E 0/1、当时只读目录返回暂停页；历史 G8D 的 19/24 不能转记为 G8G 成绩。

下一阶段依据[六领域体验验收准备](g8h-experience-readiness.md)，转向六领域及跨域任务的完整受控体验：真实页面、登录、授权、执行、回执、刷新恢复和持久状态验收；沿用合成银行及独立测试用户，模型响应用受控传输隔离。先完成这一条不依赖云服务恢复的产品链路，再补云服务恢复后的已知回归、未见样本和真实成功恢复。数据库提交未知/物理故障、空机器复现和比赛交付仍需后续证据。项目总体继续为“部分证实”，长期目标保持进行中。
