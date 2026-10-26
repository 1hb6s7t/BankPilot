# G8G 评测入口适配准备：G8F 阶段失败与独立观测

后续状态：本清单已由[G8G实现与验证](g8g-evaluation-observation.md)接续，1472/1472自动化及六组独立scripted基线已完成；下文保留实施前的审查状态与依据，不作为当前待办清单。

2026-10-23 13:24 UTC 只读审查。此次仅新增本文档，未改 scripts/packages/tests/fixtures/scorer，未运行测试、云调用或数据库操作。G8F 源码继续保持停改。下述适配清单是下一阶段方案，尚未实施或通过回归。

## 结论

新的 `PlanningStageFailure` 会被三个评测入口的 catch 降为 `EVAL_RUN_ERROR`，丢失具体失败阶段、稳定错误码和该失败阶段的 ModelRun。业务不会被记成通过，但模型调用、usage、请求上限及部分延迟口径会少报。G7 已有独立持久化 attempts 日志，所以其 HTTP 尝试证据并未随 throw 丢失；旧 evaluate-model 与 ablation 没有同等独立日志。三个入口的源码哈希列表均未覆盖 `stage-recovery.ts` 和 `planning-failures.ts`。

应先适配异常观测与统计，再运行新的真实回归。保留现有 fixture 标签、scorer 通过定义及全部历史报告，不把“安全停止”“HTTP成功”或“没有返回计划”改称业务通过。

## 实际失败链路

- `packages/agents/src/index.ts:303/329/350` 将领域、single 联合调用和 reviewer 的异常经 `stageError` 转成阶段失败。`stage-recovery.ts:18` 将已返回、但与确定性请求不一致的候选归为永久 `MODEL_CANDIDATE_CONTRACT_INVALID`。
- `packages/agents/src/planning-failures.ts:3–19` 的异常携带 `failure={phase,stage,code,retryable,message,modelRuns}`。持久化失败和 `PLAN_SUPERSEDED` 保留原异常，不应统统包装成阶段失败。
- `stage-recovery.ts:35–39` 等待所有已启动 sibling 结束，优先抛永久故障。**所选异常的 failure.modelRuns 只属于该失败节点**，不能当作该 case 的全部调用。更早的 semantic、成功 sibling、其他失败 sibling 均可能不在其中。
- 现有生产恢复在提供 `PlanningStageJournal` 时可以保存所有节点历史；三个评测入口均未提供 stageJournal。不能仅在 catch 展开 `error.failure.modelRuns` 就声称补齐了所有调用。
- semantic 阶段仍可返回带 `failure`、intent.status=`failed` 的 PlanResult（`index.ts:227–234`），并非本次新增 throw 路径。`semantic-score.ts` 已显式允许 observedStatus=`failed`，且此状态不满足原业务意图通过条件。真实 reviewer `approved=false` 也是正常已返回结果，与 reviewer 服务失败不同。

## 各入口目前会留下和遗漏什么

| 入口 | 异常记录 | 调用与预算遗漏 | 延迟、完整性及评分影响 |
| --- | --- | --- | --- |
| `scripts/evaluate-g7.ts:113–135` | catch 仅特别保留 ModelAttemptPersistenceError；其他非截止异常均变 `EVAL_RUN_ERROR`。case 保留 durationMs、passed=false，无 score/result | 顶层 modelCalls、错误直方图、usage、requestedOutputTokens 和 cap 缺失/非法计数仅取 `result.modelRuns`。throw 时既不执行 `auditRequestedOutputBudget`，也无 budgetValid。独立 `attemptObservation`/attempts.jsonl 仍有全部已落盘 starts/ends、角色、cap、usage、错误；尚未作为同一主统计口径 | allCases 延迟保留；casesWithCalls 只按 result.modelRuns 判断，排除实际已发请求的 throw 例。executionComplete/complete 只表示已遍历样例数，可为true；无score使 validRun=false。correctIntent/modelComplete/business/financial/safety等只统计有score记录，缺失样例不应解释为“安全已验证且无失败” |
| `scripts/evaluate-model.ts:87–134` | catch 不接收异常，记录 failed + 通用 EVAL_RUN_ERROR/截止错误；无阶段/原code/ModelRun | 所有 tokens 仅取返回结果；throw例不会增加 missing usage计数，Markdown调用成功/失败显示0/0，存在假零观感。无独立attempt日志、无实际cap审计、无起止sourceDrift验证 | 所有case总延迟仍进入median/P95；passed/failed分母不丢。没有validRun/完整观测字段。异常case结构/语义/安全列显示false，其含义应为未评分，不是测得三类业务错误 |
| `scripts/evaluate-ablation.ts:116–150` | case JSONL保存通用异常和耗时，但只在case结束后追加；无独立attempt持久化 | summarizeVariant仅取result.modelRuns。modelAttempts、failedAttempts、schemaFailedAttempts、usage/errorCodes少报；modelIncomplete只计有score且!modelComplete，throw例只进入unscoredRuns，不进入该项。budget为预分配计划，没有按真实starts审计 | 全case延迟保留。无score使executionComplete/validRun/validComparison=false；complete仍可true。planningSafetyChecked已有有score分母，应保留，并显式列未评分case |

