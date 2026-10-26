# G9H：紧凑账单领域判断与拒绝展示闭环

2026-10-25。候选已完成本地检查、冻结与本轮真实模型评测；未达到发布条件，整体目标仍active。上一阶段G9G的35/36与12/12属于历史候选，不自动代表本轮。

## 问题与实现

G9G card-06的账单分支两轮4096 token截断，语义和卡片分支成功而整例不可评。原账单raw未保存，不推断具体正文；静态代码显示旧领域schema要求summary/findings/evidence，随后服务器又重建事实，仅将自由摘要作为model-explanation公开。G9H复用既有账单分析、typed reviewer校验及LangGraph编排，移除领域自由事实重写，改为有实际否决作用的紧凑判断；没有增加模型额度或跳过领域Agent。

[账单领域契约](g9h-bill-domain-contract.md)规定role、planVersion、queryAligned、assessment、evidenceSources、concerns六字段。模型独立核对精确账单子请求与结构事实，服务器保留完整金额、流水和证据。所有provider、adapter、joint和script路径共用严格结构；旧自由提案不成为成功fallback。完整用户请求及跨域事项仍由总控和独立reviewer核对，账单上下文不新增其他领域收款人或目录。

领域否决不能被reviewer批准覆盖，reviewer否决也不能被领域批准覆盖；三个编排模式共享显示门禁。新增领域判断/通过值/绑定持久化，域、联合与复核stage协议升级，API graph为g9h-v1、state-v5；旧graph或缺失attestation的阶段不能静默恢复。新有效快照仍可复用。

独立审查复现了跨领域旁路：同一联合调用中，其他领域model-explanation可能携带已被否决的账单文案。公共出口现按来源类型删除所有model-explanation自由叙述，保留非账单服务器事实；没有关键词过滤或只修单一样本。原四项失败证据与修后证据分别保存。

## 并行开发与审查

GPT-6.1-sol/xhigh负责新领域契约、状态绑定和接线；GPT-6.1-sol/high负责旧夹具迁移、独立集成与浏览器反例，并交叉审查产品实现；GPT-6-sol/high负责新评测入口、账单可见输出日志和测试库浏览器入口审查。根Agent负责API版本、测试库固定浏览器命令、运行器独审及串行验收。测试作者参与独审，属于实施知情的非作者代码复核，不称盲审。

## 验证协议

[预登记协议](g9h-validation-protocol.md)保持G9G的模型参数、预算、尝试次数、输入与标签。固定36例已知回归→12例开发知情补充，各一次完整真实运行，保留原G9/G9E/G9G三份评分，不能以新分替换历史失败。新增bill-domain-output.jsonl，逐次绑定可见结构输出、attempt、状态、长度与摘要；不保存隐藏reasoning全文。缺账单或语义trace使评测无效，不能进入后一组。

[运行器独审](evidence/2026-10-25-g9h-runner-independent-review.json)及[独立复跑18项纯测试](evidence/2026-10-25-g9h-runner-root-review-tests.log)已通过。初审发现省略标记下非字符串outputText缺少严格拒绝，现已补null/object及角色/工具/遗漏/重复/摘要反例。该纯证据不是云业务验收。

测试库沿用G9G已验证的随机独立数据库生命周期，新增--browser仅允许固定playwright.g9h.config.ts；不继承云凭据或live flag，不接受任意命令或配置路径，证据写入本次owned目录。原DB只读[初始快照](evidence/2026-10-25-g9h-runtime-before.json)49表与97命令相对G9G收尾不变。

## 当前证据状态

[全仓日志](evidence/2026-10-25-g9h-isolated-full-check.log)：124文件3242/3242测试、类型检查与构建通过，[全仓清理](evidence/g9g-isolated-test-2026-10-25T05-41-33-309Z-23e4daae-04a0-4c4c-b07e-e0ed0e9eb503/cleanup.json)确认本次数据库已删除、进程组消失。主JS仍787.35 kB、gzip228.86 kB，构建仍有500 kB警告。

