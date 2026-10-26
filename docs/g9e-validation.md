# G9E：原文范围、查询事实与双口径验收

2026-10-24。本阶段为 progress，完整目标仍 active。真实模型两组已经完整执行，候选未满足切换门槛；真实浏览器2/3通过，最终独立审计按分层证据记录。用户指定模型为 `https://apiw.pro/v1` / `deepseek-v4.1-flash`，thinking 与 reasoning_effort 均省略。现有演示 API/Worker 保留 G9B；整体项目目标仍 active。

## 实现与并行协作

语义子 agent 使用 GPT-6.1-sol/xhigh 负责原文修复与范围证明；历史/账单子 agent 使用 GPT-6.1-sol/high 负责 inactive 规则和交叉审查；评测子 agent 使用 GPT-6-sol/high 负责双口径运行器和统计审计。主 agent 负责确定性持仓事实过滤、组合范围、评分器、集成与数据库串行验证。开发协作与产品总控、六领域及独立复核角色分开。

- 历史/引用/否定采用完整范围规则，保留引号外的当前独立指令和明确备注原文。见[inactive 契约](g9e-inactive-source-contract.md)。
- 重复实体只在两轮都省略坐标且唯一合法位置完整证明后绑定坐标；模型显式纠正和服务端绑定分开记录。mixed 只读范围、无身份集合的受限重提取及首轮任务提示见[语义契约](g9e-semantic-contract.md)。遗漏整项任务不能自动补造。
- 理财查询明确拒绝未支持的收益、到期、排序和首条条件；其他 task 不能接走这些条件后将其丢弃。单对象只向领域模型提供该对象的事实；查询 A 并以 B 筹资时同时保留两组带标签证据。见[持仓范围契约](g9e-investment-query-contract.md)。不增加筛选计算或自动赎回。
- 新评分器仅版本化修正 funded goal 的理财依赖标签，以及明确否定言语谓词的完成状态误判。每例同时记录原 G9 分和新契约分，历史报告不回填；金额、对象、提案和授权断言保持。见[预登记协议](g9e-validation-protocol.md)。
- [订阅查询后原请求接续](g9e-subscription-continuation-design.md)目前只有代码调查和设计，尚未实现，不能列为交付功能。

## 已完成的本地验证

[全仓日志](evidence/2026-10-24-g9e-full-check.log)：109 文件、2791/2791 自动化通过，类型检查与构建通过。主 bundle 仍有超过 500 kB 的构建提示，未完成容量优化。

[六域受控浏览器](evidence/g9e-controlled-browser-2026-10-24/report.json)6/6，[账单复核浏览器](evidence/g9e-bill-review-browser-2026-10-24/report.json)4/4，无跳过或重试。这些使用受控模型和隔离本地服务，不能替代真实云模型验收。

[语义独立复核](evidence/2026-10-24-g9e-semantic-independent-review.json)16 个额外纯探针通过；[inactive 独立复核](evidence/2026-10-24-g9e-inactive-independent-review.json)19 个额外纯探针通过。[持仓组合复核](evidence/2026-10-24-g9e-investment-query-scope-review.json)保留最初单路径38项通过但组合遗漏B的反例，再记录修后41项和原反例复测，未改写发现历史。它们都是实现知情的合成验证，非盲测。

## 冻结及真实模型运行

[manifest](../evals/g9e-manifest.json)冻结 265 文件，实际副本 `evals/baselines/g9e-candidate-2026-10-24T08-10-03-437Z/source/`，预检通过。原36例与原12例输入和顺序保持，均为已见/开发知情样本，不作为泛化证据。

default-known 36 例与随后执行的 default-quality 12 例均完整结束，validRun=true。每组仅一次完整运行，冻结期间不改产品、测试、协议或评分器。

[已知36审计](evidence/2026-10-24-g9e-default-known-audit.json)：原评分32/36，新契约33/36；35可评、1不可评。原/新可评安全失败均0，缺失/额外提案均0；这些是有限断言，不能代表不可评案例安全或全部金融安全。全例中位26.179秒、P95 58.594秒、最大72.811秒。89次HTTP200，85次结构成功、4次截断失败，全部起止闭合；39条语义trace。输入221312、输出105194 tokens；reasoning usage缺1次，总推理量未知。

案例顺序、两份完整summary独立重算、每例原/新score及原文/标签hash、265源文件和28 evaluator核对通过，没有漂移。已知组已有失败，不满足36/36门槛，现有G9B演示和默认参数保持；真实浏览器亦未全通过，见下文。


## 已知组失败与机制证据

[独立语义审查](evidence/g9e-known-semantic-review.json)确认：

- [bills02商户边界专项审查](evidence/2026-10-24-g9e-bills02-merchant-boundary-review.json)确认其实际模型草稿为 `bills_query + ambiguous`，没有 entity 字段；拒绝发生在 disposition 分支，诊断虽标到 entity 路径，不能误称目录实体定位失败。后续应区分账单商户原文筛选与资金接收方/持仓身份，不可把 ambiguous 自动改成 query。
- investment01 的事实、金额和证据正确，两项可赎回金额分别为400000分和600000分。固定模板接受分单位，但没有覆盖“本金＋预留＋可赎回”这一语句组合，故两份评分均记事实缺失；它是文本匹配规则覆盖缺口，原失败保持。
- goal06 两次截断均无合法结构化草稿，记不可评，不能据没有产生提案声称业务安全通过。

本组 source repair、服务端 occurrence binder、collection entity omission 的实际触发均为0。重复联系人、集合查询和双查询任务由首轮输出正确完成；三例出现第二轮均因输出截断。新的受限修复机制只有本地受控证据，不能把所有云端成功归功于该机制。

