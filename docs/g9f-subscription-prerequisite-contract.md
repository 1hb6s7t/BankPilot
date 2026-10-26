# G9F 无查询授权订阅原请求的纯语义前置契约

本片实现 [`subscription-prerequisite.ts`](../packages/agents/src/subscription-prerequisite.ts)，供 API 在没有可用订阅查询 grant 时识别可等待授权的原请求。它不是正式 `SemanticPlan.status='ready'`，也不产生管理 spec、订阅 ID、版本、查询 grant、授权或执行。G9E 冻结源码、manifest、原 fixtures/labels/scorer 与报告不改。

## 导出接口

```ts
type SubscriptionPrerequisite = {
  version: 1;
  message: string;
  tasks: Array<{
    operation: 'subscription_cancel' | 'subscription_block';
    source: { text: string; start: number; end: number };
  }>;
recognizeSubscriptionPrerequisite(message: string): SubscriptionPrerequisite | undefined;
verifySubscriptionContinuation(prerequisite: SubscriptionPrerequisite, plan: SemanticPlan): boolean;
```

接口不读目录、快照、数据库、网络或系统时钟。原消息逐字保存；所有 start/end 都是 JavaScript UTF-16 索引，`source.text === message.slice(start,end)`。一次成功返回 1..8 项，按原文顺序、连续且不重叠地覆盖整条消息，包括请求框架、局部限制、标点及展示要求。没有完整证明时整段返回 `undefined`，调用方沿原有语义/澄清路径处理；不返回一个已经识别的前缀。

## 有限的完整正向语法

识别器复用 `inactive-source` 的引号、原文子句及 inactive 检查，然后要求每个完整子句匹配以下一种结构：

- 明确取消商户订阅、订阅合同、会员或自动续费，如 `请取消秋浦听书的商户订阅`；退订要求明确对象边界，例如 `退订苔桥剧场的订阅` 或 `请退订完成书屋的服务`。取消扣款和取消一般事务不在本契约内。
- 明确银行侧阻止、拦截、限制、屏蔽或停止扣款，例如 `仅在银行侧阻止星屿健身未来扣款`、`阻止鹭湾工作室的银行扣款`、`对棠隅花房只做银行扣款拦截`。缺少明确银行边界的“阻止某某扣款”保守交给原路径。
- 针对银行阻止的完整对象声明，如 `棠隅花房的合约我自己联系商户` 或 `保留棠隅花房会员`，随后同一任务明确在银行侧阻止这项订阅扣款。该声明不能被接到取消合同操作，也不能挪给另一个商户。
- 同一任务对另一侧的完整否定限制，例如银行阻止中的 `不要取消商户合同`、取消合同中的 `不要阻止银行扣款`；合同由本人联系商户处理也保持在银行任务 scope 中。否定本身不产生一项新任务；否定当前操作、指向另一具名对象的否定、未知限制都使整段不进入前置分支。
- 完整的待确认候选/提案展示要求或明确不执行，例如 `请分别生成待确认候选`。它们只保留原文，不授予任何权限。

多项独立请求要求逗号、分号、句号、换行等现有 source 子句边界；礼貌/顺序前缀按最多 8 token 确定性消费，任务数框架若明确写了数量，数量必须一致。无标点的 `取消A订阅并阻止B扣款` 当前保守返回 `undefined`，与正式语义校验器的标点范围边界保持一致。此片不扩展正式 source 边界规则。

对象只作为尚未核对的文字名称。名称长度与字符集有限，并拒绝能吸收其他操作、对象列表、时间/金额条件、否定、历史或假设的词法内容。`合约`、`合同`、`会员`、`订阅` 等普通域名词可以出现在完整名称内部，不能对子串一概拒绝；例如 `城市健身合约`、`梧灯合同书院` 都只是待目录核对的名称。单独的 `合同`、`商户合同`、`会员`、`订阅` 等无名称泛称仍不进入前置分支。未知名称可以进入待查询状态，不能据此宣称目录存在该商户。语义不明的代词、集合、多选、两个对象黏连、带引用的名称/指令，以及品牌名恰含保留操作词等未支持表达均保守交给原路径。第一步不会猜测、修正或登记实体。

完全相同的名称（仅用于拒绝碰撞的 NFKC/空格/大小写归一视图）重复出现时，不产生重复或同一对象连续变更的前置任务。不同文字可能是同一商户的别名，前置步骤不能确认；授权后的正式实体绑定和 ID 去重必须再拒绝该情况。归一视图不改变返回的任何原文。

独立复审发现裸 `退订${任意未知名词}` 无法证明尾部是商户还是“成功/完成/失败/好了”等状态或结果谓语。最终契约保守移除裸形式：`退订苔桥剧场` 与 `退订成功` 都走原有普通语义路径，不由前置分支自动提出查询。正常名称 `成功剧场`、`完成书屋`、`失败乐队` 可以在有明确外层对象界定的 `退订成功剧场的订阅` 等请求中保留；不在 merchant 子串中追加成功/失败否定词表。

