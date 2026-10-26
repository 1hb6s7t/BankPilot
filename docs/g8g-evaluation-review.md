# G8G 评测协议适配：独立验收清单

状态：**G8G 最终 v2 只读复核完成。** 本文面向 G8G 的评测观测适配，不授权真实模型调用，也不改变旧评测协议。审查时没有修改脚本、测试、fixture、scorer 或冻结快照；没有运行云、数据库、浏览器或测试，也没有读取 `.env` 值。

## 实施前基线（历史记录）

以下记录 G8G 观测实现前的基线，仅用于说明本轮修改动机，不表示当前状态。那时 `scripts/evaluate-g7.ts` 已创建 `*.attempts.jsonl`，通过 `provider.attemptObserver` 在 HTTP 前持久化 attempt start、结束时持久化 outcome，并单独生成 attempts summary；PlanningStageFailure 在 case catch 中会降为 `EVAL_RUN_ERROR`，失败 case 的局部 `failure.modelRuns` 不进入 returned-plan 指标，主 `modelCalls`、cap audit 和 `casesWithCalls` 依据返回的 `PlanResult.modelRuns`，完整 HTTP 尝试则由独立 journal 记录。最终 G8G 实现与观察口径见文末最终复核。

当时 `evaluate-model` 与 `evaluate-ablation` 尚未接入持久化 attempt journal，三入口 source closure 也未覆盖阶段失败相关 helper；ablation 文案与 provider 默认 repair 配置存在待对齐处。这些历史基线问题由 G8G 实现处理，相关旧报告和失败证据均保留；当前复核以文末最终 v2 证据为准。

最关键的统计防错：PlanningStageFailure 的 `failure.modelRuns` 是某一个失败 stage 的局部历史；它既不是本 case 的完整 attempts，也不一定与 provider attempt journal 一一同粒度。若未来将其直接加到 attempts 汇总，会把失败 stage 的请求重复计数。HTTP 请求/解析/结构校验成功后，候选仍可能因业务绑定校验失败；这时 provider attempt 仍是 success，planning stage 才失败。阶段错误不能改写 attempt 结果，不能变成业务错误评分，更不能合成 PlanResult 交给旧 scorer。

## 集成后黑盒验收清单

Root 负责跨入口故障测试。集成复核时逐项记录 pass/fail/not run、对应测试或报告、入口、protocol version 和限制。未有证据前保持未勾选。

### Typed failure 与旧评分隔离

- [ ] 三入口都能区分 `PlanningStageFailure`、`ModelAttemptPersistenceError`、case deadline、未知异常；只序列化脱敏的稳定 `code/phase/stage/retryable` 和必要计数，不保存任意 message/stack、prompt、模型输出或 secret。
- [ ] Provider HTTP failure、响应/JSON/schema failure、candidate contract failure 与正常业务拒绝保持分类。Reviewer `approved=false`、确定性资金不足、合法澄清仍是正常业务结果；不能因它们“无 action”而归成阶段系统错误。
- [ ] thrown typed stage failure 不产生合成 PlanResult 或旧 scorer score；以补充观测字段区分其未得到业务结果。若真实 semantic 状态以旧契约返回 PlanResult.failure，则保留原 G7 v3 score/分母（当前 scorer 已证实 failed 状态不能通过 intent/business/modelComplete）；补充计数区分此类 scored system failure。报告明确既有 `scoredCases` 与新增业务结果/不可得分母；未评分显示 `—`/unknown。
- [ ] 兼容字段明确区分 `returnedPlanModelRuns` 与独立 `observedAttempts`。旧 `modelCallsSource=returned-plan-model-runs`、G7 v3 score/passed 定义、fixture 标签保持不变；任何新指标带独立观测协议版本。
- [ ] HTTP 响应和结构化结果合法、但 candidate 被可信金额/payee/role/spec 约束拒绝时：attempt end 仍保留 provider success；stage failure 保留 candidate/contract 错误。不得为报表“配平”而把 attempt 改写为 HTTP failed 或把候选拒绝当业务拒绝。

