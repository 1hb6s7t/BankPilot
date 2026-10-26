# G8D 真实模型已知回归：失败分析

本记录只分析冻结源码对应的真实结果，不修改 runtime、测试、fixture 或 scorer，不补跑模型。24 例均为已知回归，不是盲测。原始模型候选没有落盘时，只记录日志可证明的阶段和诊断，不重建候选内容。

- 本轮结果：`evals/results/2026-10-23T08-38-34-675Z-g7-semantic-live-all-production.jsonl`。
- 主线程冻结状态：135 文件；全仓自动测试 1218/1218 通过。该状态与真实模型回归结果分别报告。
- 完整结果：`evals/results/2026-10-23T08-38-34-675Z-g7-semantic-live-all-production.json`，2026-10-23 08:38:34.675–08:59:16.616 UTC，complete/executionComplete/validRun 均为 true，sourceDrift 为空。
- 最终 **19/24 通过**。失败 g703、g710、g711、g712 均为上游 HTTP 502；g722 为模型 operation／槽位不一致被安全校验阻断。planningSafetyFailures=0、unexpectedActionProposals=0 不表示业务全部完成。
- 两组均为已知回归：pilot-known 9/12，reserved-known 10/12。结果内旧模板的 cohortCaveat／interpretation 仍提到 reserved first execution；本轮实际 selection/cohortSummary 和历史事实表明没有首次保留样本，不沿用该措辞作盲测宣传。

## g703：上游 HTTP 502，未取得语义候选

用户请求：`再转 73.25 元给刚才那个人`。场景要求澄清收款人，不能根据不存在的历史猜测对象。

本轮两次 `semantic_intent` 调用均在 request 阶段失败，错误码 `MODEL_HTTP_502`，耗时分别 12,427 ms 和 400 ms；成功调用数为 0，没有 output length/digest，也没有可分析的原始候选。现有 provider 将 5xx 视为可重试错误，本轮用完两次有界尝试后安全返回澄清，未创建转账提案。

**分类：运行依赖／上游传输失败。** 现有证据不能把它归为模型误分类、候选失真或确定性规则误拒。502 也不能单凭此日志进一步归因到具体网关或模型后端。

最终状态虽为 clarification，但没有已识别的 transfer role，且通用说明未包含“收款人”，因而出现 `INTENT_STATUS_OR_ROLES_MISMATCH`、调用集合不完整和 `RESPONSE_FACT_MISSING`。这些是此次请求失败的下游表现，不是独立证明收款人安全判断发生退化。

观测日志确认 2 starts、2 ends，均失败，未遗留 open attempt；两次 input/output usage 都缺失。统计中的 reported sum 为 0 不能解释成实际消耗了 0 token。请求输出上限合计 8192，本例预算与 planning safety 均通过。

改进方向：将服务不可用与用户意图需要补充的文案分开，使此次失败明确表达“暂未取得识别结果”。若主线程之后决定重测，应另存新结果，保留本轮失败，不能覆盖为成功。

## g710、g711、g712：同为请求阶段 HTTP 502

| 样例 | 场景 | 两次失败耗时 | 后续评分表现 |
| --- | --- | --- | --- |
| g710 | 理财赎回 | 365 / 380 ms | 赎回语义及澄清状态不满足要求 |
| g711 | 名称含“计划”的理财产品查询 | 376 / 371 ms | 澄清状态及答复事实不满足要求 |
| g712 | 未知且带引号的理财别名 | 1201 / 1288 ms | financialFailures 为空，但意图／调用集合要求未满足 |

三例均为两次 semantic_intent request 阶段 `MODEL_HTTP_502`，0 次成功调用，没有模型候选、output length 或 digest；未进入 investment 或 reviewer。每例观测均为 2 starts、2 ends、0 open attempts，两次 input/output usage 都缺失。预算及 planning safety 通过，但 usage 不能据 reported sum=0 视为实际零消耗。

**分类均为运行依赖／上游传输失败。** g712 最终安全澄清不等于完成了未知对象的语义判断；该次根本没有获得候选，不能据此判断对象边界修复有效或无效。相邻三例短时间连续 502 提示存在共同的上游可用性问题，但此日志不足以确认具体网关原因。

## g722：目标被标为 transfer，附带不允许的槽位

原文：`给陆星遥准备 920 元学费，2026-12-08前到账；先从星潮活期增强赎回1,000元`。fixture 要求目标金额 92000 分、截止日 2026-12-08、指定 T+0 持仓筹资赎回 100000 分；收款人唯一、持仓可用 600000 分，所需实体、日期、金额和资金数据均已提供。

