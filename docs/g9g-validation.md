# G9G：账单筛选语义、三套评分与独立测试库

2026-10-25。候选已冻结，36+12真实模型评测已完成；当前仍未满足完整验收或发布门槛。用户更换凭据后，G9F 单场景云浏览器已独立通过，本阶段继续处理六域质量证据。

## 实现及复用

沿用已有 LangGraph 多 Agent 编排、结构化语义工具、确定性账单解析、G9 预算与持久调用日志。本次账单变更只调整提示与 schema 字段说明：商户和类别的字面筛选不需要付款或订阅执行 ID。校验器与 bills.ts 与 G9F 保持一致；不将 ambiguous 自动翻转为 query，也不删除无法解析的条件。带引号未知商户仍有既有限制。

新增独立版本 G9G 评分器，在同一结果上保留原 G9、前版 G9E、新 G9G 三份分数。有限规则补充对象绑定的本金/预留/可赎回表达及否定声明作用域，错误金额、未绑定事实或实际肯定执行不能被正确片段掩盖。历史报告不回写，标签沿用 G9E。

新增 `pnpm test:isolated`，复用现有 PostgreSQL 和 Better Auth 迁移，为一次全仓检查创建随机独立数据库。子进程只继承必要环境，三个 DB 变量均覆盖；确认进程组消失、迁移结束、数据库 OID/owner 匹配且零会话后，才普通 DROP 并核实不存在。创建结果未知或清理不确定则留库报错。

## 多 Agent 分工与审查

GPT-6.1-sol/xhigh 负责语义边界，并独立审查测试隔离；GPT-6.1-sol/high 负责评分契约，并独立审查语义与评测协议；GPT-6-sol/high 负责隔离测试和前置证据验证，并独立重算历史输出。根 Agent 集成运行器、串行执行数据库检查与云评测，另做评分反例探针。高风险边界由非作者交叉检查；开发协作与产品的总控/领域/复核 Agent 架构分开记录。

隔离入口初审发现环境变量泄露和 leader 退出后 descendant 残留问题，修后审查通过，初审证据保留。评测初审发现可通过替换 results-dir 绕过同阶段唯一运行记录；真实 CLI 已固定输出根，离线注入仍可用临时目录。

## 本地验证

[独立库全仓日志](evidence/2026-10-25-g9g-isolated-full-check.log)：120 文件、3165/3165 测试，类型检查及构建通过。之后只修改评测 CLI 的输出根限制及断言，[26/26 定向复测](evidence/2026-10-25-g9g-fixed-entrypoint-tests.log)与[最终类型检查](evidence/2026-10-25-g9g-final-typecheck.log)通过；没有把这一后续定向复测说成重跑全仓。

[隔离库清理记录](evidence/g9g-isolated-test-2026-10-25T05-03-27-174Z-9bae47b1-b831-483a-ae53-1a59daff3d7b/cleanup.json)显示子进程组已消失、库身份匹配、库已删除且不存在。原演示库[前后只读比对](evidence/2026-10-25-g9g-runtime-after-isolated.json)49 张表全部摘要不变，97 条命令仍为94 complete/1 failed/2 running。构建主 JS 787.35 kB、gzip 228.86 kB，仍有超过500 kB警告，未宣称容量优化。

[运行器独审](evidence/2026-10-25-g9g-runner-independent-review.json)、[语义独审](evidence/2026-10-25-g9g-bill-query-semantic-independent-review.json)、[评分独立探针](evidence/2026-10-25-g9g-score-independent-review.json)、[隔离工具初审](evidence/2026-10-25-g9g-isolated-runner-initial-review.json)及[修后独审](evidence/2026-10-25-g9g-isolated-runner-independent-review.json)分别保存纯测试、受控传输、mock 与真实进程证据；这些不是云模型或数据库业务验收。

## 历史同输出重评分

[独立重算](evidence/2026-10-25-g9g-rescore-g9e-raw-independent.json)对未改写的 G9E 输出计算三分：已知36分别32/33/34，补充12分别9/9/10。G9E→G9G仅修正 investment-01 持仓余额表达和 quality-subscription-02 否定声明误报；旧 bills-02 仍失败，三例截断仍不可评。这是评分测量差异，不能描述为模型产品能力改善。

## 本轮真实模型验证