### 唯一 attempt 事实源、预算和 unknown

- [ ] 每次 dispatch intent 只以 journal `attemptId` 为唯一 attempt 事实。跨请求/阶段失败局部 history、returned `modelRuns`、event list 与 journal 做关联核对时，绝不能相加成重复 attempts；重放同一 JSONL 不改变总数。
- [ ] 记录并分别展示 journal `confirmedStarts`、`confirmedEnds`、`openAttempts`、`requestStarted`/dispatch attempted、cancelled-before-dispatch、persistence failure。Start 只表示 dispatch intent 已持久化；没有 end 的 start 结果为 unknown，不能推断请求到达、成功或失败。
- [ ] 请求 cap 以每个 durable start 的请求上限累计，包含重试、发送前取消和没有 end 的 unknown；`null`/缺失 cap 算缺失而非 0。Cap 是请求上限，不是实际 token usage。Observed usage 只汇总 end 中提供的供应商数值；usage 缺失独立计数，不填 0，不推断费用。
- [ ] 超预算、缺 cap、非法 cap、attempt journal 持久化失败、start 无 end 任一情况都使 budget proof/observation completeness 明确无效；不因 failure.modelRuns 含有上限而弥补 journal 缺口，也不因 provider throw 把已持久化 start 当作没有调用。
- [ ] 失败 case 的 cap/usage/error histogram/请求计数从唯一 attempt 流计算；returned-plan-only 兼容统计单独保留、清楚命名。总 attempts 等于 journal 的唯一 start 数，不是 starts+ends，也不是 starts+failure.modelRuns。

### Case identity、并发和 latency

- [ ] `evaluate-model` 并发 worker 在领取 case 时分配固定、唯一 journal `caseSequence`，不得用 records push 完成顺序关联。Ablation identity 至少区分 run/journal、sequence、fixture id、repeat、variant；同一 fixture 的不同 variant/repeat 不串账。
- [ ] Case 开始与 case-result JSONL、attempt starts/ends、异常摘要共享稳定 identity。并发情况下随机完成顺序不改变逐 case 统计、sample denominator、cohort/variant 汇总或 attempt 归属。
- [ ] 构造 semantic success 后 domain failure、两个并行 domain 一快失败一慢成功、reviewer failure 三种 schedule。失败分支的局部 history 不作为总 attempts；成功 sibling 的 attempt 不漏；所有 case attempts 不跨 case 归属；reviewer 未启动不造 reviewer call。
- [ ] `allCases` latency 继续包含全部已选 case（含未评分失败）。另列基于 journal attempt 的 observed-call case latency；明确它按 dispatch-intent starts 还是 `requestStarted` ends 定义，且不能与旧 returned-plan `casesWithCalls` 混称。未知请求仍保留 wall duration 和 unknown outcome。
- [ ] Timeout/abort、attempt journal start 写失败、end 写失败分别测试：start 写失败必须 not_sent 且不虚构模型调用；end 写失败不得自动触发第二个 HTTP request，report 保留 start 和 persistence failure；case deadline 不把观测失败伪装成业务 false。

### 入口一致性、source closure 与报告文案

