# BankPilot：可靠执行、身份、策略和审计复用评审

口径：2026-10-22 Asia/Shanghai。只读官方文档、仓库与源码；未安装平台、未运行故障演练、未执行银行操作。架构建议不构成部署验收。GitHub connector 未登录（主线程验证），采用公开 Web/API；API 后续限流，失败记录保留。下表日期均 UTC；精确时间、完整 SHA、许可原文、issue/PR 内容见同名前缀 JSON。主选已采集版本/提交没有晚于采集时刻的记录；搜索索引“今天”不作为发布时间。

## 维护与许可证据

|Repository|License|Latest release (UTC)|Latest commit (UTC)|Issue/PR sample|
|---|---|---|---|---|
|[timgit/pg-boss](https://github.com/timgit/pg-boss)|[MIT](https://github.com/timgit/pg-boss/blob/master/LICENSE)|[12.38.0](https://github.com/timgit/pg-boss/releases/tag/12.38.0) 2026-10-13|[d4400859](https://github.com/timgit/pg-boss/commit/d4400859eed280b58c346f5289a0312913d558bd) 2026-10-15|[#971](https://github.com/timgit/pg-boss/pull/971) open|
|[temporalio/temporal](https://github.com/temporalio/temporal)|[MIT](https://github.com/temporalio/temporal/blob/main/LICENSE)|[v1.32.1](https://github.com/temporalio/temporal/releases/tag/v1.32.1) 2026-10-08|[e8ee6271](https://github.com/temporalio/temporal/commit/e8ee627110a98501103827745aab18aedf312dd0) 2026-10-22|[#12672](https://github.com/temporalio/temporal/pull/12672) open|
|[temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript)|[MIT](https://github.com/temporalio/sdk-typescript/blob/main/LICENSE)|[v1.24.0](https://github.com/temporalio/sdk-typescript/releases/tag/v1.24.0) 2026-09-15|[d98735e0](https://github.com/temporalio/sdk-typescript/commit/d98735e097e5585365d68957f92ab51a759b7e2e) 2026-10-21|[#2320](https://github.com/temporalio/sdk-typescript/pull/2320) open|
|[MasterKale/SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn)|[MIT](https://github.com/MasterKale/SimpleWebAuthn/blob/master/LICENSE.md)|[v14.0.3](https://github.com/MasterKale/SimpleWebAuthn/releases/tag/v14.0.3) 2026-09-25|[787ca820](https://github.com/MasterKale/SimpleWebAuthn/commit/787ca8209e39bc5f868a6a42f6b98a1bc1c06206) 2026-09-25|[#818](https://github.com/MasterKale/SimpleWebAuthn/issues/818) open|
|[keycloak/keycloak](https://github.com/keycloak/keycloak)|[Apache-2.0](https://github.com/keycloak/keycloak/blob/main/LICENSE.txt)|[26.8.1](https://github.com/keycloak/keycloak/releases/tag/26.8.1) 2026-10-13|[3c07b879](https://github.com/keycloak/keycloak/commit/3c07b879d5cfaf277caa5d4bc96174347f71f91c) 2026-10-21|[#54244](https://github.com/keycloak/keycloak/issues/54244) open|
|[better-auth/better-auth](https://github.com/better-auth/better-auth)|[MIT](https://github.com/better-auth/better-auth/blob/main/LICENSE.md)|[v1.7.12](https://github.com/better-auth/better-auth/releases/tag/v1.7.12) 2026-10-20|[c6a08cf4](https://github.com/better-auth/better-auth/commit/c6a08cf4f2f4fe949987eac8adedffca680bb95e) 2026-10-21|[#11989](https://github.com/better-auth/better-auth/pull/11989) open|
|[open-policy-agent/opa](https://github.com/open-policy-agent/opa)|[Apache-2.0](https://github.com/open-policy-agent/opa/blob/main/LICENSE)|[v1.21.3](https://github.com/open-policy-agent/opa/releases/tag/v1.21.3) 2026-10-19|[9981dd1a](https://github.com/open-policy-agent/opa/commit/9981dd1a88690857227cfae0c499a388d665238b) 2026-10-21|[#9173](https://github.com/open-policy-agent/opa/pull/9173) open|
|[open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js)|[Apache-2.0](https://github.com/open-telemetry/opentelemetry-js/blob/main/LICENSE)|[v3.0.0](https://github.com/open-telemetry/opentelemetry-js/releases/tag/v3.0.0) 2026-10-20|[419d7950](https://github.com/open-telemetry/opentelemetry-js/commit/419d795048a0a62e87f3207c784794943972bce2) 2026-10-21|[#6921](https://github.com/open-telemetry/opentelemetry-js/pull/6921) closed|
|[langfuse/langfuse](https://github.com/langfuse/langfuse)|[MIT Expat + EE](https://github.com/langfuse/langfuse/blob/main/LICENSE)|[v4.67.0](https://github.com/langfuse/langfuse/releases/tag/v4.67.0) 2026-10-21|[b914c2a5](https://github.com/langfuse/langfuse/commit/b914c2a58139bbae930af1e3aa4019883588014f) 2026-10-21|[#19178](https://github.com/langfuse/langfuse/pull/19178) closed|

上述九仓库 API 均为 `archived=false`。开放 issue/PR 只证明报告/提交存在，不证明缺陷已确认或修复。Better Auth #11989 关于权威会话读取的修复仍 open，不能写成已发布修复。Langfuse 根许可明确：`ee/`、`web/src/ee/`、`worker/src/ee/` 依 [EE LICENSE](https://github.com/langfuse/langfuse/blob/main/ee/LICENSE) 商业授权，其他代码（第三方另计）MIT Expat。不能说整仓库 MIT，也不能默认免费包含企业审计或服务端脱敏。

## 复用矩阵

|能力|建议层级|BankPilot 必须承担|
|---|---|---|
|短任务、定时、重试、死信|直接依赖 pg-boss，首版主选|状态机、outbox、审批过期、幂等和 UNKNOWN 查单|
|跨天等待、复杂补偿、工作流版本演进|Temporal 条件引入，需适配|Activity 幂等、银行终态证明、回放兼容及运维|
|Passkey 密码学验证|直接依赖 SimpleWebAuthn|交易绑定、一次性审批、凭据恢复与撤销|
|登录会话|首版 Better Auth；已有银行 IdP 则 OIDC/Keycloak|账户归属、授权上下文、即时撤销检查|
|红黄绿判断|首版确定性 TS；OPA 可替换适配器|规则、可信事实、并发额度占用与强制执行|
|遥测/模型诊断|OTel 直接依赖，Langfuse 可选|独立业务审计、脱敏、保留和隔离|
|交易账本|首版 PG 窄记录；TigerBeetle 条件引入|会计映射、银行对账、跨库一致性|

## 可靠执行

[pg-boss](https://pgboss.io/) 的队列领取与原子提交是数据库语义。固定源码 `d4400859` 的 [adapters.md](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/docs/api/adapters.md) 支持 `boss.send(name,payload,{db:txAdapter})` 与业务写入同事务；[workers.md](https://github.com/timgit/pg-boss/blob/d4400859eed280b58c346f5289a0312913d558bd/docs/api/workers.md) 的 `transactional:true` 只让通过同一 PG 连接的写入与 job completion 一起提交，不能回滚银行 HTTP 扣款。不要在长 PG 事务里等用户或银行。仓库 `test/transactionalWorkTest.ts` 的回滚/重试测试仅审阅，未运行。

Temporal 提供持久工作流，但[官方要求 Activity 幂等](https://docs.temporal.io/activity-definition)，[丢响应与重试仍可重复执行](https://temporal.io/blog/idempotency-and-durable-execution)。任何“exactly-once”承诺都不能扩展成外部扣款仅一次。首版已有 Postgres、流程有限，pg-boss 运维更轻；当跨天回调、补偿分支、升级恢复成为主要复杂度再替换 `TaskRuntime`，不双写两套执行器。

建议状态：`proposal → immutable intent → policy → approval → authorized → dispatching → succeeded/failed/unknown → reconciling`。数据库是权威；刷新、换页按 intentId 恢复。总控与复核 Agent 只提供建议或否决理由，无权写 authorized。

1. 服务端规范化账户、币种及整数最小货币单位，拒绝浮点、负数、溢出与账户越权。生成不可变 `intentId/version/hash`，包括主体、收付款账户、金额、费用、用途、策略版本、有效期。
2. PG 短事务锁定用户/账户/业务日额度行，计算成功+在途占用+本次金额，写状态、额度占用、审计事件及 outbox/job。API 幂等唯一键 `(tenant,user,operation,key)` 另存请求 hash，同键异参拒绝。
3. Worker 条件更新/执行租约阻止重复派发；调用前再查账户权利、策略、审批绑定及有效期。银行 `clientRequestId` 跨重试稳定，不能用 job attempt 创建新扣款键。
4. 超时、断连、崩溃后进入 UNKNOWN，只查单并保留额度。普通 not found 可能是可见性延迟，不能自动视作失败。没有银行终态证明/幂等协议则人工核查，禁止重发。
5. 回调验签并验证交易关联；重复/乱序回调不能覆盖终态。本地记账与最终审计同事务。补偿是独立授权的新交易，取消工作流不代表撤销已完成银行交易。

适配接口：`BankAdapter.submit(intent,stableKey)`；`query(stableKey): SUCCESS|FAILED_FINAL|PENDING|UNKNOWN`；`verifyCallback(raw)`；`TaskRuntime.enqueue(tx,intentId)`；`Ledger.reserve/post/release`。供应商适配器必须声明幂等有效期、查单一致性窗口、终态证据和回调验证规则，否则不开放自动写交易。

## 身份和交易强验证

SimpleWebAuthn 的 [verifyAuthenticationResponse](https://github.com/MasterKale/SimpleWebAuthn/blob/787ca8209e39bc5f868a6a42f6b98a1bc1c06206/packages/server/src/authentication/verifyAuthenticationResponse.ts) 核验 challenge、origin、RPID、签名、UV 和 counter。应用保存随机 challenge 与 `{userId,sessionId,intentId,version,hash,expiresAt,consumedAt}` 的服务端关联；页面显示同一不可变快照。红档设 `userVerification:'required'` 及 `requireUserVerification:true`。成功后在事务内一次性消费 challenge，产生仅适用此快照的审批凭据；改金额、费用、收款人或超时必须重签。通用“最近登录成功”不等于逐笔授权。

[WebAuthn 标准](https://www.w3.org/TR/webauthn-3/#sctn-authenticator-signature) 不保证浏览器自动理解并可信显示银行金额/收款人。挑战绑定可绑定意图，但不是独立可信交易显示，也不能宣称满足银行交易签名要求；该能力应对接银行签名/认证或另评估 SPC 兼容性。同步 Passkey 的 counter 可为零，不能作为唯一防重放机制。

[Better Auth freshness](https://better-auth.com/docs/concepts/session-management) 按 session.createdAt 判断，默认一天；`freshAge:0` 是关闭检查，不是每次验证。写接口须查权威会话存储及撤销状态，不能只信缓存。若银行已有身份系统，采用 OIDC Authorization Code + PKCE，校验 issuer/audience/nonce/state。[Keycloak step-up](https://www.keycloak.org/docs/latest/server_admin/index.html#_step-up-flow) 的 acr/LoA、max age 负责认证强度；业务 API 仍须核实达到的强度和交易绑定。不要同时维护两套登录主体；换绑/恢复 Passkey 也是敏感操作。

## 确定性策略

`PolicyEngine.evaluate(trustedFacts): {allow,tier,reasons,requiredEvidence,policyVersion}`。认证主体、日累计、档位和审批事实取自数据库/服务端，不能信任 Agent 参数。

- 转账按 Asia/Shanghai 业务日，累计含本次 ≤1000 元黄，>1000 元红；并发请求先串行占用额度，UNKNOWN 不释放。执行前若风险升级，原黄档审批不能继续。
- 订阅查询/取消黄；申购、挂失、解挂红；首版赎回红。黄需明确确认，红需交易绑定强验证；绿档仅显式只读白名单，未知操作拒绝。
- OPA 的 [`POST /v1/data/bankpilot/decision`](https://www.openpolicyagent.org/docs/integration) 可替代 TS 规则评估。HTTP 200 无 result 是 undefined，必须拒绝；超时、错误、事实缺失、版本不明也拒绝。OPA 不负责额度锁或数据库事务，API/Worker 必须强制执行判断。

## 账本、审计和隔离

[TigerBeetle](https://github.com/tigerbeetle/tigerbeetle) 为 [Apache-2.0](https://github.com/tigerbeetle/tigerbeetle/blob/main/LICENSE)，可复用双重记账、账户约束、pending/post/void transfer、Node.js 客户端和 transfer ID 去重。[可靠提交](https://docs.tigerbeetle.com/coding/reliable-transaction-submission/) 要求可靠保存 ID。它的 transfer 是内部账本记录，不会自动完成银行划款。[生产建议六副本](https://docs.tigerbeetle.com/operating/cluster/)，新增 PG↔账本投递、对账和运维成本。

首版仅银行模拟/镜像与额度占用时，PG 窄账本优先；真正管理余额、多资产借贷平衡或高并发记账时，应优先适配 TigerBeetle，避免自造通用账本引擎。映射 `intentId→稳定128-bit transferId`，outbox 投递，查 ID 后落本地状态；UNKNOWN 不 void/release。当前页面最新 [0.17.9](https://github.com/tigerbeetle/tigerbeetle/releases/tag/0.17.9)，发布时间 `2026-07-06T17:24:50Z`；[#3856](https://github.com/tigerbeetle/tigerbeetle/pull/3856) 已合并。API 限流后改读 GitHub 页面内嵌元数据：`isArchived=false`，主干 [0450c32b](https://github.com/tigerbeetle/tigerbeetle/commit/0450c32b2c3c3ab6114f3402cc601341cc8192aa)，提交 `2026-10-14T13:03:57.000Z`，原始 HTML 保存在补充 evidence。维护结论仅限本次可见快照。

[OTel](https://opentelemetry.io/docs/security/handling-sensitive-data/) 负责时延、错误和链路，[Langfuse masking](https://langfuse.com/docs/observability/features/masking) 用于模型诊断，数据离开应用前做白名单脱敏。两者可能采样/丢失/删除，不能作唯一业务审计。独立 `audit_events` 记录 actor、intentHash、策略与审批证据引用、状态跃迁、回执 hash、traceId；限制更新删除，另存不可变备份/签名检查点。哈希链不能抵抗全存储管理员重写，检查点必须独立保护。

同仓库不代表共用权限：Agent 与银行执行 Worker 分进程、凭据和网络出口；Agent 不持银行密钥、任意 SQL/shell，服务端工具注册表固定能力。首版不执行用户任意代码；未来插件/代码执行再评估 [gVisor](https://gvisor.dev/docs/) 等隔离运行时。本次未完成隔离产品选型，沙箱也不能替代授权与幂等。

## 必过门槛（待实施，并非已通过）

- 银行成功后本地提交前杀进程、丢响应、重复领取、租约过期：外部成功次数≤1，状态恢复且 UNKNOWN 只查单。
- 999.99/1000/1000.01 元、并发穿透、跨日、失败释放、UNKNOWN保留：无黄档绕过，金额全程整数。
- 重复审批/回调、快照变更、过期、错 origin/RPID、UV缺失、凭据撤销：全部阻断；合法恢复可完成。
- OPA不可用/undefined、复核Agent谎报批准、伪造参数、跨租户 intent：均 fail closed。
- outbox与业务同回滚/提交，重启不丢任务；遥测停机不损业务证据，审计写失败阻止授权进入可执行状态。
- 引入 TigerBeetle 后另测重复 ID 异参、pending 到期、post/void 竞争、PG落后恢复和借贷平衡，之后再扩大账本替换范围。
