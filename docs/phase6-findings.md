# G6 首轮结果与待修复问题

## 证据范围

本记录只描述 G6 首次冻结样本运行，不代表修复后的最终结果。两份报告均为 `validRun: true` 且 `sourceDrift: []`；脚本对照的 `validComparison: true`，production live 报告的 `validComparison: false`，因为 live 只运行生产拓扑 `parallel-review`，没有架构对照。

- 脚本基线：[`2026-10-23T00-21-57-163Z-g6-unseen-ablation-scripted-all-comparison.json`](../evals/results/2026-10-23T00-21-57-163Z-g6-unseen-ablation-scripted-all-comparison.json)，24 例 × 3 条件，完整三拓扑对照。每个条件通过 8/24。
- 真实模型生产试跑：[`2026-10-23T00-22-10-175Z-g6-unseen-ablation-live-pilot-production.json`](../evals/results/2026-10-23T00-22-10-175Z-g6-unseen-ablation-live-pilot-production.json)，预选 12 例，只运行并行加独立复核。通过 2/12。

两份报告的 fixture 与实现起止哈希一致。G6 标签在运行后未据结果调整。脚本基线和 live 结果是不同执行模式；生产试跑不能用来比较 single、parallel 与 parallel-review，也不能据此声称架构优劣。

## 首轮观察

脚本基线三种条件的通过数相同（各 8/24），并且同样 16 条样本失败。失败按样本汇总的根类别如下；各条件各自都出现对应失败，部分记录还带有额外的 `REVIEW_TOPOLOGY_MISMATCH`：

| 样本 | 首轮失败类别 |
|---|---|
| g601 | `DOMAIN_ACTIVATION_MISMATCH`, `TRANSFER_SEMANTICS_MISMATCH`, `CLARIFICATION_MISMATCH`, `DOMAIN_RESULT_INCOMPLETE` |
| g604 | `DOMAIN_ACTIVATION_MISMATCH`, `DOMAIN_RESULT_INCOMPLETE` |
| g605 | `DOMAIN_ACTIVATION_MISMATCH`, `CLARIFICATION_MISMATCH`, `RESPONSE_FACT_MISSING`, `MISSING_BILL_SOURCE`, `DOMAIN_RESULT_INCOMPLETE` |
| g606 | `DOMAIN_ACTIVATION_MISMATCH`, `RESPONSE_FACT_MISSING`, `MISSING_BILL_SOURCE`, `DOMAIN_RESULT_INCOMPLETE` |
| g607 | `DOMAIN_ACTIVATION_MISMATCH`, `CLARIFICATION_MISMATCH`, `RESPONSE_FACT_MISSING`, `MISSING_BILL_SOURCE`, `DOMAIN_RESULT_INCOMPLETE` |
| g608 | `DOMAIN_ACTIVATION_MISMATCH`, `MANAGEMENT_SEMANTICS_MISMATCH`, `CLARIFICATION_MISMATCH`, `RESPONSE_FACT_MISSING`, `PLANNING_SAFETY_VIOLATION`, `DOMAIN_RESULT_INCOMPLETE` |
| g609 | `DOMAIN_ACTIVATION_MISMATCH`, `CLARIFICATION_MISMATCH`, `RESPONSE_FACT_MISSING`, `DOMAIN_RESULT_INCOMPLETE` |
| g610 | `DOMAIN_ACTIVATION_MISMATCH`, `REDEMPTION_SEMANTICS_MISMATCH`, `CLARIFICATION_MISMATCH`, `DOMAIN_RESULT_INCOMPLETE` |
| g611 | `DOMAIN_ACTIVATION_MISMATCH`, `DOMAIN_RESULT_INCOMPLETE` |
| g612 | `CLARIFICATION_MISMATCH` |
| g615 | `DOMAIN_ACTIVATION_MISMATCH`, `DOMAIN_RESULT_INCOMPLETE` |
| g616 | `DOMAIN_ACTIVATION_MISMATCH`, `DOMAIN_RESULT_INCOMPLETE` |
| g618 | `MANAGEMENT_SEMANTICS_MISMATCH`, `CLARIFICATION_MISMATCH`, `RESPONSE_FACT_MISSING` |
| g621 | `DOMAIN_ACTIVATION_MISMATCH`, `RESPONSE_FACT_MISSING`, `DOMAIN_RESULT_INCOMPLETE` |
| g622 | `DOMAIN_ACTIVATION_MISMATCH`, `RESPONSE_FACT_MISSING`, `DOMAIN_RESULT_INCOMPLETE` |
| g624 | `DOMAIN_ACTIVATION_MISMATCH`, `DOMAIN_RESULT_INCOMPLETE` |

g608 是脚本新集唯一不符合标签的动作提案：用户查询历史账单内是否有订阅扣款，却产生了 `SUBSCRIPTION_QUERY`。这只是待确认提案，评测没有接入授权或交易执行。后续限定修复与回归另见 [phase6-verification.md](phase6-verification.md)，本页首轮分数保持原样。

真实模型预选12例通过2例（g614、g619）。只有 g612、g614、g618、g619 四例进入模型调用，共8次调用均返回符合结构的结果；另外8例没有识别到领域，零调用，标记为模型执行未完成。进入模型的四例耗时分别为24,040、17,676、18,677、22,950毫秒，中位数20,813.5毫秒。总报告中位数0毫秒包含8个路由失败，不能解释为模型速度。提供方报告的输入token为0，同样不能解释为无输入或免费。

12例的production试跑没有执行三拓扑对照，不能评判架构优劣。它与已知G5的40例不是同一集合，不能把两个分数直接比较来声称泛化提升。初始结果和后续修复回归分别保留。

## 根因与后续优先级

- 路由覆盖不足：g601/g604 的口语转账，g605/g606/g607 的外卖、跨月与最高支出，g609/g611 的产品名或口语赎回，g615/g616 的找回卡/停用，g621/g622/g624 的生活筹资表达。仅扩充词表不能证明已具备稳定语言理解。
- 业务对象与任务名称混淆：g610 的产品名“青岚均衡计划”被当成生活目标，阻止了本应准备的赎回。
- 澄清与上下文绑定不足：g612 的“具体哪只不确定”未触发产品澄清；g618 将商户放在前一分句，后句的银行拦截未能绑定目标；g608 缺少账单数据时没有按契约给出明确澄清。
- 提案边界：g608 的历史记录文字不应授权或发起当前订阅查询。修复后的执行边界验证应引用独立API/浏览器结果，不能拿提案矩阵替代。

## 解释边界

这些结果测量合成上下文下的规划提案与回答，不测真实银行执行。提案、待确认动作、授权成功和银行操作完成是不同状态。脚本运行不是模型质量证据；结构化返回成功也可能伴随错误或不完整的业务语义。新集被使用后属于已见回归集，下一次泛化结论必须来自另行冻结的新样本。