- [ ] 用相同的隔离 provider fault matrix 对 G7、evaluate-model、ablation 验证一致的 typed failure、attempt 唯一计数、unknown、cap/usage 缺失及分母结果；差异仅限各入口原有 scorer/fixture 协议和并发/拓扑。
- [ ] G7 既有 attempts JSONL 不重复接入第二个 observer；evaluate-model 与 ablation 复用公共 attempt journal/provider observer，但每个 run 使用独立排他新文件。SIGKILL/进程中断后，fsync 过的 starts/ends 可独立复核；journal 完整性失败明确阻断 `validRun`。
- [ ] 三个入口的开始/结束 source hash 都闭包覆盖实际执行的源码与观测 helper：至少新增 `stage-recovery.ts`、`planning-failures.ts`、`attempt-journal.ts` 和新 helper，并纳入各自真实启用的 semantic/budget/bills/card-locator 等依赖及 package/lock。G7 保持 end hash；evaluate-model 新增 end hash/sourceDrift；ablation 保持其现有 end hash。单独的全仓冻结 manifest 不能代替 evaluator 自己的 source closure。
- [ ] 开始运行前校验 fixture/hash/manifest 与 protocol；运行中写 started/每 case attempt/每 case result；结束写 summary/闭合态/结束哈希。缺少最终 report 时 attempts journal 仍能说明已持久化边界，但不能宣称完整运行。
- [ ] 输出文案分别说明：模型阶段完成 ≠ 业务正确；调用结束 ≠ 业务通过；未评分 ≠ 通过或安全；attempt start ≠ 远端收到；usage 缺失 ≠ 零；请求 cap ≠ 已消耗 token；试点样本 ≠ 泛化证据。
- [ ] 保留旧 G7 v3 scorer、fixture 标签和所有历史报告的字节内容/哈希；新 attempt-observation 协议独立版本化。对 ablation 的 schema repair retry 现实配置显式记录：若关闭，传 `maxStructureRepairs=0`；若保持默认 1，则在新 protocol 中如实说明 repair 属于同一 `maxAttempts` 预算。不得静默重跑失败样本择优，也不得覆盖历史文件。

## 当前只读范围与后续复核

当前已读 readiness、三个入口、`scripts/evaluation-observation.ts`、`packages/agents/src/provider.ts`、`packages/agents/src/attempt-journal.ts`、`packages/agents/src/planning-failures.ts` 及三份新 G8G 测试源码。没有跑测试/模型/DB/browser。最终报告到达后，应确认共享 attempt 汇总是 journal 的唯一 canonical source，再逐一追踪各入口的 scored/unscored、failure/cap/latency 口径；不要重新审查或更改旧 fixture/scorer。

## G8G 集成实现首轮复核（最终报告待核）

读取新 helper、三个入口和三份 `tests/g8g-*` 测试源码，未执行这些测试。共享 helper 明确将局部 `failure.modelRuns` 标为 `selected-failure-stage-only`，observed attempts 从 attempt journal 独立汇总；case sequence 在 worker claim 时分配；unknown start、不足/非法 cap、usage 缺失和 journal 故障均有明确状态；三个入口已扩展 source closure 与结束漂移检查。Root 报告的失败 red run 和修复状态不代替最终报告。

**旧 G7 v3 评分器兼容裁定：保留原协议，不删除 returned `PlanResult.failure` 的 score。** 我逐字节比较了 G8F 冻结副本与当前 `evals/semantic-score.ts`，SHA-256 相同（`b3cbe46dafeb1f9fee8978c7f1d7f06d7dad86308fe3a8478f26e81e8bf0935f`）。按该 scorer，`observedStatus=failed` 不满足 intent recognition；业务通过要求 intent recognition，因此 `businessSemanticsPass=false`、`passed=false`。对需执行动作的样例，`modelComplete` 还要求 `observedStatus=ready`；对其他样例，失败的 semantic model run 也不满足预期角色恰好一次成功的条件。因此在已核查的 returned semantic-failure 路径中，没有发现 `passed=true`、`modelComplete=true` 或 `businessSemanticsPass=true` 的反例。`validRun=true` 表示运行及记录可评估，不等于业务通过，不能称为假通过。旧 score 和旧 scored denominator 必须为历史可比性保留。新增观测报告应补充透明分母（例如 `scoredSystemFailureCases`、`businessResultCases`、`businessUnavailableCases`），并保留 `failureSource: returned/thrown`，说明哪些系统失败仍按旧 v3 scorer 计分、哪些 throw 没有可评分 PlanResult；这些是辅助口径，不改写旧 scorer、fixture 标签或既有 `passed` 语义。业务拒绝（如 reviewer `approved=false`）仍是有业务结果的正常评分样例，不能与没有业务结果的 thrown failure 混为一类。

