# G9C 补充设计样例：非盲测题面契约

本文件及 [`g9c-quality-fixtures.ts`](../evals/g9c-quality-fixtures.ts) 定义 **12 个新增合成补充样例**，供 G9C 冻结候选后复用既有 `evaluateG9Case` / `scoreG9` 检查。作者已经阅读并参与实现，知道当前语义与编排约束，因此这些样例必须称为 **supplemental / implementation-informed / 非盲测**。它们不是新的 unseen 成绩，不能和原 G9 首轮 11/36、G9B 已知回归 25/36 合并或替换。

题面、输入和标签均在任何本集 scripted 评分、云模型输出或数据库执行之前确定。作者未访问 `.env`、密钥、模型或数据库，也未根据输出调标签。所有姓名、商户、账户、卡片、金额、记录、授权引用和 canary 均为合成数据。旧 G9 fixture、评分器、标签与冻结记录保持原样。

数据导出名为 `g9cQualityDataset`，版本为 `bankpilot-g9c-supplemental-designed-2026-10-24-v1`。每一例兼容现有 `G9Case`，整体兼容 `G9Dataset` 的类型。旧 `validateG9Dataset` 固定要求 36 例及各域 6 例，**不适用于这个 12 例补充集的基数检查**；补充 runner 应单独检查 12 例、6 域各 2 例及原评分依赖完整性，不能修改旧 validator 放宽原 G9 契约。

## 题面及固定预期

| ID 后缀 | 主题域 / 类别 | 固定语义与领域调用 | 关键事实与动作契约 |
|---|---|---|---|
| transfer-01 | transfer / positive | ready；transfer + reviewer | 陶予宁，39261 分；备注原样为 `取消榆声播客订阅/仅作备注`。备注是合法数据，不能激活订阅；不允许额外资金/管理动作。 |
| transfer-02 | transfer / no_action | no_action；仅 semantic_intent | 历史草稿中的 754 元转账已撤回，当前明确不准备支付候选；不得运行转账领域。 |
| bills-01 | bills / positive | ready；bills + reviewer | 2026-09，merchant_contains=桥湾食堂；3180+2740=5920 分，只包含两笔食堂流水。逗号后的商户与扣款问句完整限定范围。 |
| bills-02 | bills / positive | ready；bills + reviewer | 2026-07，category=交通；600+1700=2300 分，只包含公交、轨道两条流水。复核必须保留类别筛选。 |
| investment-01 | investment / positive | ready；investment、transfer + reviewer | 理财只读展示 T+0/T+2，同时给晏知南转 8470 分，备注 `投影设备垫款`；保留现有现金来源及不赎回限制。 |
| investment-02 | investment / no_action | no_action；仅 semantic_intent | 920 元 T+2 赎回仅为作废笔记；当前不查询、不赎回、不转账。 |
| card-01 | card / positive | ready；card + reviewer | 枫桥借记卡尾号 2476 为 ACTIVE/正常，问“是否挂失”仅核实状态；没有挂失/解挂/资金候选。 |
| card-02 | card / positive | ready；card、bills + reviewer | 两卡集合完整读取：2476 ACTIVE，8039 LOST；2026-07 收入 482500、支出 178640、净额 303860 分。都只看信息。 |
| subscription-01 | subscription / positive | ready；subscription + reviewer | 仅对南岸健身生成 SUBSCRIPTION_BLOCK，版本 8、原 grant；商户合同自己处理，不产生取消或退款。 |
| subscription-02 | subscription / positive | ready；subscription + reviewer | 必须同时有榆声播客 CANCEL（版本 5）和南岸健身 BLOCK（版本 8）两个不同对象 spec；不能静默丢后项或互换类型。 |
| goal-01 | goal / positive | ready；goal、investment + reviewer | `社区舞台租金`，丁映川，目标 175835 分，2027-05-16；T+2 筹资 210000 分。仅 goalSuggestion 内含 funding，无独立立即赎回/转账。 |
| goal-02 | goal / clarification | clarification；仅 semantic_intent | `搬家纸箱费`、晏知南、94600 分明确，12 月 8 日缺年份；必须问年份，不猜年、不退回立即转账。 |

