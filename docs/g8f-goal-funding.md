# G8F：生活目标与赎回筹资的关系边界

本项修复针对“未来目标金额与截止日已完整提供，另从指定持仓赎回另一金额作为资金来源”的识别与校验边界。实现只调整通用语义提示并增加确定性来源关系守卫，不自动更改 operation，不进行 transfer→goal 模型重生成，不执行资金动作。

## 已观察到的问题与证据限制

G8D 已知回归 g722 的原文为“给陆星遥准备 920 元学费，2026-12-08前到账；先从星潮活期增强赎回1,000元”。该轮 semantic_intent 调用成功，但候选首任务被标为 transfer，附带该 operation 不允许的槽位，确定性校验返回 `SEMANTIC_UNEXPECTED_SLOT`。没有进入 goal、investment 或 reviewer，也没有创建目标或赎回提案。原始候选未落盘，因此只能确认 operation 与槽位组合不一致，不能推断具体 date/funding 内容或原文范围。历史结果和详细分类见 [G8D 失败分析](g8d-live-failure-analysis.md)。

独立本地探针使用另一组实体、金额和日期：

> 给陈禾准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元

正确的 goal_create 候选原本就能通过校验，并经既有 canonicalMessage 进入 `resolveLifeGoal`，保留目标64000分、完整截止日及指定持仓筹资90000分。因此本项不改 `intent.ts` 的关键词识别，也不改 `financial.ts` 的领域计算。

探针同时发现独立缺口：把“先从”改成“另外独立立即从”，或加上“这笔赎回与学费目标无关”，原先同一 goal_create 候选仍然 ready。持仓和金额分别正确，不能证明赎回就是该目标的资金依赖。模型即使复制了完整原文，也可能在 canonicalization 时抹掉独立操作或条件。

最初新增54例时，18例失败、36例通过，失败用来证明上述关系缺口，而非云服务故障。后续追加了措辞变体、嵌入条件与合法多任务对照，最终专项共75例。

## 守卫作用域

生产改动仅位于 `packages/agents/src/semantic-intent.ts`：

- 通用提示明确学费、医疗、旅行等未来准备目的也可以是 goal_create，不要求用户使用“生日”或“目标”关键词。提示要求分别绑定收款人、目标金额、完整截止日、资金持仓和赎回金额，禁止为套入 transfer 删除 date/funding，也不能把独立动作吞进 funding。
- `assertGoalFundingRelation` 只检查已经通过既有实体、金额、日期和子句绑定校验的 **goal_create 且含 funding** 候选。它在赋值 funding 和生成完整 canonicalMessage 前读取该任务的原始 scope。
- 守卫复用现有原文定位、实体目录唯一性、金额及日期解析、否定/历史/引文和全任务来源覆盖校验。没有新增依赖，没有重新猜测对象、金额、日期或权限。
- 守卫把五个已定位槽位替换成内部标记，检查赎回子句与目标之间的关系。它检查额外日期、独立/立即办理的歧义、明确无关或另作他用的声明，以及被单个目标遗漏的查询、转账或其他独立条件。未知的非槽位子句必须能完整表示为受支持的筹资关联、独立授权或到账后步骤关系，否则澄清。
- 检查以各任务 scope 为界。完整分离的 goal_create funding 与 bills_query 可以同时 ready；不是对整个请求禁用多任务。原文裁剪遗漏另一任务仍由既有来源覆盖检查拒绝。

新守卫仅拒绝候选，不生成或修复任务/槽位。新拒绝码为 `SEMANTIC_GOAL_FUNDING_RELATION_AMBIGUOUS`、`SEMANTIC_GOAL_EXTRA_OPERATION`、`SEMANTIC_GOAL_DEADLINE_AMBIGUOUS`；继续复用既有金额绑定错误和澄清返回结构。发生拒绝时返回空任务列表，不保留部分目标建议。现金目标、不含 funding 的其他任务继续使用原有校验路径。

## 合法依赖与独立操作对照

以下例子都使用相同已保存收款人及持仓；金额与日期没有被替换或归一化为另一笔请求。

