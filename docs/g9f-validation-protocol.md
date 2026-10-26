# G9F 订阅原请求接续：预登记浏览器验证协议

状态：执行前协议。此文先于受控浏览器和真实云浏览器结果写入；尚无本轮浏览器通过结论。样本是开发者已知、固定的本地合成数据与原文，属于有限场景验证，不是盲测，也不替代 G9E 已有 36 例、12 例评测或整体发布验收。

## 固定场景与实现边界

唯一主场景原文逐字固定为：`取消云音乐订阅，阻止城市健身合约的银行扣款`。它请求两个不同订阅的不同操作。夹具仍使用现有合成 seed，不改商户名称或订阅状态来迎合测试。UI 发送原文时没有有效订阅查询 grant；服务端先给出一张独立 `SUBSCRIPTION_QUERY` 黄色确认卡，并将原请求保持在 `WAITING_QUERY`。这一步不解释为自动同意查询、取消或拦截。

用户在浏览器确认**一次查询卡**后，API 按同一原始 user message 和精确 queryActionId 自动建立子命令。子命令必须保留原文逐字相同、原 user message ID、parent/root 关系，并一次性准备两张各自待确认的写入卡。查询确认后到写入卡出现之前，两个订阅仍保持原状态，且只产生查询的授权证明。刷新、退出再登录后，聊天中仍只有一条原始 user 消息，两张卡恢复为待确认；不得补造新的 user 消息或自动执行任一写操作。再由 UI 逐张确认：第一张完成时第二张仍待确认且对应订阅未变化；第二张确认后分别验证商户取消和银行扣款限制的独立终态。余额、转账 provider 和总账保持不变。

本轮固定一个主闭环测试，不把待查询停止、grant 过期后重新查询、进程重启或多轮故障恢复隐含为已覆盖。Core 事务/授权、纯测试和 API 集成证据仍分别报告，浏览器通过也不等于这些路径全面通过。

## 两个独立运行条件

| 条件 | 启动配置 | 模型来源 | 预期与计数 |
| --- | --- | --- | --- |
| 受控 | `playwright.g9f.config.ts` | 强制 `BANKPILOT_G9F_LIVE=0`；不加载 `.env`；仅受控模型 HTTP | 预授权阶段 0 模型调用；授权后受控 semantic、subscription、reviewer 各一次；云调用 0。 |
| 真实云 | `playwright.g9f-live.config.ts` | 该独立配置显式加载 `.env` 并置 `BANKPILOT_G9F_LIVE=1`；`providerFromEnv()`，绝不调用 `configureScenario` | 记录实际每阶段 attempt、HTTP 调用和 token 用量；不预设业务通过或把受控结果回填为云结果。 |

两条件共用 `tests/e2e/g9f-subscription-continuation.spec.ts` 的同一 UI、API、PG、认证、worker 断言；结果目录、JSON report、trace、截图和附件必须分开，采用唯一新目录，绝不覆盖或重写首次结果。顺序固定为先受控，审查和冻结源码与配置后，再由 root 显式启动一次真实云运行。两套 Playwright 配置均 `workers=1`、`retries=0`，失败保留原报告，不自动重试，不用后跑结果替换前跑结果。

真实云前须在单独非秘密 freeze 记录中绑定实际源码/测试/配置 hash、provider endpoint 的规范化摘要（不写 API key、headers 或请求体）、model 名、output mode、thinking 与 reasoningEffort 的**实际显式值或 omitted**、temperature 与 maxOutputTokens 的显式值或阶段默认来源、每阶段调用预算，以及运行时间和证据目录。当前 live spec 在 `providerFromEnv()` 结果上只覆盖 `maxAttempts=1`、`maxStructureRepairs=0`、`timeoutMs=60_000`；其余配置沿用当时环境读到的显式字段，不能在报告中假称固定默认。每阶段一次 HTTP attempt，无结构修复；模型是否遵守业务与 schema 由实际结果判断。默认受控配置绝不读取 `.env`。

## 固定上限与成功断言

- Playwright 总超时：受控 150 秒、真实云 360 秒；单次页面动作 15 秒。命令完成轮询受控 45 秒、真实云 210 秒；管理动作状态轮询 30 秒。云 provider 单 attempt 60 秒。实际每次请求的 `max_tokens` 由 planner 阶段预算设置，应从持久化 attempt 记录核对，不能把一项猜测的固定上限写成观测值。
- 预授权源命令必须 `complete`、`mode=scripted`、`WAITING_QUERY`、恰好一个 QUERY 候选；公共 summary/events/evidence 不含两个商户及金额事实。确认前真实 Core 无 grant、proof、写入动作，浏览器可见待确认查询卡。
- 查询确认后仅一个新 grant 和查询 proof。子命令须 `complete`、`mode=model`，精确沿用原文和真实 user message 关联；两个写 spec 的 kind、subscriptionId、expectedVersion、queryActionId、顺序均匹配查询快照；已存子结果的 title/details/receipt/failureReason 受保护。
- UI 须显示两张独立写入卡，并在刷新、重登后仍可查看；真实消息表只有一条 user 消息。确认第一张后第二张仍 `AWAITING_CONFIRMATION`，第二目标状态未变；确认第二张后取消对象仅商户状态变 `CANCELLED`，拦截对象仅银行状态变 `BLOCKED`。审计中三个管理动作各一次成功，证明数为查询 1 加写入 2；无资金或转账侧效果。
- 受控模型调用必须只有 semantic_intent、subscription、reviewer 三条成功响应，真实云不得有受控模型调用，云 HTTP 调用要全部闭合并逐条保留实际状态。无浏览器 page error。测试收尾必须证明 planner drain、worker 停止、schema/jobs schema 删除、auth 用户删除、端口关闭、临时目录删除，`cleanup.clean=true` 且 errors 为空。

## 证据、缺失和解释限制

首次结果的证据应包含 Playwright `report.json`、trace、阶段截图、`terminal-database.json`、`isolation.json`、`owned-command-attempts.json` 和 `cleanup.json`。`isolation.cloudCalls` 只记录调用序号、开始时间、持续时间、HTTP 状态或传输错误；它**不含** role、attemptId、token 用量或原始请求/响应。`owned-command-attempts` 从此隔离用户的持久化命令白名单提取 status、失败码、attemptId、role、attempt 序号、起止时间、输出上限与可用的 input/output token；另白名单提取成功、失败及 semantic 阶段 ModelRun 中可用的 input/output/reasoning token 元数据，不带内容或 issues。即使 child 失败，只要消息已接受也应保存。逐阶段 attempt 与 cloudCalls 的数量、时间顺序和终态需在审计时核对，缺失、`unknown` 或未闭合者不得记为完整有效运行。若消息接受前失败或数据库不可读，明确记证据不足。

这些附件没有 provider 的原始结构化输出、reasoning_content、API key、请求 headers 或完整请求体。因此可审计派发元数据与业务终态，**不能**从该浏览器证据独立重算 raw 语义质量；不能声称它提供 G9E 评测级的原文/trace 绑定。真实云 HTTP 200 只说明传输成功，仍须完整满足以上业务和隐私断言。成功也仅证明这一个已知双订阅 UI 场景；任何失败必须保留失败状态、原报告和 cleanup，不追加自动补跑或改变断言后宣称首次通过。