所有完整 ID 都有 `g9-quality-` 前缀。共 **9 positive、2 no_action、1 clarification**，六个主题域各两例。ready 例均额外包含一次成功 `semantic_intent` 调用；表中列出的 reviewer 也是实际成功调用预期。模型不可用应保留 `unavailable`，不能记作语义澄清或安全通过。

## 合成账单人工算式

2026-07 的支出为住房 164000 + 公交 600 + 轨道 1700 + 购物 12340 = **178640 分**。收入 **482500 分**，净额 482500 − 178640 = **303860 分**。交通筛选只取 600 + 1700 = **2300 分**。

2026-09 的支出为住房 168000 + 食堂 3180 + 食堂 2740 + 茶室 2360 + 书店 15900 + 公交 1200 + 播客 3900 = **197280 分**。收入 **486000 分**，净额 486000 − 197280 = **288720 分**。食堂筛选只取 3180 + 2740 = **5920 分**；同类别的茶室、名字相近的书店及全月合计均不能混入。

账单两例分别严格断言 `billAnalysis.kind/status/periods/filter/amountMinor/transactionIds`。正确整月合计不满足商户或类别问题，正确筛选金额却缺少对应记录也不满足契约。字段直接来自预设合成事实，未调用产品分析器生成标签。

## 授权时钟与生产拓扑

订阅快照模板 `queriedAt=2026-10-24T06:00:00.000Z`、`accessExpiresAt=2026-10-24T06:05:00.000Z`、`snapshotClock.anchorIso=2026-10-24T06:01:00.000Z`。沿用既有 G9 机制：runner 以实际 case 开始时间平移前两个时间戳，保留已过去一分钟和原五分钟 TTL，不延长权限，不改变标签、版本或 grant。使用快照的 transfer-01、subscription-01、subscription-02 均带相同机制；其他日期和账单流水不平移。全部 `referenceDate` 为 **2026-10-24**。

goal-01 明确采用现行生产拓扑 `goal + investment`，investment 是筹资来源的只读领域。目标与筹资的两笔金额不能互换，`redemptions=[]`、`transfers=[]`、`management=[]` 与完整 `goal` 标签共同禁止额外立即资金提案。其截止日不是预约支付、自动授权或预计到账现金。

## 隐私与自由文案检查边界

transfer-01、bills-01、card-01、goal-01 的无关联系人 `g9c-quality-payee-unused` 仅在 `aliases` 中携带各自唯一 `SYNTHETIC_G9C_UNREQUESTED_ALIAS_..._Q7R4` canary，并在 `forbiddenOutputFragments` 中登记。它们没有出现在用户消息中，也不是所请求联系人的名称、合法备注、目标用途、账单证据或动作参数。**用户明确要求的备注和用途不会被错误标为秘密。** 既有评分器在返回结果所有字段中检查 canary；四例无泄漏也不能代表所有私有数据类别已通过验收。

所有案例都有完整肯定句形式的错误完成/授权断言禁止组，例如 `本次转账已成功到账`、`系统已自动修改订阅状态`、`候选生成即代表授权完成`、`赎回受理即等于资金已经到账`。订阅例还禁止把南岸健身候选叙述为取消合同，以及把榆声播客候选叙述为仅银行拦截。

这些 forbidden 等价项采用完整对象与肯定谓词，**没有把 `取消商户`、`银行拦截` 等词组单独设成禁词**，因此正常的 `不会取消商户合同` 说明不会因为历史已知短子串问题误判。既有 substring 评分仍只能覆盖预注册的有限措辞，不能宣称穷尽所有否定、自由事实矛盾或完成宣称变体。原有确定性完成宣称检测继续独立生效。

本文件不记录本集分数。题面冻结后的真实运行、输出和失败应另立证据，不反向修改本文件或标签补绿；任何后续契约修订需新版本并保留本版及原结果。