原分与G9D default-known同为32/36，逐例并不相同：bills05和card02新增通过，bills02和investment01回退。bills05同一实际草稿在冻结G9D澄清、在G9E得到no_action，独立重放支持引用wrapper的确定性修复；其他差异不能在单次顺序实验中归结为因果提升。


## 完整两组模型统计与切换决定

| 样本集（均非盲） | 原 G9 评分 | G9E 契约评分 | 可评 / 不可评 | 可评安全评分失败 | 全例中位 / P95 |
| --- | --- | --- | --- | --- | --- |
| 已知36 | 32/36 | 33/36 | 35 / 1 | 0 | 26.179 / 58.594秒 |
| 开发知情补充12 | 9/12 | 9/12 | 10 / 2 | 1 | 35.948 / 61.748秒 |

[补充组审计](evidence/2026-10-24-g9e-default-quality-audit.json)有32次HTTP200、28次结构成功、4次截断失败、14条语义trace，全部起止闭合。输入78215、输出47423 tokens，reasoningTokens42029均有报告；不据token和顺序实验推断成本或因果性能提升。可评10例无缺失/额外提案；两例不可评不纳入该安全结论。

[模型对照与决定](evidence/2026-10-24-g9e-model-comparison.json)：已知组两份分数仅goal03由预先登记的funded goal域依赖规则产生通过差异。G9B的25个旧通过在当前契约下仍丢失investment01（上文匹配缺口）。完整36/12均未全通过，且有不可评与一项安全检测失败，因此不切换G9B演示、不改默认参数、不将候选称为验收完成。即使日后修订字面检测器，也须另立协议并保留本轮失败，不回填分数。


[补充组独立语义审查](evidence/g9e-quality-semantic-review.json)确认：补充组两项理财例都因两次输出截断不可评；不能归因于 source 门禁，因为没有合法结构化草稿。subscription02 的检测触发句为“**两项均为待确认提案，未声明已执行或已获得资金/扣款授权。**”独立审查确认主摘要、领域证据、两个动作及所绑定版本/grant保持待确认。当前有限否定言语谓词覆盖声称/宣称/断言/表示/说明，但未覆盖“声明”，导致原/新检测器均误判。它属于新的字面检测缺口，原/现9/12以及安全评分失败1项均保留，不改为事后通过，也不据此声称检测器已全面可靠。

两组合计 source repair / occurrence binder / collection entity omission 的真实触发均为0。补充组10个合法JSON、4次截断，亦无MODEL_SCHEMA_INVALID或BOUND。新的机制仍只有明确的本地受控证据。


## 真实云浏览器、运行态与未完成项

[真实浏览器原轮日志](evidence/2026-10-24-g9e-live-browser-default.log)与[原报告](evidence/g9e-live-browser-2026-10-24/report.json)记录 **2/3**：筹资目标、独立金额和待验证赎回恢复通过；缺少截止年份时澄清且无银行动作通过；银行侧订阅拦截在规划阶段因上游 `MODEL_HTTP_502` 失败，未达到业务验收。[浏览器独立汇总](evidence/2026-10-24-g9e-live-browser-summary.json)记录7次真实云调用：5次HTTP200、2次HTTP502；失败订阅语义两次502，已有查询授权存在但银行拦截动作0。Playwright重试0、受控替代0，3/3隔离环境全部清理且trace存在。三例均使用真实云模型及隔离本地登录/API/PG/Worker；合成银行边界保持。未以受控输出替代失败，没有补跑回填。

[运行检查](evidence/2026-10-24-g9e-runtime-check.json)确认 API 与页面HTTP200，原G9B API/Worker PID31901/31902及启动时间保持，默认用户模型参数未改。工作区含G9E候选，手动重启会加载候选；本轮没有切换后端。

[数据库只读对照](evidence/2026-10-24-g9e-runtime-final.json)：49张表，无删除表；97条原命令字段摘要不变，94 complete、1 failed、2 running，state_version均为1。仅持续运行Worker涉及的investment_actions和investment_outbox两表摘要变化，不能称整个库字节静止。没有原账户重置、迁移或实验资金执行。

下一阶段优先区分账单literal商户筛选与目录实体身份，改善结构化输出在固定预算内的可靠性，并另立更充分的文本事实/否定检测契约。不得强翻ambiguous、不丢筛选条件、不放宽授权校验，不把截断或HTTP失败改成业务通过。之后仍需实现查询授权后的订阅原请求接续、独立未见样本、剩余多轮/故障与容量验证、更新可复现交付包及接收方验收。本阶段没有新安装包、真实银行资金交易或比赛提交，完整目标保持active。


补充transfer02的同一实际raw在冻结G9D中澄清、G9E中no_action，独立重放支持“旧稿”wrapper修复。补充card02首轮已给出完整两literal范围；这仍不算mixed scope修复触发。两份语义审查绑定完整case与每条raw，保留不可评、错误和有限匹配规则的范围。


[两组独立运行证据复核](evidence/2026-10-24-g9e-independent-evaluation-review.json)确认121次attempt全部闭合且HTTP200，53条semantic raw与尝试完整对应，265源文件和28评测依赖无漂移，固定预算和两份summary独立重算一致。这位复核agent曾实现本轮runner，故其角色是独立的运行证据复核，不冒充对runner作者完全独立的实现审查。


[最终文件完整性](evidence/2026-10-24-g9e-final-integrity.json)与[证据清单](evidence/2026-10-24-g9e-evidence-manifest.json)索引本阶段报告、原始结果和浏览器附件；当前265文件、实际冻结副本及G9/G9B/G9C/G9D历史副本均逐项核对，原题面/父manifest保持。环境密钥留在权限0600的本地.env，不进入交付报告。
