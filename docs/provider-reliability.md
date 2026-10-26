# Provider 结构化输出可靠性

日期：2026-10-23。范围：`packages/agents/src/provider.ts` 的请求、解析、Zod 校验与诊断；不修改模型地址、名称、凭据、生产输出模式或执行权限。本页的自动化证据来自模拟 provider，不是新一轮真实模型成功率证明。

## 已观察的问题及能确定的事实

冻结的 `evals/results/2026-10-23-g6-browser-provider-failure.json` 记录了一次 investment 调用：`MODEL_OUTPUT_JSON_INVALID`，阶段 `output_json`，`finishReason: stop`，输出长度 485 字符，耗时 58,751ms，attempt 1。独立 reviewer 随后拒绝该轮提案；actions 与 investment_suggestions 都为空。记录只有输出摘要、长度及错误，不保存原始输出，因此无法判断原输出是 Markdown 围栏、解释文字、截断、非法转义或其他语法错误。`stop` 也不能证明业务结构正确。该次输入/输出 token 为提供方返回的 0，不据此推断零费用。

原实现只对网络、超时及部分 HTTP 状态重试；JSON 或 schema 失败立即终止。单次结构失败因此可能阻断整轮规划。修复目标是给模型一个受限的重新生成机会，同时完整保留第一次失败。

## 采用的方式与依据

采用一次**重新生成完整结构化结果**，不在本地抽取 JSON 子串、移除围栏、补括号、补字段、转换金额类型或复用部分动作。不把失败模型文本放入下一次提示，也不生成 scripted 备用答案。

