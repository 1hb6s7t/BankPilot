# G9B：`apiw.pro` / `deepseek-v4.1-flash` 结构输出与推理参数兼容性研究

核查日期：2026-10-24（Asia/Shanghai）。范围仅为公开文档、当前源码及已保存的 G9 首轮报告；本研究没有调用模型、读取密钥或修改产品请求。

## 结论与证据边界

**当前不能确认 `apiw.pro/v1` 的 `deepseek-v4.1-flash` 别名支持、透传或真正执行 `thinking: {type: "disabled"}`、`reasoning_effort: "none"` 或其他推理预算参数。** apiw.pro 的公开首页在本次访问中返回 HTTP 200，站点前端公开路由可见 `/model-plaza`、`/setup` 等，但本站公开页面与网络搜索均未找到该别名的参数契约或结构输出说明。未找到文档不是不支持的证明，也不是透传的证明。没有访问登录后的控制台、模型列表 API 或聊天 API。

DeepSeek **自家** Chat Completions 文档将官方模型名写为 `deepseek-flash`，列出 `thinking: {type: "disabled"}` 和 `reasoning_effort: "none"` 两种关闭思考的控制；默认思考开启、默认 effort 为 high。官方文档还说明 `response_format: {type: "json_object"}`、`max_tokens` 和 `finish_reason="length"` 的关系。这些仅能作为对代理别名的**候选探针参数**，不能作为 `apiw.pro` 的兼容承诺。[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。

## 当前请求与已观察事实

- `packages/agents/src/provider.ts` 的 `invokeStructured()` 发送 `POST {baseURL}/chat/completions`。语义阶段的当前配置是 `model: "deepseek-v4.1-flash"`、`max_tokens: 4096`、`temperature: 0`、system/user messages 和 `response_format: {type: "json_object"}`。未发送 `thinking`、`reasoning_effort`、`reasoning` 或其他推理预算字段；`outputMode` 的另一条分支使用 named tool choice，但首轮指定的是 `json_object`。源码本身无法证明代理内部的默认思考模式。
- `packages/agents/src/budget.ts` 固定语义尝试上限为 4096，整例请求上限为 32768；G9 首轮最多两次尝试与一次结构修复，语义输出限额未在首轮提高。
- 已保存的首轮报告覆盖 36 条独立合成案例，HTTP 尝试日志为 54 个 start / 54 个 end，均报告 HTTP 200。5 条案例（序号 17、18、29、35、36）在语义阶段各有两次 `MODEL_OUTPUT_TRUNCATED`。这 10 次的提供方 usage 均为 `completion_tokens=4096`、`completion_tokens_details.reasoning_tokens=4096`，运行诊断记录 `finish_reason=length`，没有可解析的最终 JSON。其余调用中也有完成且 `reasoning_tokens` 大于零的响应，因此不能概括成所有请求都无法输出。
- 日志证明的是“提供方按上述字段报告，用尽了该次请求的输出上限，并且产品判定截断”。它不能证明准确的内部推理轨迹、代理上游实现、实际计费或配置字段是否被代理忽略；也不能从未保存的响应原文推断额外内容。

DeepSeek 官方文档的附加兼容边界：思考模式下 `temperature` 被接受但无效；JSON 模式需要提示中要求 JSON，并应合理设置 `max_tokens`，`length` 仍可截断内容。当前 system 提示包含 JSON 对象和 schema。官方 Chat Completions 文档还称思考模式不支持 `required` 或指定函数的 tool choice，会返回 400；因此**不要**在首个探针里把 `json_object` 同时改成 `tools`，否则无法归因。[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)。这仍然只描述 DeepSeek 官方服务。

## 最小单因素云探针方案（待主任务执行）

1. 从已知的合成 G9 案例选一个首轮双次截断的语义输入（建议序号 17），重建**相同**的语义 task、schema、system/user 消息和 `json_object` 模式。只执行语义模型调用，不能发起银行命令、授权或执行；先固定 fixture/任务哈希、schema 哈希、请求体中除待测字段外的规范化哈希。新实验标为 `known regression / provider compatibility`，不得并入 11/36 的首轮分数。
2. 基线 A 与实验 B 各调用一次，均使用同一代理、同一别名、`max_tokens=4096`、`temperature=0`、60 秒请求期限、`maxAttempts=1`、`maxStructureRepairs=0`。A 使用现有请求体；B **仅新增**顶层 `"thinking":{"type":"disabled"}`。顺序、时间、请求体差异与供应商返回的模型名（如果有）应写入独立实验账本。若 A/B 的请求或时间条件无法对齐，标记为不可比较。
3. 两次都持久化 dispatch 前和结果后的完整请求账本：HTTP 状态、供应商错误类别（脱敏）、`finish_reason`、`prompt_tokens`、`completion_tokens`、`reasoning_tokens`（缺失要写 unknown）、`reasoning_content` 字符数、`content` 字符数和 digest、JSON 可解析性、schema 可验证性、用时、输出上限。不要记录密钥、授权头、用户数据或思维内容。失败、超时和无 usage 都进入分母。记录 `/v1` 代理别名和精确请求字段，但不要公开凭据。
4. 解释层级：HTTP 2xx 只证明请求被接受；B 返回可解析 JSON、schema 通过且 `reasoning_tokens=0` 或不再占满上限，才是该端点对这个输入“参数可能生效”的支持证据。单例成功不证明普遍支持；若 A 也成功，不能声称 B 改善；若 B 仍截断、报 4xx 或 usage 不可辨，则记录为不支持/未证实/不确定的相应状态，避免猜测代理是否静默忽略字段。
5. 只有 B 在此探针展现可重复的可用结构输出后，才在**另一个独立实验**用原始 A 对照 `reasoning_effort: "none"`（单独新增，绝不与 `thinking` 同时加），并扩大到其余四个已知截断输入。每个条件报告“请求数 / HTTP 成功数 / JSON 可解析数 / schema 通过数 / 截断数”和 usage 分布；若需要统计可重复性，再预先固定重复次数与顺序。不要因为单个探针成功直接更改生产 provider、预算或 G9 首轮结果。

`reasoning_effort: "low"` 是另一个可能候选，但 DeepSeek 官方将其描述为降低思考强度而非关闭思考。增加 `max_tokens` 则改变成本及原预算，且混淆本轮归因；都不属于首个探针。[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。

## 来源与复核点

| 来源 | 本次可核实内容 | 访问日期 |
|---|---|---|
| [apiw.pro 首页](https://apiw.pro/) | 首页 HEAD 为 HTTP 200；公开前端有 `/model-plaza`、`/setup` 路由。公开页面未提供该别名的参数契约；`/docs` 也未由网络阅读器取得可核实文档。 | 2026-10-24 |
| [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) | 官方模型思考模式开关、默认 effort、`temperature`、`reasoning_content`。 | 2026-10-24 |
| [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/) | 官方模型名、参数、JSON 格式、截断和 named tool choice 限制。 | 2026-10-24 |
| [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/) | JSON 提示、合理设置 `max_tokens`、偶发空内容提示。 | 2026-10-24 |
| [G9 首轮报告](../evals/results/g9-first-2026-10-24/2026-10-24T04-29-05-923Z-g9-live.json)、[请求账本](../evals/results/g9-first-2026-10-24/2026-10-24T04-29-05-923Z-g9-live.attempts.jsonl) | 2026-10-24 首轮实际调用与诊断。 | 本地读取 2026-10-24 |

机器可读证据和核查哈希见 [研究记录](evidence/2026-10-24-g9b-provider-research.json)。