[受控浏览器报告](evidence/g9g-isolated-test-2026-10-25T05-43-20-455Z-399209ba-f550-4252-89a8-08a0bb48ea7d/browser/report.json)：13/13通过、重试0，实际包括11条UI流程和2项配置互斥检查；[浏览器外层清理](evidence/g9g-isolated-test-2026-10-25T05-43-20-455Z-399209ba-f550-4252-89a8-08a0bb48ea7d/cleanup.json)确认独立库已删除。六域正常路径、reviewer否决及domain否决/重登/刷新均按各自断言验证；guard不计为UI流程。均为受控模型，不计真实云能力。

[产品实现最终独审](evidence/2026-10-25-g9h-bill-domain-independent-review-final.json)与[初审红证](evidence/2026-10-25-g9h-bill-domain-independent-review.json)分别保留，实际四个跨域文案反例由失败变为通过。[原库检查后快照](evidence/2026-10-25-g9h-runtime-after-checks.json)49表与97命令所有摘要仍不变。

[冻结manifest](../evals/g9h-manifest.json)绑定297文件及副本，冻结时间2026-10-25T05:45:10.204Z。[静态预检](evidence/2026-10-25-g9h-preflight.log)通过。真实云评测结果见下文；当前未解决模型截断和服务链路异常，未完成发布验收。新输入增加了结构事实，输入token可能上升，紧凑输出不保证隐藏推理下降。旧G9G失败保留。

## 受控浏览器独审补充

[独立浏览器审查](evidence/2026-10-25-g9h-controlled-browser-independent-review.json)确认11个独立fixture清理全部成功，83次受控HTTP包含81次合法响应和2次有意注入502，云调用0。两种domain否决均保留reviewer rawApproved=true/effectiveApproved=false；刷新和重登后的complete GET正文与原被隐藏result一致。原库账户、动作及97条命令摘要保持。

后续合法银行卡查询的API已complete、卡片ACTIVE:v1且无管理动作；但两张follow-on card截图均在UI刷新前拍摄，仍显示处理中。它们不证明同次后续卡片结果已在UI显示，也不是已观察到产品失败。下一阶段应给该测试补渲染等待与断言，保留本轮原截图；既有独立银行卡UI用例通过不替代这两张截图。

## 本轮真实模型结果与服务诊断

两组在同一297文件冻结候选上依次完成，各一次，未补跑、回填或改变评分。指定新Key已生效，接口为`https://apiw.pro/v1`，模型`deepseek-v4.1-flash`；118次正式调用均HTTP 200，因此先前403阻塞已解除。HTTP成功不代表模型遵守结构契约。

| 正式组别 | 原G9 | G9E | G9G当前口径 | 可评 / 不可评 | 实际调用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 36例已知回归 | 32/36 | 33/36 | 34/36 | 35 / 1 | 89 |
| 12例开发知情补充 | 0/12 | 0/12 | 0/12 | 0 / 12 | 29 |

[已知组原始报告](../evals/results/g9h/default-known-2026-10-25T05-45-34-080Z-05a19b58-5d53-4ecb-bae1-1875680b3043/report.json)与[补充组原始报告](../evals/results/g9h/default-quality-2026-10-25T05-56-48-760Z-f6d9ff7c-7df8-47b2-81cf-aa2dbdf644ab/report.json)均`validRun=true`，仅表示本轮执行和证据记录有效，不表示业务通过。补充组0/12是完整分母下没有通过案例，12例均不可评，不能解释为12个已判定错误的业务答案，更不能以未产生动作声称安全验收通过。两组都是已暴露或开发知情样本。

已知组89次调用84次结构成功、5次失败（3次截断、2次schema）；补充组29次调用3次结构成功、26次失败（7次截断、19次schema），最终10例schema失败、2例截断。118次起止全部闭合，usage无缺失，均在固定预算内。已知组报告input/output为245007/84652 token，中位16.558秒、P95 37.165秒；补充组为65021/57890 token，中位32.711秒、P95 50.253秒。不同失败阶段不支持直接宣称性能提升。

