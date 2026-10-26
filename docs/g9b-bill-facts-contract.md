# G9B 账单发现粒度与复核事实契约

日期：2026-10-24。本文是 G9 首轮结束后的产品契约澄清与修复说明，不修改首轮题面、标签、评分器、报告或 11/36 原分。此处纯测试不表示真实云模型验收。

## 周期费用提示可以逐笔或分组

公开 `BillFinding.transactionIds: string[]` 没有要求一条 `RECURRING` 只能包含一笔当期流水。原实现的 `current.length === 1` 因而是一个未在公开类型中说明的粒度限制。推荐公开采用以下通用契约，使服务端现有逐笔生成和上游合法分组表示均可使用同一个验证器：

- 至少一笔账单本月流水和一笔紧邻前月的原流水，所有引用 ID 唯一且实际存在；不得仅用前月流水构造当月发现。
- 所有组员必须为 `SYNTHETIC_STATEMENT` 来源的 `OUT`，账户、商户原名、整数分金额全部一致；不能只验证组内第一笔。
- 当月成员的实际入账时间按北京时间归属当前报表月份；历史支持成员必须属于紧邻前月。跨年同样按月份计算。
- 历史引用仍保留原始时间、商户、金额和来源。在查询本月时，它只支持周期提示，标为 `finding-support-only`、`excluded-from-query-total`，不得再次计入本月支出。若查询明确包含两个月，同一原流水仅在其所属月计一次。
- 不同商户、账户、金额、方向、来源或不正确月份的成员仍被拒绝。非周期发现不得引用其他月份流水。

`RECURRING` 只表示有前月匹配支出的可能周期提示，不足以确认订阅合同、银行扣款授权或取消权限。本次没有删除 finding 或隐藏合法支持原文，也没有按案例 ID 分支。

## 缺失、局部数据与真实零

`BillAnalysis` 是复核及用户结果的确定性事实底座。账单 `coverage=missing` 时，`BillReport` 的金额零值只是存储占位，无法证明当期收入、支出或净额为零。

`buildBillReviewFacts({ analysis, report?, reports? })` 输出：

- 原样的结构化 `analysis`，包含 `status/kind/periods/missingPeriods/filter/amountMinor/transactionIds/evidence`，以便保留筛选口径和来源。
- 每个请求月份的 coverage 与金额状态。经 analysis 接受的完整报表为 `known`，局部报表为 `partial`；缺失、未提供、重复或未通过分析证据校验的报表为 `unknown`，`incomeMinor/expenseMinor/netMinor` 均为 `null`。未知金额不通过旧的原始 `bill` 入口再次暴露为已知零。
- 完整空账单仍可为 `known` 的真实零；局部零只能是已提供数据中的零，不能代表整月。缺失总查询没有 `amountMinor`。
- 经确定性分析引用的原流水事实及 provenance；支持流水与本次回答使用的流水明确区分。范围外报表不进入复核事实。

函数应与 `analyzeBills` 使用同一份冻结输入。报表金额及显示流水字段必须匹配 analysis 的来源记录才能附上 provenance。它不取代服务端报表生产器对完整原始数据的责任，也不宣称合成账单代表外部银行的全部账户活动。

请求修饰词只在修饰查询动词时被剥离。例如“请准确告诉我［月份］总支出”保持汇总，不能提取出商户“准确告诉我 总”；“准确书店”这样的实际商户原名仍完整保留。

## 复核输出只允许结构化判断与实际证据引用

`billReviewAssessmentSchema` 使用严格结构：

```ts
{
  assessment: 'consistent' | 'partial_data' | 'missing_data' | 'unsupported';
  evidenceSources: string[];
}
```

`validateBillReviewAssessment(facts, value)` 校验严格结构、判断与 analysis 状态一致、引用来自真实 evidence、引用不重复；存在可用证据时至少引用一条。无来源的 unsupported 分析允许空引用。对应错误为固定 `BILL_REVIEW_*` code，不能用自由文字编造金额、商户或缺失原因来补救。

`renderBillReviewAssessment(facts, value)` 仅用服务端的 analysis 摘要和 findings 渲染对外文字。它不接受模型自由 summary/findings，也不包含或改变 `approved`。调用方仍须将校验错误纳入有效复核通过条件；顶层独立复核的拒绝决定不得强制改成通过。混合领域也应保留此账单结构，其他领域使用独立的结构化判断和有限原因代码。原始模型输出可保留在审计诊断中，不能作为确定性账单事实再次展示。

该结构限制的是可发表的事实与引用，并不证明模型完成了充分的独立推理或总体业务质量已通过验收。原始 approval、有效 approval、确定性校验错误及事实来源需要分别留存。

## 本次纯验证

`tests/g9b-bill-facts.test.ts` 新增 41 项，覆盖合法一前月两当月及多前月分组、账户/商户/金额/方向/来源/月份/重复/缺引用配对负例、前月不重计（包括同时查询两个月）、缺失/局部/真实零、净额 provenance、请求动词与实际商户边界、typed assessment 不匹配与虚构引用/文案拒绝。

与既有 `tests/g8c-bills.test.ts`、`tests/g8d-bill-evidence.test.ts` 一起运行，3 文件 87/87 通过，0 跳过。测试使用纯输入和适配器，不访问数据库或云模型。全仓类型检查在首版事实 helper 后通过；增加 typed review helper 后的检查发现并行修改中的 `semantic-intent.ts` 调用参数未完成（最近一次为第 756 行的 TS2554），需由主 Agent 冻结整合后重新检查。该结果不推断 G9B 实际云端通过率。