semantic_intent 第一次调用成功，耗时 34964 ms、outputLength=376、reported output tokens=121；随后确定性校验返回 `SEMANTIC_UNEXPECTED_SLOT`，路径 `tasks.0.operation`，recognizedRoles 仅有 transfer。未调用 goal、investment 或 reviewer，没有创建目标／赎回提案。观测为 1 start、1 end、0 open、无 provider 错误；预算和 planning safety 通过。

从 `roleFor` 的唯一映射可确定候选首任务 operation 为 transfer；`semantic-intent.ts:372` 的该检查意味着它存在 transfer 不允许的 period、date 或 funding 至少一种。**原候选没有落盘，不能断言具体字段、原文范围或任务数量，也不能依据 outputDigest 重建它。** 当前证据不能进一步确认这些槽位内容是否忠实原文。

**分类：模型任务类型／槽位组合不一致，确定性规则正确拦截；业务未完成。** 这不是 HTTP、未知对象、缺日期或资金不足问题。现有通用“请明确……”文案不准确表达系统候选错误。G8D 的 operation 更正只授权独立只读 funds→bills，不包含动作 transfer→goal，因此没有触发有界重生成；不能把该守护不重试当成模型重试预算失效。

`intent.ts:66–67` 的辅助 `isGoalRequest()` 只覆盖生日、若干显式目标／计划形式，不直接覆盖本句“准备学费、日期前到账”；故较早的 GOAL_IMMEDIATE_CONFLICT 没触发，而后续不允许槽位检查完成了安全阻断。增加该辅助识别可以改善诊断，但单独改一个关键词规则并不能保证目标完整性，也不能解释成已完成业务修复。

后续方向：先记录不含原文 payload 的结构诊断，例如 operation 及 present-slot 名称，让实际错误可定位；原始候选若需保存，应另有明确的隐私与证据策略。目标语义提示应覆盖学费等非生日筹资目标。若新增 transfer→goal 有界修复，必须独立授权更正契约，验证完整原文、目标收款人／金额／截止日以及筹资对象／金额两组绑定，保留所有非更正字段与任务完整性，不允许删除 date/funding 来强行生成即时转账，也不允许把独立即时赎回与目标依赖互换。独立反例应覆盖两个金额互换、目标和即时转账混合、历史／否定／引文、日期缺年、未知持仓及多任务遗漏。

## 已观察到的修复效果与归因边界

- g701、g702 通过。
- g704 通过，账单、转账和 reviewer 均完成；四次模型调用全部第一次成功，未出现重生成。因此本例证明本版本的完整业务路径通过，**不证明新增 scope 修复分支在这次真实调用中被触发**。
- g705 通过，明确回答 2026-10 商户名称含“书店”或其名称别称“书局”的已提供支出 123.60 元、1 笔，附原流水引用。三次模型调用均首轮成功，本轮未触发 period 更正分支；原候选内容未保存，不能从 digest 推断它具体选择了哪段 period。
- g706 通过，正确走 bills，报告 2026-09 收入 17650.00 元、支出 252.90 元、净额 17397.10 元。三次模型调用均首轮成功，本轮未触发 funds→bills 修复分支。
- g707 通过，明确 2026-08 缺数据，同时保留 2026-09 报表、四笔流水和 finding 证据；没有把缺失月份写成零。领域提案 accepted 且带 clarification，reviewer 原始 approved=true 被确定性门控降为 effectiveApproved=false。此例实际覆盖了已提供证据保留修复。
- g708、g709、g713 通过。
- g714–g721、g723 通过；g714 的真实卡尾号流程通过，与新增 typed card locator 的目标一致。
- g724 通过。g713 先出现一次 HTTP 502（1114 ms），第二次成功（12602 ms），因此它实际覆盖的是 provider 既有有界传输重试；不是 scope／期间／operation 修复。

全 24 例 **没有一次模型输出校验修复重生成**：所有获得成功候选的语义阶段都在首轮成功，唯一例外 g713 为先传输失败再成功。其余重试全部是四个最终失败场景的 HTTP 502。新增 scope-only、period 补／更正、funds→bills 更正分支仍只有定向自动测试证据，本轮不能声明这些分支已得到真实调用验证。g704、g705、g706 的业务场景成功与分支触发是两件事。

