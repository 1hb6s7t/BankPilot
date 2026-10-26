# G9G 账单只读 predicate 与执行实体的抽取契约

本片仅修改 `semantic-intent.ts` 的固定模型提示和现有字段的 schema description，新增独立纯测试；不增加结构字段、不改 `bills.ts`、共享 contracts、评分器、旧 fixture 或冻结副本。它是待真实模型验证的抽取指导候选，不能据纯测试宣称 bills02 已真实通过。

## 已知失败与因果边界

依据 [`2026-10-24-g9e-bills02-merchant-boundary-review.json`](evidence/2026-10-24-g9e-bills02-merchant-boundary-review.json)，G9E bills02 实际 raw 为 `bills_query / ambiguous / whole_message / period=2026/10`，**没有 entity 字段**。validator 因 ambiguous 提前澄清，issue path 使用 entity 只是该分支的分类，不能称为已经调用实体目录查找并失败。通用“仅使用目录 ID、未知对象要澄清”的提示可能给模型带来错误压力，这是设计推断；保存的 raw 不包含可证明该动机的理由。

已有的 `bills_query + 完整 scope + 原 period` 能表达商户、类别与完整条件，账单 parser 已从原始 source 计算过滤，而非依赖执行实体 ID。因此本片优先修正提示边界，不新增 billQuery/filter 字段，也不为已知文本写运行时翻转规则。

## Operation-specific 指导

- bills_query 读取账单记录。商户名称、类别和其他查询条件是**原文 predicate**，保留在完整 scope 中；预期抽取应省略 entity。它们不要求成为 payee、position、card 或 subscription 目录项。
- 一个名称不在执行目录中，或者完整账单没有匹配行，本身不等于请求对象歧义。对完整明确的查询，不能仅因此标 ambiguous，也不能臆造 ID。实际支持的含义、完整零结果、partial 或 missing 数据仍由确定性账单 parser 和 coverage 决定。
- period 只包含完整原时间表达，包括显式年、所有选择月份及连接词；不得混入商户/类别词。scope 必须保留每个原查询条件、金额/时间限制与流水证据要求，不得改成整月汇总。
- 同一个字符串若用于付款或订阅变更，仍须有对应独立任务和正式目录实体绑定。不能从账单商户 predicate 获得付款或取消/阻止权限；即使该文字同时出现在某个已保存收款人或授权订阅中，纯账单问题仍只读取账单。
- 请求本身不明确或超出支持范围时，仍保持 ambiguous/unsupported 或由正常源范围校验/parser 澄清。不允许删 predicate、猜缺失值、扩成全月或吞掉后续任务来满足结构。

这些约束同时写入原 entity/scope/period 的 wire schema description、新 `sourceBindingContract.billQueryScope`，以及主提示中对目录 ID 的作用域限定。模型看到的输出字段集合保持原样；没有添加商户目录、账单数据提示或新的财务数据读取。

## 运行时保留的门禁

本片没有改变 `validateSemanticIntent` 或 `interpretSemanticIntent` 的 runtime refinement 段；相对于 G9E 冻结源，这两段逐字比较相同。schema description 只改善模型指导，不改变允许的字段形状、解析器或 guard。

- ambiguous 不自动转 query，也不新增重提取资格。受控测试首轮给 ambiguous、预留第二轮 query 时，实际仅调用一次并澄清。
- 现有缺 period 的一次有预算 repair 可以继续使用，但必须保留整条 source。source-only 资格、非 source 槽位锁、两次 attempt/一次 repair 和共享预算不变。
- 如果模型仍提交 entity，原 grounding 继续执行；本片不会自动删除该 entity 或制造一个 ID。对已存在且正常通过的旧实体入口没有新增运行时禁用规则。
- 原文全覆盖、时间完整性、否定/引用、独立任务和执行实体唯一性校验继续适用。裁掉商户或未知尾句、缩短期间、把未知付款对象伪装成账单 predicate 都不能获得执行提案。
- 当前未知**带引号商户名**仍可能在通用 quote guard 返回 `SEMANTIC_QUOTED_ARGUMENT_UNRESOLVED`，尽管账单 parser 单独能够处理某些带引号名称。本片没有放松这个既有来源边界，也不宣称所有 literal 形式均已端到端支持。若后续支持，需单独证明完整只读 predicate、引号 noun 边界及引号外条件，不能用目录豁免来处理。

## 纯验证证据

[`g9g-bill-query-semantic.test.ts`](../tests/g9g-bill-query-semantic.test.ts) 使用独立合成名称、金额和流水，覆盖：

- 实际 provider 序列化后的固定指令/schema description 以及不变输出字段集合；所有 HTTP 使用本地 mock，没有真实模型调用。
- 无执行目录、名称恰好匹配 payee、名称恰好匹配授权 subscription 时的完整账单原文与 period，均不借 entity 过滤或激活写操作。
- 商户两行 1785+2468=4253 分，排除同类别邻近商户和同名收入；餐饮类别另计 5277 分，证据编号分别保持。
- 未出现的独立商户在完整覆盖时为真实零；partial 空行或部分金额不升级为 complete，missing/未提供账单不当零。
- 周末、排除阈值、按周、第二商户等复合/未支持条件，要么现有语义门禁澄清，要么把完整 source 交给未修改 parser 后返回 unsupported；不能回答无筛选整月值。
- 未知付款/订阅实体、伪造 entity、source/period 裁剪、否定/引用和后续未知付款仍被原门禁拒绝。

31 项新测试通过；定向回归 15 文件、796/796 通过，最终 `pnpm typecheck` 通过。此前新增测试的 partial 表驱动参数形状有误，已修正测试数据封装，未改 parser 或业务期望。一次中间类型检查还遇到并行新增 G9G scorer 模块尚未落盘；最终检查已在该模块就绪后重新通过，没有将中间失败记录为通过。

这些测试证明提示被正确送入、结构/既有行为未被放宽，并保留明确覆盖与范围合同。它们不证明模型理解了新指令，也不构成云模型、数据库、浏览器或真实 bills02 的验收。没有 DB/cloud 调用。