| 原文关系 | 本地校验结果 | 边界 |
| --- | --- | --- |
| “准备640元学费，2028-11-20前到账；先从雾岚稳健组合赎回900元” | ready，单个 goal_create | 900元只进入 funding，目标仍为640元 |
| “另外从……赎回900元，作为这个目标的资金来源” | ready | “另外”不是全局禁词；完整关联说明保留依赖 |
| “现在从……赎回900元用于支付这笔学费” | ready | 明确用于该目标时，当前筹资不变成无依赖独立动作 |
| “先单独从……赎回900元用于学费，每笔动作单独授权” | ready | 分别授权不等于资金目的无关 |
| 目标目的为“独立研究课程学费” | ready | 目的名词中的“独立”不触发动作禁词规则 |
| 先写筹资子句“……赎回900元用于学费”，再写完整目标 | ready | 子句顺序不改变两金额绑定 |
| “另外独立立即从……赎回900元”且没有关联说明 | clarification，tasks为空 | 不能凭另一笔金额自动归为目标筹资 |
| “这笔赎回与目标无关／分开处理／和目标没有关系” | clarification，tasks为空 | 否定关系不得在 canonicalization 时丢失 |
| “赎回资金用于另外的旅行开销”或“目标资金来源另算” | clarification，tasks为空 | 不得把其他用途挂成该目标的 funding |
| 同一目标 scope 还包含“另外查询理财余额／然后查看到账规则” | clarification，tasks为空 | 完整复制原文仍不足以证明单任务覆盖全部操作 |
| 完整目标 scope 之外，另有完整“查询2027年3月账单”scope及 period | ready，goal_create + bills_query | 独立只读查询由另一领域任务保留 |
| 裁剪 scope，遗漏后面的独立立即转账 | `SEMANTIC_SOURCE_COVERAGE_INCOMPLETE` | 不能通过删除原文隐藏另一动作 |
| 全 scope 含独立立即转账，但候选仍只有目标 | clarification，tasks为空 | 无法安全表达时不创建部分建议 |

专项还验证两个金额互换、遗漏显式筹资金额、截止日缺年、未知持仓、额外完整日期、否定/历史/引文输入，以及把原候选改成 transfer 后删除 date/funding 的情况。金额交换继续返回 `SEMANTIC_GOAL_AMOUNT_BINDING_INVALID`，缺年继续返回 `SEMANTIC_TARGET_DATE_INVALID`；带 goal-only 槽位的 transfer 继续返回 `SEMANTIC_UNEXPECTED_SLOT`，不会被静默改成 goal。

合法目标用例除检查 ready 外，还检查原始 source、两组实体与金额、完整日期，并把 canonicalMessage 交给现有 `resolveLifeGoal` 验证领域建议保持这些绑定及“每笔资金动作独立授权”的说明。没有生成独立即时赎回任务，也不把预期赎回到账视作当前现金。

## 本地验证记录

2026-10-23 完成以下无数据库、无云调用验证：

```text
/Users/auriel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vitest/vitest.mjs run tests/g8f-goal-funding-boundary.test.ts tests/semantic-intent.test.ts tests/semantic-quality-regression.test.ts tests/semantic-whole-message.test.ts tests/g8d-semantic-repair.test.ts
```

最终结果：5文件 **292/292通过**，其中新增专项 **75/75通过**；最终一次执行在本机21:20:07开始，耗时767ms。独立两scope正例初次已 ready，但测试预期误用了 `period` 字段；将断言改为既有 `billPeriod` 契约后通过，没有为该正例改生产逻辑。

```text
/Users/auriel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/typescript/bin/tsc --noEmit
```

类型检查通过。更早一次合跑含旧 `agents-financial.test.ts`，311通过、7失败；其中7项属于同时进行的 G8F 阶段失败契约迁移（schema、候选契约及HTTP401改抛 PlanningStageFailure），已单独交给负责该迁移的 Agent，未修改其历史断言。本项最终292例只报告本守卫及相关语义校验回归，不代表全仓统一验收结果。

## 未验证与保守边界

本项没有读取环境配置、访问数据库、调用真实模型或运行浏览器。它证明受控候选的确定性边界及通用提示已更新，**不证明真实模型现在会把 g722 正确识别为 goal_create**，也不证明目标的授权、执行或实际到账已经完成。后续真实调用必须另存结果，保留历史失败。

关系检查是有限的来源校验，不是自然语言语义证明。复杂或尚未支持的筹资表述可能保守澄清；不以删去条件、补齐未知持仓或自动更改 operation 来提高 ready 比例。尤其不能从“为学费准备资金”泛化到任意转账都可转成目标。若后续授权有界 model regeneration，应单独审查完整原文、任务集合、两组对象/金额、期限及资金依赖的不变性；当前没有实现该分支。