DeepSeek 的 [JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode/) 要求 JSON 模式配合明确的 JSON 指令，并提醒输出上限不足可能截断，也可能出现空内容。[Chat Completions 参考](https://api-docs.deepseek.com/api/create-chat-completion/) 说明 `finish_reason=length` 表示输出或上下文长度限制导致中断，并要求调用方自行校验函数参数。这些说明支持继续使用本地严格校验；没有证据支持把 G6 的未知原文当成某种特定包装格式自动修剪。

下一次请求使用同一份预先序列化的原始 task、同一份 JSON schema、同一工具定义及 tool_choice、同一模型/模式/temperature/max_tokens。仅系统指令增加“重新生成完整结果”的固定说明、固定错误代码与受限校验路径。新增反馈不包含上一次输出、未知属性名、动态 record key、Zod 自定义消息、错误值或 literal 期望值；原 schema 中本来就存在的约束值保持不变。

任意一次成功仍须通过调用方传入的原始 Zod schema。provider 不改变 action schema，不获取授权，不执行动作。若调用方 schema 允许任意金额字符串，provider 的结构校验本身无法证明金额等于服务端事实；现有领域确定性一致性检查及独立 reviewer 仍是必需的边界。

## 接口、调用预算及默认行为变化

`invokeStructured(config, task, schema, toolName, observer)` 的参数位置、返回值和 `ModelRun` 字段保持兼容。

| 配置 | 语义 |
|---|---|
| `maxAttempts` | 所有网络请求的总预算，默认 2，上限 3；传输重试与结构重新生成共享这个预算。 |
| `maxStructureRepairs` | 新增程序化选项，仅支持 0 或 1，默认 1。设为 0 恢复结构失败立即停止的行为；不新增环境变量。 |
| `timeoutMs` | 保留单次请求超时语义，默认 60,000ms，上限 120,000ms。 |
| `signal` | 调用方提供的整轮共享 deadline；请求前、响应/body 读取后与重试等待均检查，取消后不再发送请求。 |
| `retryDelayMs` | 基础退避时间，默认 250ms，必须是 0–2,000ms 的整数；等待时间乘以已失败的 attempt 序号，且可以被共享 signal 中断。 |
| `maxOutputTokens` | 所有尝试保持原值，不因失败自动增加 token 上限。 |

例：默认预算下，第一次结构失败最多再发一次完整请求；若第一个请求已经因 HTTP 503 消耗预算，第二个请求再结构失败，就不会发第三次。`maxAttempts: 3` 时可以先经历一次传输失败，再经历一次结构失败，再进行最后一次重新生成。连续结构失败最多消耗两次请求，即使总预算是 3，也不会反复要求模型修到通过。

结构重新生成适用于 `MODEL_OUTPUT_JSON_INVALID`、`MODEL_SCHEMA_INVALID`、`MODEL_TOOL_OUTPUT_INVALID`、`MODEL_OUTPUT_EMPTY` 和 `MODEL_OUTPUT_TRUNCATED`。HTTP/网络/超时沿用原来的可重试判定。完成响应封套本身不是 JSON（`MODEL_RESPONSE_JSON_INVALID`）仍不走结构重新生成。`content_filter` 或明确 refusal 返回 `MODEL_OUTPUT_REFUSED`，不重新生成以绕过拒绝。

输出即使可解析且符合 schema，只要 finish reason 是 `length`，也先以 `MODEL_OUTPUT_TRUNCATED` 拒绝；它只能按上述固定预算重新生成。没有接受部分结果或自动提高 token 限额的路径。

## 诊断、隐私及耗时解释

每次尝试分别产生 observer 记录。首次失败不会被后续成功覆盖：保留 `attempt`、`status`、`errorCode`、`failureStage`、该尝试的耗时、提供方报告的 input/output token，以及可用的 finish reason、输出长度、SHA-256 摘要和安全校验路径。无 token usage 时保持 undefined，不伪造 0，也不将未知输入 token 计为免费。

`failureStage` 保留 request / response_json / tool_output / output_json / schema 的原枚举。schema 记录最多 8 个 issue，每个路径最多 12 段；未知字段或动态 record key 用 `[unrecognized]` 表示。模型原文、用户消息、凭据、HTTP body 与异常 message 均不进入这些诊断。重新生成提示复用同样的安全 issue 表示。

`ModelRun.durationMs` 是单次尝试时间，不包含两次请求之间的退避。整轮墙钟延迟应使用调用方的 planner/API 耗时；不能只看最后一次成功请求的时延或 token 数。没有共享 signal 时，最坏等待由总请求数乘以单次超时，加上有界退避决定；调用方需要总体预算时必须继续传共享 signal。deadline 在退避期间到期会终止等待；之前的失败记录保留，不伪造一次并未发送的成功调用。

## 自动化验证与剩余验收

新测试 `tests/provider-reliability.test.ts` 覆盖原输入/schema/工具/输出上限保持一致、恶意失败输出不回灌、错误金额不通过 literal schema、围栏/夹带说明不被本地抽取、共享调用预算、repair opt-out、空输出、length 输出、拒绝响应、超时、body 读取取消及可取消退避。原 `tests/provider-diagnostics.test.ts` 将其“无结构重试”的诊断测试明确配置为 `maxStructureRepairs: 0`，保留原有断言，并继续验证路径净化、摘要、阶段、token、传输重试和配置检查。

2026-10-23 08:58:59：上述两个 provider 测试文件共 **38/38** 通过。此前 08:58:05 的 provider + agents/ablation/management/financial/negation 组合为 **249/249** 通过，`tsc --noEmit` 通过；随后仅增加 body 取消分类及对应 provider 回归，最终全量检查由主任务统一执行。

尚未调用真实云模型验证本修复。需要在主任务批准的统一新运行中报告首次失败数、结构重新生成数、最终通过率、全部 attempt 的 token 与整轮延迟；不能把一次模拟恢复当作生产稳定性证明。G6 冻结结果保持原样。

## G7：统一请求输出上限与推理诊断

本轮已运行的 g705 账单阶段和 g722 语义阶段出现两次请求上限 2048、`length`／空内容现象。该观察只支持“未得到完整结构化结果”；不能据此断定是隐藏推理耗尽、回答过长、上下文限制或网关实现问题。第三方网关 `https://ai.anna.tf` 的实际行为不能由 DeepSeek 官方文档替代验证。

2026-10-23 查阅的 [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) 说明官方模型默认启用 thinking，推理文本通过独立的 `reasoning_content` 返回，thinking 下 temperature 不起作用。[官方 Chat Completions usage 说明](https://api-docs.deepseek.com/api/create-chat-completion/) 提供 `completion_tokens_details.reasoning_tokens`。这些是官方接口事实，不是当前第三方网关已验证的配置。实现没有新增或自动发送 `thinking`／`reasoning_effort`，没有自动关闭推理，也不把 temperature=0 当作关闭推理的证据。

新增 `budget.ts` 的 `createStageOutputPlan` 为纯函数。它不使用 fixtures 或期望角色，不保存、累加或退款 usage，也不会因 API 与 planner 分别重建计划而多算一次模型调用。调用方在语义解释前使用常量 `SEMANTIC_OUTPUT_TOKEN_LIMIT=4096`，在解释后按实际网络阶段数计算其余上限：

```text
总请求输出上限 T = 32768
统一每阶段尝试上限 A = normalizeMaxAttempts(config.maxAttempts)，默认 2，上限 3
语义每次请求上限 S = 4096
语义预留 = S × A
下游实际阶段数 N = domainStageCount + reviewerStageCount
下游每次请求上限 D = floor((T - S × A) / (N × A))，N > 0
最坏请求输出总额 = S × A + D × N × A ≤ T
```

`domainStageCount` 指实际请求数：并行模式每个实际启用领域各一阶段；single 联合领域调用仅算一阶段。独立 reviewer 存在时单算一阶段。semantic stop 时两个下游计数都为 0，下游上限返回 0，此值仅表示不应发下游请求，不能传作 provider 的 max_tokens。未知或不合法计数、超出 32768 的总额、无法为全部阶段保留最少 token 时，预算函数在请求前报错。

默认 A=2 的示例：

| 实际下游阶段 | 语义预留 | 每次下游请求上限 | 全部尝试请求总上限 |
|---|---:|---:|---:|
| 1 domain + 1 reviewer | 8192 | 6144 | 32768 |
| 2 domains + 1 reviewer | 8192 | 4096 | 32768 |
| 6 domains + 1 reviewer | 8192 | 1755 | 32762 |
| 1 joint domain，0 reviewer | 8192 | 12288 | 32768 |
| semantic stop，无下游 | 8192 | 0 | 8192 |

provider 与 planner 使用同一个导出的 `normalizeMaxAttempts`，避免一个按 2 次分配而另一个实际允许 3 次。显式更低的调用方 `maxOutputTokens` 可以继续作为额外上限；任何一次重新生成都保持该次阶段分配的相同上限，不递增。语义阶段未使用的第二次尝试预算不返还给后续阶段，usage 缺失或为 0 也不返还，避免不同网关上报口径改变请求上限。

`32768` 限制的是应用发出的 `max_tokens` 最坏总额；它不是 token 实际消耗统计，也不是第三方计费保证。调用方仍须保留整个规划的绝对 deadline；输出预算不会延长 deadline。两者约束分别生效。

新增安全诊断字段：

- `requestMaxOutputTokens`：该次尝试实际发送的上限；没有显式上限时保持缺失，不猜网关默认值。
- `reasoningLength`：若返回字符串 `reasoning_content`，只记录其 JavaScript UTF-16 长度，不记录文字、摘要或 hash。
- `reasoningTokens`：若 usage 提供非负安全整数的推理 token 数，则原样记录数值；缺失或类型非法时保持缺失。它是输出 usage 的分项，不能再与 outputTokens 相加当作额外消耗。

JSON 模式 `finish_reason=length` 且 content 为空时，现在仍归类 `MODEL_OUTPUT_TRUNCATED`，同时保留 outputLength=0、finishReason 与可用的上述推理计数；不会把推理文本拿来作为答案或重生成上下文。empty+stop 仍是 `MODEL_OUTPUT_EMPTY`。所有失败尝试继续分别保存，后续成功不会擦除它们。

2026-10-23 09:31:19：`planning-budget`、`provider-reliability`、`provider-diagnostics` 共 **70/70** 测试通过。包含所有支持的实际阶段／尝试组合、非法或不足预算、跨阶段两次尝试的请求上限求和，以及隐藏推理文字不记录／不回灌的测试。模拟的 semantic + 6 domains + reviewer 共 16 个请求，其中 8 次首次失败，总请求上限为 32762；没有借助 usage=0 退款。新的统一预算本轮尚未发起云请求；最终 index/API/eval 集成与真实模型重跑由主任务记录。