G7 已在 protocol 明确说明 returned-plan ModelRun 会遗漏 throw 尝试，属于已知统计边界，不能删除该说明再沿用原数字声称完整。G7 confirmedStarts 证明 dispatch intent 在发送前持久化；不证明远端收到请求。没有 end 的请求 outcome unknown；usage 缺失不能补零或推算免费。

另一个必须保持的区别：一个 HTTP/结构化输出成功的候选可能随后被业务契约拒收。此时 provider attempt end 仍是 success，而阶段失败 code 是 `MODEL_CANDIDATE_CONTRACT_INVALID`。适配器不能为配平报表把该 attempt 改写成 HTTP失败，也不能把它记成业务完成。

## 最小适配清单

1. **公共、脱敏的异常提取。** 三个 catch 区分 PlanningStageFailure、ModelAttemptPersistenceError、case截止和未知异常；记录稳定 code、phase/stage、retryable及有界的failure.modelRuns，明确这些是局部失败历史。保留 case duration和原passed=false。不记录任意 error.message/stack、模型输出或用户内容；PlanningFailure的用户提示不是统计分类依据。
2. **每case独立尝试观测。** G7复用既有journal；evaluate-model/ablation用同一 `createModelAttemptJournal`、每case序号和provider.attemptObserver，新增独立 `*.attempts.jsonl`。evaluate-model并发2时，序号在worker领取case时确定，不能依records.push的完成顺序编号；ablation用现有sequence区分case/variant/repeat。保持现有并发/角色/重试/预算，不为观测新增模型调用。SIGKILL没有最终report时仍能从已fsync的日志知道边界。
3. **观测与评分分列。** 保留旧modelCallsSource=`returned-plan-model-runs`及原分数口径；新增明确来源的 observedAttempts（confirmedStarts/ends/open、HTTP dispatch/end、稳定错误、usage、实际cap）。G7可直接利用summary；不能把attempt end拼成伪PlanResult交给scorer。顶层新增typed-stage-failure分类、scored/unscored case数与安全未评分数；既有v3模型成功角色基数和passed标签不改。
4. **异常case也审计预算和延迟。** 以durable starts的cap统计保留额度，包含发送前取消/结果未知，不能仅按成功end统计。对每case校验cap存在、边界及总和；journal不完整/持久化失败必须明确无完整预算证明。保留allCases延迟；新增基于confirmedStarts或明确dispatchAttempted的延迟口径，并写清前者可能尚未dispatch，后者无法覆盖未闭合的已发送请求。保留旧casesWithCalls指标也可以，但必须标明仅returned plans。
5. **运行有效性与业务通过分开。** 原G7/ablation规则下throw例无score仍令validRun=false，不静默改成true。若下一协议希望把“执行完整但业务失败”视为有效运行，必须新增观测完成字段或版本化该规则，不能假造score以通过现有校验。错误case继续保留于总分母和原始JSONL；未知结果/持久化失败不允许伪成功。
6. **更新源码追踪并核对协议文案。** 见下节。新报告保留原scoringProtocolVersion，另记适配/观测版本与实际retry配置；历史文件不覆写。ablation文案当前称“No schema repair retries”（97行），而provider默认允许一次结构重生成且包含在maxAttempts内（provider.ts:157/165/281）。下一次运行前应明确选择：保持旧承诺须显式配置maxStructureRepairs=0；采用现有运行行为须在独立新协议中如实写明。不可只改文案把历史行为倒改成未发生，亦不可新增隐式重试。

不必为解决本次统计缺口改动 scorer、fixture 或运行API/PG。若需要阶段完成事件/已复用节点细节，可在单次case提供内存 PlanningStageJournal复用现有接口，但它不是durable HTTP观测的替代；重建完整失败PlanResult不属于最小适配。跨请求显式重试/断点恢复评测须另立恢复协议，不应在原一次调用评测里自动重跑到成功。

## sourceHashes / sourceDrift 的具体缺口