相对 G8C 初轮同为 19/24，**通过率没有增加，但失败集合已变化**：原失败 g704、g705、g706、g707、g714 本轮全部通过；本轮五个失败不能从总分相同推断“修复没有效果”，也不能因原五例通过称全部回归已修好。四个服务故障保留为本轮失败；g722 仍需改进目标分类与受限更正。

全轮独立观测为 62 starts / 62 ends，53 HTTP／输出验证成功、9 失败，9 个错误全部为 MODEL_HTTP_502；0 open attempts，journal closed=true、persistenceFailed=false。9 次失败的 input/output usage 缺失；53 次成功的 input usage 均报告为 0，这只说明 provider 返回值，不能作为真实零输入消耗。reported output 合计 11939；请求输出上限合计 315392。返回的 modelRuns 与独立日志本轮计数相符；业务仅 19/24 通过，不能把 53 次技术成功视作业务完成。

## 服务失败被保存为“已完成澄清”：源码链路与受控复现

以下链路已由冻结源码确认，并由主线程另行完成受控 Hono 路由／PostgreSQL 缺口复现，具体证据见下节。原 24 例评测脚本仍是直接调用 `planner.plan(input)`（`scripts/evaluate-g7.ts:116`），没有经过数据库 runner 或浏览器；不能声称那四条 HTTP 失败评测记录本身已在 ConversationCommand 表中落盘。

1. `packages/agents/src/semantic-intent.ts:718–726`：provider 耗尽有界尝试后，catch 将 `MODEL_HTTP_502` 交给 `failure()`。该函数（275–276）正常返回 `status: clarification`、空 tasks 与通用“请明确操作、对象、金额或日期”文案。服务失败与用户确实缺字段共用此状态。
2. `packages/agents/src/index.ts:203–214`：非 ready 语义结果正常返回 PlanResult，保留 clarification、findings 和失败 modelRuns，无领域任务；没有抛出服务失败。
3. `apps/api/src/planning.ts:32` 在准备输入阶段保存 `input.semanticIntent`；`apps/api/src/plan-runner.ts:145–146` 随后冻结完整 prepared input。planner 返回后 runner 还会冻结 proposal（216–224），再在完成事务中设置 `status='complete'`、写入 result、清空 last_error_code（246–250）。只有异常路径才进入 failed（255–263），故上述正常返回的 HTTP 失败不会进入该路径。
4. `apps/api/src/conversations.ts:145–160` 将这个结果作为普通完成消息写入聊天。`buildClarification()` 按原文、字段和有限语法决定是否生成待补充条目，未先排除服务故障。如果不支持逐项补充，onComplete 追加“此类请求请完整重述，不能用简短字段续接”。这些 HTTP 故障可能被呈现为输入问题，而不是系统可用性问题。
5. `ConversationCommand` 投影（conversations.ts:38）只给 pending、failed 或过期 running 设置 retryable；complete 为 false。`apps/web/src/ConversationsPanel.tsx:255–260` 因此显示“规划已完成”，不显示“重试原请求”，并在无逐项澄清时显示“请以新请求完整重述”。`apps/web/src/App.tsx:767–784` 又优先判 needsClarification，早于 failedModelRun，详情结论为“需要补充信息”。
6. 即使直接请求 retry 路由，`apps/api/src/plan-runner.ts:103–107` 发现 existing.result 后只刷新／回放结果，不重新识别；`apps/api/src/app.ts:137–143` 对 complete 返回 200。这是已完成结果的幂等语义，不能仅给 UI 加一个按钮就恢复该失败。

**结论：源码会将这类识别阶段服务故障归档成 complete+clarification，且界面会把恢复责任交给用户补充／重述。** 这是失败状态契约与恢复流程的适配缺口，不代表本轮候选金额、对象或否定校验失效。

### 同冻结版本的受控 API／数据库缺口复现

主线程于 2026-10-23 09:05:07 UTC 在相同 G8D 快照执行了独立探针，证据：[受控 502 恢复探针](evidence/2026-10-23-g8d-model-failure-retry-probe.json)。它使用进程内真实 Hono 路由和现有 PostgreSQL 表、独立合成 actor、stub session，以及仅针对 `model.invalid` 的可控 fetch；没有调用真实模型网络，没有拦截生产 API，没有创建／删除 schema。