明确查询、查询后再写、其他领域、引用/历史/假设、问句、撤回、未知尾句、超过 8 项或超过 12000 UTF-16 单元的消息均不产生前置结果。不能因为其中出现“取消”或“扣款”就丢掉其余请求。

## 授权后完整核对

`verifySubscriptionContinuation` 先按同一原文重新调用完整识别器，对持久化 prerequisite 的版本、消息、任务数量、顺序、操作和精确 source 逐项核对；version 1 不接受额外的预先实体字段。API/store 仍需另外核对真实原用户消息、owner、原命令和摘要，不能把“能重新识别这个字符串”等同于真实来源认证。

正式计划必须来自**正常授权快照上的正式语义校验路径**，满足：

1. `ready`，没有 failure、待澄清内容或未解决 issues；若提供 recognizedRoles，只能是 subscription。
2. 全部 task 数量、顺序和 cancel/block 操作与 prerequisite 完全相同，role 均为 subscription；不允许增加查询 task、漏项或改办另一种操作。
3. 每项 source 的 text/start/end 都逐字逐数相同。缺坐标、只给 canonical、裁剪限制、交换两项范围或标点重写均返回 `false`。
4. 每项有非空、无首尾空格的已绑定 entityId，多项 ID 必须互异；slots 只含 entityId，不接受金额、memo、funding 等额外动作字段。

`canonicalMessage` 可以保持正式校验器生成的现有形式；它从不代替原文，也不用于重建 scope。此验证器没有快照参数，**不能认证外部伪造的 ready JSON 或 ID**。实体是否属于精确 grant、唯一匹配、版本和操作支持仍由正式 `validateSemanticIntent`、正常 resolver、reviewer 及 Core 核对。禁止将浏览器或未经校验的模型 JSON 直接当作此函数的可信 `SemanticPlan`。

## 调用方仍须完成的工作

此片只提供前置证据与接续一致性检查。原请求持久化、一个查询候选、用户黄色确认、精确 queryActionId 绑定、短时 grant 的 owner/状态/有效期、子命令与真实 user message 关联、恢复/并发防重，以及全部取消/阻止候选的原子准备和逐项确认，仍由后续 API/Core 集成负责。`true` 只表示两份服务端语义证据一致，不代表可跳过上述检查、自动授权或执行写动作。

本片复审另修复 [`plan-runner.ts`](../apps/api/src/plan-runner.ts) 的模型派发边界：语义、领域、reviewer 及 provider 重试的每个 `attempt_start` 都在 journal 预留和实际 HTTP 之前复验精确 continuation grant。已经有效派发的请求，即使返回时 grant 已过期，`attempt_end` 仍正常关闭；既有阶段和 prepareBatch 前检查继续阻止过期结果发布。provider 会把 observer 异常包装为 `MODEL_ATTEMPT_START_PERSIST_FAILED`，runner 保存并优先恢复可信的 Core grant/STOP 原因，不能误归为结构修复或无条件重试。普通 journal 失败继续由原 journal 管理，不被改写成 grant 失败。

## 验证证据

[`g9f-subscription-prerequisite.test.ts`](../tests/g9f-subscription-prerequisite.test.ts) 使用独立合成名称和未知商户，覆盖完整 1..8 项、全部 source 覆盖与 UTF-16、相反侧限制、前置合同声明、名称歧义与重复、引用/否定/历史/假设/其他域/未知残余整段拒绝，以及授权后数量/顺序/操作/范围/ID/slots 漂移。纯集成测试用现有 `validateSemanticIntent` 和合成授权快照生成真实 ready 计划再核对；未知实体不能冒充已绑定 ID。测试还断言无网络请求。

前置模块本身的 150 项新测试通过；另有 [`g9f-continuation-attempt-guard.test.ts`](../tests/g9f-continuation-attempt-guard.test.ts) 13 项真实 provider 边界纯测试，验证首次失效零派发、结构/截断/HTTP 重试前失效、后继 reviewer 不再派发、已派发 end 关闭及可信 cause 保留。全部 HTTP 由本地 mock 接管。实现中曾发现域名词子串禁令会拒绝仓库真实 seed `城市健身合约`，已以允许普通名词、仅拒绝完整泛称的方式修复，并增加独立合约/合同/会员/订阅名称正例；没有修改 API fixture 或 seed 绕过。

最终定向纯测试为 8 文件、539/539 通过，`pnpm typecheck` 通过。

这是纯本地语义与一致性证据，不是数据库接续、查询确认、恢复、浏览器或真实模型验收。无 DB/cloud 调用。