[card06独审](evidence/2026-10-25-g9h-card06-live-independent-review.json)：同一原文、同一语义输出和预算，本轮账单仅一次调用、输出592 token（其中reasoning468），8个所选引用合法，服务器保留完整14项证据；整例三套评分均通过。此前G9G该分支两次4096上限截断，本次改善仅是单例观察，不证明稳定性或因果。

[card02独审](evidence/2026-10-25-g9h-card02-semantic-independent-review.json)：模型选中原文完整“尾号3906”，第二轮坐标亦正确，但校验器不支持其左侧同位表达“就是”，进入不必要澄清，缺少解挂提案。存在以原文完整卡名安全绑定的纯校验候选；它没有替换实际输出或重新评分。另有goal06语义两轮4096截断，使该例不可评。语义校验器与G9G相同，不能将这些变化直接归因于账单契约。

补充组存在跨域共同异常：与G9G相同的12例首轮semantic相比，服务商报告的input token逐例恒少1656，重试input计数又与首轮相同。源码的json_object路径包含完整schema和修复feedback；历史请求正文未留存，不能仅凭源码证明上游确实收到和执行这些指令。可见错误包括entity.kind缺失、无效operation/disposition，以及账单assessment返回pass/aligned/中文说明。账单非法值不自动映射为成功，也不放宽校验。

[独立两次最小诊断](evidence/2026-10-25-g9h-provider-system-canary.jsonl)另行记录了无密钥的完整请求体：相同精确JSON约束放在system消息时，HTTP 200/stop返回解释文字及Markdown；放在user消息时准确返回预期对象。该小样本支持当前端点存在系统指令遵循或传播异常，不能定位到上游内部某个组件，也不能证明全部历史失败均由此造成。两次诊断不计入118次正式调用、评分或重试，不更改原结果。

原演示库[最终只读快照](evidence/2026-10-25-g9h-runtime-final.json)49表与97条命令摘要均保持；[端口核对](evidence/2026-10-25-g9h-listeners-final.json)5178/8787未监听。候选未发布，未执行真实银行交易或比赛提交。

下一阶段先定位并验证请求指令传播，独立保留请求体摘要及安全诊断证据，再修复已确认的卡片同位表达边界和浏览器渲染等待。任何新实现或服务条件变化均另立候选/运行，不覆写本轮。稳定候选之后仍需同版关键多轮恢复、真正未见首测、有限负载与成本测量、新交付包及接收方复现。

[两组独立证据审计](evidence/2026-10-25-g9h-live-independent-audit.json)确认三套评分、首次运行标记、attempt与语义/账单输出绑定、预算和usage闭合，`overallEvidenceValid=true`。这是记录完整性结论，不是候选发布批准。

[账单结构独审](evidence/2026-10-25-g9h-quality-bill-schema-independent-review.json)对6份实际可见账单响应按冻结schema重验，均仅assessment枚举非法；没有将pass/aligned转换为consistent。其底层服务原因仍需进一步定位。

[服务请求路径独审](evidence/2026-10-25-g9h-provider-path-diagnostic.json)确认known36例semantic首轮input token与G9G逐例差0；quality12例逐例少1656。将同一补充请求通过两个版本的本地fetch替身重建，请求JSON哈希一致且包含system schema；该重建不冒充历史网络抓包。

[补充组语义独审](evidence/2026-10-25-g9h-quality-semantic-independent-review.json)按最终阻断阶段分类为7例语义基础schema、2例语义截断及3例账单枚举失败；包含中途曾恢复的尝试，不能用最终分类替代逐attempt统计。[最终完整性检查](evidence/2026-10-25-g9h-final-integrity.json)另核冻结源码、副本与当前凭据泄漏扫描。