首轮代码中曾发现 G7 markdown 将缺失 score 显示为 `false`；最终冻结源码已改为“未评分”。我检查了当前 formatter 和 scripted Markdown：缺失值使用未评分标记，真实评分为 false 的 case 仍显示 false。该呈现问题已闭合。

没有发现 attempt journal 汇总把 local ModelRuns 与 attempts 相加：helper 注释、G7/其他入口返回计划兼容统计及独立 attempts summary 均有明确区分。最终复核结果见下节。


## G8G 最终证据复核

只读核对了 `evals/results/2026-10-23-g8g-snapshot-reference.json`、157 文件冻结 manifest、最终 Jest JSON、6 组 scripted 结果和旧 G8F 对照证据。逐文件重新计算当前工作树与冻结副本的 SHA-256：157/157 全部匹配 manifest，当前与副本均为零漂移。`evals/semantic-score.ts`、G7 holdout fixtures 与 manifest 的当前 hash 均与 G8F、G8G manifest 一致，旧 scorer/fixture/标签未变。

最终自动化 JSON 报告 154/154 suites、1469/1469 tests passed，0 failed、0 pending；typecheck/build 为父任务报告的通过状态，本次未自行运行。六组 scripted 证据为 finance 12/12、management 8/8、phase4 8/8、G7 all 3/24、ablation production 40/40、ablation comparison 120/120。G7 scripted 结果明确不是全绿，也不构成真实模型质量证据；这些结果检查的是运行和报告兼容性。

旧 G8F frozen copy 对照证据报告 old/new 均 3/24，24 个 case 的 passed/failure labels 完全一致，old/current sourceDrift 均为空，cloudCalls=0。该对照支持 scorer/fixture 历史兼容性；不代表语义质量提升。

G7 Markdown 中未评分值已改为“未评分”；行中真实评分的 false 仍保持 false。补充 observation 摘要区分 `scoredSystemFailureCases`、`businessResultCases`、`businessUnavailableCases`、returned/thrown failure 数；`scoredCases` 仍只表示旧 scorer 实际执行数。`validRun` 在报告文案中明确定义为评测记录有效，不等于业务通过。

本复核只读取已有文件并重新计算 manifest hashes；没有执行 DB、云、浏览器或测试。最终结论限于自动化/脚本化证据与源码快照一致性，不给出真实模型质量或数据库/浏览器验收结论。

### 最终收尾版（14:10 UTC 冻结）

最终收尾版本以 `evals/results/2026-10-23-g8g-snapshot-reference.json` 指向的 `2026-10-23T14-10-57-153Z` 快照为准，替代 13:59/1469 的中间复核记录；旧快照与报告均保留为历史证据。重新逐文件散列后，157 个当前源文件及冻结副本均与新 manifest 匹配，零漂移。最终验证报告同样确认 fixture/scorer/manifest 无漂移，G8F 冻结副本无漂移。

最终测试报告为 154/154 suites、1472/1472 tests、零失败、零跳过；类型检查通过。最终验证记录注明前后两版应用和前端源码未变化，构建通过（存在既有 large-chunk warning）。这 3 个新增用例验证新 resultsDir 下 G7 不会重置 exposure history；最终 scripted cohort 字段是 `mixed-cohorts; pilot-known + reserved-known-regression`，应以此为准。

最终 scripted baselines 中五组非 G7 共 188/188（finance 12、management 8、phase4 8、ablation production 40、ablation comparison 120）；G7 scripted 为 3/24。旧 G8F 冻结 scorer 对照仍是新旧均 3/24、逐案结果和失败标签全等、sourceDrift 为空、cloudCalls=0。以上仍只是脚本化兼容证据，无真实模型质量结论。最终验证记录显示 cloudCalls=0、本阶段 browserRuns=0；本次仅读报告和重算 hashes，未自行运行测试/DB/cloud/browser。