[协议](g9g-validation-protocol.md)和[manifest](../evals/g9g-manifest.json)绑定285个文件及源码副本、固定36+12输入、原标签/新标签、三评分版本、预算和provider。2026-10-25T05:06:12.781Z冻结；指定 deepseek-v4.1-flash、json_object、thinking/reasoning默认省略。真实CLI先36例已知回归，再12例开发知情补充，每组一次，必须记录semantic raw trace，不能挑选重跑或改写失败。

[已知36报告](../evals/results/g9g/default-known-2026-10-25T05-06-38-075Z-5be896ae-4bce-40ae-8298-80012b8910ee/report.json)和[补充12报告](../evals/results/g9g/default-quality-2026-10-25T05-18-27-677Z-9ae0b735-53a7-4f13-8f9f-187fcff3b216/report.json)分别完整执行，各自 validRun=true；该字段只表示执行与证据有效，不代表所有业务通过。

| 本轮样本 | 原G9 | 前版G9E | 当前G9G | 可评 | 不可评 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 已知36例 | 32/36 | 34/36 | 35/36 | 35 | 1 |
| 开发知情补充12例 | 12/12 | 12/12 | 12/12 | 12 | 0 |

本轮已知组同输出口径差异：goal-03、goal-06使用G9E已登记的筹资目标依赖标签；investment-01由G9G补足对象绑定的可用金额表达。因此原G9的32不能直接称为35的产品能力提升。补充组本轮原G9也全部通过，不需要用G9G否定规则补分。

[bills-02独审](evidence/2026-10-25-g9g-bills02-live-independent-review.json)确认本次首轮query、完整原文、2026/10期间、商户名称包含青苔便当店，恰选两笔32+28元明细，结果60元，未混入同餐饮其他商户。三口径全过；历史同输入G9E为ambiguous并澄清，本次结果改善不只来自评分变化。顺序实验和凭据条件差异不能证明单一prompt因果。

**唯一当前契约未过案例为card-06不可评。** [独审](evidence/2026-10-25-g9g-card06-truncation-independent-review.json)确认语义抽取成功且原始JSON与G9E逐字一致，卡片分支成功；账单分支两轮均HTTP200、各4096输出上限且实际输出4096、finish=length，整例没有完整result或候选，reviewer未启动。G9E同输入此前可评通过，故本轮存在实际可用性回退。账单正文未保存，仅有长度/digest/usage遥测，不能猜测其片段内容。没有补跑或临时扩预算覆盖失败。

已知组93次实际调用（89成功、4失败），补充组36次（33成功、3失败），全部HTTP200、起止闭合，受控替代0；7次失败为5次截断及2次schema不符，其中5次在既定重试/结构修复预算内恢复，余2次组成card-06最终不可评。所有case预算未超32768，未临时修改参数。

两组供应商usage均完整：已知组输入232893、输出102104 tokens，补充组输入88368、输出42571；不将reasoning另加到output总量，不据此猜价格。全case中位/P95分别15.959/46.795秒和24.935/54.632秒，组别/样本不同，不宣称一般性能或容量达标。

当前没有新浏览器UI重跑、新未见集、容量、交付包或比赛提交结论。此前G9F的单订阅真实云闭环仅属该版本的历史场景证据。

## 后续门槛

先关闭本轮实际失败，再补同版关键多轮与恢复；候选稳定后由独立人员准备并封存真正未见集，进行首测；随后按明确演示规模测有限负载与长尾，最后重新导出并在接收方环境复现。48个既有样本全过也只满足已知回归门槛。跨进程持久队列、全面可观测改造、bundle拆分和任意跨域组合不自动成为本阶段前置，仅在承诺或测量需要时推进。

## 收尾与状态

[原库最终核对](evidence/2026-10-25-g9g-runtime-final.json)仍为49表全部摘要不变、97条原命令不变。候选保留为未发布状态；card-06截断是下一阶段首先需要关闭的质量缺口，不能用补充12/12抵消。[独立整组审计](evidence/2026-10-25-g9g-live-independent-audit.json)已重算三评分、三汇总与全部调用/语义trace绑定，issues为空；[最终完整性](evidence/2026-10-25-g9g-final-integrity.json)记录285个源码与副本及配置密钥扫描。[端口实查](evidence/2026-10-25-g9g-runtime-ports.json)确认5178/8787均未监听，未启动未发布候选。