| 文件清单 | 现状 | 下一阶段最小补齐 |
| --- | --- | --- |
| G7 `trackedFiles`（evaluate-g7.ts:14–20） | 已含semantic-intent、budget、bills、provider、attempt-journal及contracts；有起止哈希。**缺stage-recovery/planning-failures/card-locator** | `packages/agents/src/stage-recovery.ts`、`packages/agents/src/planning-failures.ts`、`packages/agents/src/card-locator.ts` |
| evaluate-model `sourceFiles`（72行） | 缺上述新阶段文件，也缺实际createPlanner默认启用的semantic-intent/budget/bills/card-locator；仅起始快照，没有endHashes/sourceDrift，package/lock也未列 | 上述3个文件，加 `packages/agents/src/semantic-intent.ts`、`packages/agents/src/budget.ts`、`packages/agents/src/bills.ts`、`package.json`、`pnpm-lock.yaml`；接入attempt journal时同时追踪该文件及新统计helper；增加结束哈希 |
| ablation `sourceFiles`（10–15行，78行组合） | 有起止哈希和package/lock，缺新阶段文件及budget/bills；未列semantic-intent/card-locator（即使该评测默认不走semantic，index静态导入这些模块） | 同样补齐stage-recovery/planning-failures、budget、bills、semantic-intent、card-locator；接入journal时追踪attempt-journal/新helper |

`planning-failures.ts` 实际位于 **packages/agents/src/**，不是contracts新增文件；共享PlanningFailure/PlanningStageJournal类型仍在已经追踪的 `packages/contracts/src/index.ts`。G6入口复用runAblation，现有extraSourceFiles仅补evaluate-g6.ts与app.ts，默认不会补这些缺口，因此需随公共ablation适配一起受益。

上述清单只说明评测活跃调用链与新观测代码的最小缺口，不代替整个仓库依赖闭包。主线程完整冻结manifest与run自身sourceDrift是不同证据；外部冻结零漂移不能把run未追踪的文件变为run已追踪。若扩展源码helper，其本身也必须进入三入口相应清单。

## 不调用云端的回归方案

先保留现有fixture/评分/历史报告，新增独立runner适配测试。mock provider只处理明确的 `.invalid` 地址，其他fetch直接抛错，避免意外外网；需要真实子进程/HTTP时只监听本机动态端口，不连接API或PG。测试结果写临时目录，不占正式评测case/曝光记录。

| 场景 | 必须核对的输出 |
| --- | --- |
| semantic成功，领域两次502耗尽 | case失败；typed phase/stage/code/retryable保留；semantic成功及两次失败均在attempt日志；cap/usage缺失统计不变成0次；总耗时与观测调用case延迟均包含该例 |
| 一个领域快速失败，另一领域延迟成功 | 等待sibling收尾；所选failure.modelRuns仍可仅属于失败节点，但observed attempts覆盖两个分支，稳定attemptId不重复；无reviewer假调用或伪最终结果 |
| 所有领域成功，reviewer两次502 | 失败归reviewer；保留之前semantic/领域调用与预算；不把确定性事实仍存在当作review成功 |
| single联合结构失败 / 领域schema失败 / 401 | 正确永久错误与局部ModelRun；按实际既有maxAttempts/maxStructureRepairs核对次数；无额外评测重试 |
| HTTP有效但候选金额/对象与可信请求不同 | attempt end成功，同时stageFailure=MODEL_CANDIDATE_CONTRACT_INVALID、case失败；不可把两层成功/失败混为一谈 |
| semantic返回typed failed；正常用户字段澄清；reviewer正常拒绝 | 三者与抛异常分开记录；原scorer标签不变；服务失败不能获得澄清场景的通过信用 |
| 持久化start失败/end失败/observer挂起、取消与SIGKILL | start失败前无fetch；end失败无重发；未知attempt保留start且无假end；valid观测为false；限时收尾且不泄露内容。复用既有journal/process测试边界，不重新造provider实现 |
| 并发2、乱序完成以及ablation重复variant | case编号和日志归属稳定；总数按attemptId计算，failure局部历史与journal不相加造成双计 |
| cap缺失/超界/累计超额、失败usage缺失 | 独立预算审计失败或明确未知；失败不退还cap；input/output缺失不补零 |
| 已返回正常PlanResult、全部抛异常、mixed与scripted零调用 | 既有pass/failure标签及总case分母保持；全部异常时无空数组分位数NaN；scripted说明模型统计不适用，不声称模型能力 |
| tracked source前后改变（用临时文件/注入hash函数） | stage-recovery/planning-failures等新依赖能触发sourceDrift；原fixture/scorer不改 |

可复用的现有无DB测试为 `tests/g8f-stage-recovery.test.ts`、`tests/model-attempt-journal.test.ts`、`tests/model-attempt-journal-process.test.ts`、`tests/semantic-score.test.ts`、`tests/ablation-score.test.ts`、`tests/agents-ablation.test.ts`。这些覆盖底层恢复/持久化/评分，但目前未覆盖三个runner catch之后的完整报告适配；仅重跑它们不足以宣布报告缺口已修复。

适配完成后的无云验证应先运行新增runner测试及上述相关测试、typecheck，再运行显式 `--mode scripted` 的三入口基础设施基线（G7 all、model三suite、ablation生产与comparison）。调用导出的函数或Node直启时不要附加 `--env-file`，scripted分支provider=false。scripted无法触发真实provider异常，必须与mock HTTP失败用例分别报告。真实模型阶段另行授权、另存新报告；本次没有执行这些计划。