- 接收请求返回 HTTP 202。连续两次 502 后，命令实际保存为 complete、retryable=false，clarification 追加了要求完整重述的说明。
- PostgreSQL 中 proposal/result 均已保存，prepared_input 确实包含失败的 semanticIntent。这将静态分析中的快照陷阱落实为持久化证据。
- 模拟上游恢复后，重试同一 command 返回 HTTP 200；调用计数在重试前后均为 2，结果完全相同。即恢复 endpoint 后也没有重新发出识别调用，只回放旧结果。
- 聊天保留 1 条用户消息、1 条助手消息；动作数为 0，余额 800000 分、占额 0。缺口复现没有导致授权或资金执行。

该探针的性质是 **defect reproduction，不是修复验收**。它证实了真实路由与数据库路径上的错误完成状态和无法恢复；stub session 不构成真实认证验证，未打开浏览器，因此页面展示仍为源码推导，也不能声称真实浏览器故障恢复已测过。此独立探针不替换原 24 例结果，也不改变 19/24 分数。

后续最小适配方向：在语义／PlanResult 契约中显式区分“需要用户信息”和“识别阶段服务暂不可用”，保留稳定错误码、阶段与是否可重试；runner 在冻结可执行 proposal 之前将无动作的识别服务故障送入受 lease 保护的 failed 路径，聊天明确展示暂不可用并允许重试同一 command。领域或 reviewer 已完成部分工作的失败须另行定义恢复条件，不能统一清空结果重生成。UI 应依据显式失败状态，不靠任意 findings 文本猜测。

**不能只改最终 status。** 当前 prepared_input 已含失败 semanticIntent；恢复时直接读取该快照会再次返回旧 clarification，不会调用识别。需要明确区分不可变原请求／目录输入快照与可重试阶段输出，失败的语义结果不能作为已完成阶段复用；同时保留 attempt 历史、预算规则、租约 fencing、原命令和副作用幂等。已有 complete 历史结果若要支持迁移恢复，应单独审核，不应静默覆盖本轮样本或重新执行已有动作。

建议下一阶段独立验证：两次 502 后命令为可恢复失败且无 proposal/动作/用户澄清；同命令显式重试成功且不新增用户消息；刷新后恢复按钮仍在；真正缺收款人仍为正常澄清；重试只恢复失败阶段而不复用失败 semanticIntent；并发重试只允许当前 lease；历史已完成及已建动作仍幂等；缺失 usage 明确标为未知。

### 下一阶段 P0：最小兼容的恢复契约（设计，未实现）

本项优先级为 P0：短暂服务故障不能显示为用户缺信息，也不能让同一命令的重试永久回放失败快照。当前冻结版本和本轮评分保持原样。

**结果契约。** 保留 ready / clarification / no_action 现有业务语义；追加显式、可辨别的服务失败结果，至少包含 phase、稳定 code、retryable 和该次 attempts。clarification 只用于实际需要用户信息或无法安全核对业务请求；HTTP 502 等失败没有可用候选，不能从原文启发式创建 ClarificationSeed。请求超时、429、5xx 与取消、鉴权、结构验证错误须有明确分类，不能把所有 MODEL_* 都宣称可重试。失败仍记录 modelRuns／独立调用日志，但不返回动作建议，也不伪造领域识别结果。

**恢复边界。** 第一版只支持尚无 proposal/action、发生于 semantic_intent 的可恢复传输失败。原 commandId、rootCommandId、revision 和原消息保持不变；一次用户显式重试取得新 lease 并运行新的有限尝试，禁止后台无限重试。deadline 可按既有恢复机制刷新，预算必须同时记录单次尝试上限及该命令累计尝试，不把未知 usage 视为返还预算。识别成功后才进入现有领域规划；领域或 reviewer 失败另行规定恢复，不顺便扩大首版范围。

**输入与语义快照。** 推荐在现有完整 prepared_input 之前增加一个较小的、版本化且带摘要的识别输入快照，保存原消息、账号与目录、referenceDate 等识别依据；将识别尝试结果作为阶段记录。只有拿到可复用的语义结果后，才完成 finance 等下游准备并冻结现有 prepared_input。识别阶段服务失败不写为完成的 semanticIntent，也不写 proposal/result；重试沿原识别输入快照重新解释，避免重新取目录导致绑定变化。若语义已成功，而后续准备／执行失败，应复用该已验证语义，不再次询问模型；需要保存独立的成功语义阶段记录，使成功解释不因后续读取失败而丢失。ready、合法 no_action、真正业务 clarification 都是已完成解释，不能仅凭 tasks 为空判为服务失败。

