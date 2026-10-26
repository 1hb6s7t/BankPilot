# G9D 原文抽取与受限重提取契约

本阶段保留现有 schema shape、原文覆盖、否定、实体唯一性及金额/日期校验。改动集中于 [`semantic-intent.ts`](../packages/agents/src/semantic-intent.ts) 的 schema 说明、模型输入首部 `sourceBindingContract` 和现有 `runtimeSchema.superRefine` 内的一次受限重提取；没有另建模型调用或改变授权、执行能力。`card-locator.ts` 没有新增改动。

模型契约要求：单任务优先 `whole_message`；多任务的每个 scope 都必须为独立完整原文，全部禁止 `whole_message`。scope 包括对象前文、局部否定、条件、资金来源和末尾展示约束。集合查询为一个任务并省略单一 entity；单卡使用完整目录名称或 `尾号2857` 一类完整字段，不能只给数字。重复 mention 或其他重复原文需要精确 UTF-16 offsets。纯历史、引用及当前禁止而没有正向请求时，用一个覆盖原消息的 inactive task，不能为每个动词重复创建 `whole_message` 任务。

## 资格证明与正式抽取

受限重提取只针对已记录的来源绑定错误：多任务的 `SCOPE_TRUNCATED`、`SOURCE_COVERAGE_INCOMPLETE`、`WHOLE_MESSAGE_MULTITASK`，以及直接 `entity.mention` 的 `SPAN_NOT_UNIQUE`、`ENTITY_TOKEN_TRUNCATED`。既有精确日期、期间及 scope 修复保持优先。

重提取前必须存在通过完整原文验证的反事实候选，证明**同一非 source 语义**可以成立。候选只用于资格和最终结果约束，不直接交付用户，不发送给模型，也不填补用户未提供的信息。正式结果仍必须由第二次模型响应独立提交，再次通过原有完整验证。

- scope 资格搜索最多 4 个任务、10 个引号外标点、48 个分区。引号内部标点不作为任务边界；字面 scope 必须能在原文精确定位并包含操作线索。多任务 whole-message 冲突仅在原任务全部使用该标记时进入此资格检查，既有 mixed whole/literal 单次拒绝契约保留。
- 实体资格搜索最多 32 个原文候选，仅使用同 kind/id 的目录名称、别名或完整卡尾号字段。重复 mention 保留同一文本并补 offsets；实体边界错误仅可修正被指出的那个 mention 原文范围。
- 候选须完整保留所有当前活动任务，不能靠原校验将其中一项忽略后宣称修复成功；额外领域、对象、条件及未表达关系也参与保守资格否决。

任务数量、顺序、operation、disposition、entity kind/id，以及金额、备注、用途、日期、期间、funding 的原文均锁定。允许修正 scope 和 offsets；只有已证明的实体边界错误额外允许该 entity mention 的原文范围变化。第二份输出除完整通过来源/覆盖/否定/实体/值校验外，非 source 结果还须与资格证明一致。语义字段漂移返回 `SEMANTIC_SOURCE_REPAIR_DRIFT`，不能通过删除任务、交换对象、缩小金额或改写否定来通过校验。

缺金额、缺期间、未知对象、不能唯一绑定的身份、条件/选择、等待到账或确认后再办、明天等延期表达，不由本修复补全或重新解释。缺年份沿用原专用澄清契约。`QUOTED_ARGUMENT_UNRESOLVED` 没有新增通用重提取策略；未知引用对象及 no-action 处理仍服从原文验证。超过有限搜索上限或无法证明资格时保持原澄清/失败结果。

## 调用预算与证据边界

重提取使用原 `invokeStructured` 的结构修复通道。G9D 固定配置仍是 **2 次总 attempt、1 次结构 repair、每次 semantic 输出上限 4096、请求超时 60 秒、共享 case 截止 180 秒、总输出预算 32768**。两次 semantic 预留共 8192，包含在原总预算内。网络重试、JSON/schema 修复和来源重提取消耗同一 attempt/repair 额度；已经耗尽 repair 时不会另起调用。第二次 HTTP 或基础 schema 故障仍是系统失败，不能借用第一次来源问题伪装成业务澄清。共享取消或截止后不继续派发。

provider 的安全反馈仍只提供经过过滤的 issue code/path，不传 Zod message、输入值或反事实答案。模型输入中的固定 `repairInstructions` 解释应保留的字段及完整复制要求，不依赖动态错误文本。受控 adapter 保持单次，不能自动得到资格候选。

[`g9d-semantic-source-binding.test.ts`](../tests/g9d-semantic-source-binding.test.ts) 的 **47/47** 个新增受控测试通过，覆盖重复 alias、完整卡实体、引号内标点、多任务范围、现金来源、字段漂移、缺 slot、否定/条件/延期、未知身份、第二次 HTTP/schema 故障、已消耗 repair、预算及取消。连同既有语义/安全测试，**18 文件 765/765** 通过；类型检查通过。此前 44 项是中间检查，最终新增数量为 47。

这些证据仅证明受控响应下的来源契约与调用约束；没有在本子任务调用云模型或数据库，不是原 36 例、新 12 例的真实模型成绩，也不证明未保存的历史模型 spans 已被修复。后续真实 trace 必须按冻结候选独立记录；raw 观察仅是合成评测的本地证据，不进入用户结果或普通生产日志。