现有 prepared_input 已含语义对象且参与 graph_input_digest，不能在恢复时就地删除或替换失败 semanticIntent；这会破坏快照摘要与 graph checkpoint 绑定。需要递增快照／graph 契约版本，并为新增命令走上述阶段边界。旧版已成功 prepared_input 仍按原摘要完整复用。旧版 complete+clarification 且带 HTTP 错误的记录不能自动转成未完成；若未来提供一次性迁移／恢复，必须独立审核原状态、确证无 proposal 中的动作建议和任何已创建动作、保留旧结果及审计记录，再创建显式恢复关系。首版可以明确提示旧记录需新请求，不静默篡改历史。

**proposal 与 action。** 保留现有 proposal 冻结点、core 稳定命令键和 result 幂等回放。一旦存在 proposal，恢复必须沿该提案完成草稿副作用与持久化，不重新识别／生成另一提案；有 action 或执行状态时，不套用“无动作识别失败”重试规则。已 complete 的成功结果仍只刷新动作状态。失败落库和恢复成功均使用当前 lease fencing，过期 worker 不得改写新结果。服务失败对应聊天 failure 事件；同命令多次失败可保留各 attempt 记录，最终成功不删除这些失败。

**界面。** 可恢复服务失败显示“服务暂不可用，这次识别尚未完成”，提供“重试原请求”；不生成待补充问题，不要求用户改写完整且合法的请求。完成业务澄清继续保留现有字段补充功能。聊天列表状态、计划详情状态、刷新后的历史投影和 retry API 的响应语义应一致；只调整前端优先级不足以修复后台永久回放。

### 修复后需要的真实 API／数据库验收（设计，尚未验收）

上述受控探针已复现当前失败路径，但没有实现修复，以下目标行为仍未通过验收。这些验收应通过真实 API、真实测试数据库和可控上游故障注入完成；成功响应可使用预置合法服务响应来稳定复现，不依赖随机真实模型正好返回 502。另做授权后的真实服务恢复演示，但不得替换本轮真实 24 例记录。

| 验收步骤 | 必须查看的持久化／API 证据 |
| --- | --- |
| 保存一条合法请求，上游连续两次 502 | 同一条用户消息；command 为 failed 且 retryable；稳定服务错误码；无 result/proposal/action/ClarificationSeed；失败聊天消息与两个闭合 attempt 记录 |
| 刷新历史并显式重试同 command | 原消息、commandId、revision 不变；新 lease；旧识别输入摘要不变；新识别 HTTP 确实发生，未回放失败 semanticIntent |
| 重试取得成功语义后完成领域提案 | complete/result 只写一次；最终动作数符合业务；旧失败 attempt 保留；重复 retry 只回放成功结果，不再发模型调用／创建动作 |
| 成功语义后，finance 读取或后续持久化注入故障 | 恢复复用已验证语义；识别调用次数不增加；完整 prepared_input/graph 摘要及 checkpoint 绑定正确 |
| proposal 保存后、action 创建后分别中断 | 恢复复用原 proposal；core 稳定幂等键不变；动作不重复，无重新生成不同收款人／金额的机会 |
| 并发 retry，以及旧 worker 延迟返回 | 仅当前 lease 可提交；旧 worker 不覆盖成功／失败状态；不会创建第二个同语义动作 |
| 真正缺收款人的请求，与服务故障对照 | 前者正常 complete+业务 clarification，可逐项补充；后者 failed+重试原请求，无伪“用户缺字段” |
| 完成结果、旧版失败结果、摘要不符快照 | 成功历史幂等；旧版不自动迁移／清空；摘要不符安全停止，不新建动作 |
| 页面刷新及计划详情 | 状态一致显示服务故障，按钮可恢复同命令；无“规划已完成／需要补充信息”的错误组合 |
| 缺 usage、进程被杀与新重试 | 未结束 attempt 保留未结束／未知状态，不伪成功；累计调用与预算证据完整；未知 token 用量不写成实际零 |

## 本次分析边界

本分析子任务仅写入本文件，读取源码、评测记录和主线程探针证据；没有重试真实服务、修改评分器／fixture、编辑冻结源码或测试，也没有直接读取数据库或凭据。主线程已用真实 Hono 路由／现有 PostgreSQL 表完成受控缺口复现，尚无修复通过的证据；浏览器展示由源码推导，未做本故障的真实认证／浏览器验证。候选未保存的部分均明确留作证据缺口。同冻结版本六流程浏览器结果由主线程另行报告，不用本轮 24 例或故障探针替代。
