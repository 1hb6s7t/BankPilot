**第一阶段实现契约**

这是竞赛合成银行沙箱，所有账户与收款人均为合成数据。目标为 G0/G1/G2：真实依赖、持久化与多 Agent 编排验证、可授权且可恢复的一笔转账。当前不实现全部六场景。

共享类型位于 packages/contracts/src/index.ts，由主 Agent 管理。后端 CoreService 只接受服务端已认证 Actor，authorize 的 STRONG 证据只允许由 API 的 WebAuthn 验证成功分支产生。HTTP 客户端无权指定验证等级。金额以整数分的字符串经过接口，数据库为 bigint。

API（统一 /api 前缀）：GET /health；Better Auth /auth/*；GET /dashboard；POST /plan {message,commandId} 返回 PlanResult 加 actions:ActionView[]；POST /transfers 返回 ActionView；POST /actions/:id/confirm {actionHash}；POST /actions/:id/cancel；POST /actions/:id/reconcile；POST /webauthn/register/options；POST /webauthn/register/verify {response}；POST /actions/:id/authentication/options；POST /actions/:id/authentication/verify {response}；POST /sandbox/fault {mode}。错误返回 {error:{code,message}}。

登录使用 Better Auth 的 sign-in/email，演示用户 bankpilot@example.test / BankPilot-demo-2026!，仅本地合成环境。应用启动脚本创建该用户。前端通过同源 /api proxy 请求，credentials:include；用户ID来自服务端会话，绝不取请求body。

WebAuthn RP ID为 localhost，默认可信Origin为 http://localhost:5178。前端调用 @simplewebauthn/browser。注册先登录；红档交易用绑定actionHash的随机challenge；缺UV、错Origin、过期、重复challenge均不能授权。

主Agent负责依赖、共享契约、数据库环境、身份/WebAuthn API、集成与浏览器测试。执行Agent独占 packages/core 与对应 core 测试；编排Agent独占 packages/agents 与对应 agent 测试；前端Agent独占 apps/web。任何共享契约变更先通知主Agent。

执行侧导出 createCore(pool, options?)，返回 CoreService；允许另导出 startWorker(pool,core) 及停止函数。queue/outbox与schema由执行Agent管理。BankAdapter为数据库状态化假银行，TIMEOUT_AFTER_COMMIT应先真实记账再丢响应；应用进入UNKNOWN，后续查原单恢复，不能重复扣款。

计划侧导出 createPlanner(options?)，返回Planner。必须用真实LangGraph的并行图验证任务重叠、局部上下文及旧版本结果处理；默认脚本化模型是可重复的基础设施验证模式，UI必须明确标注。可选真实模型由服务端环境配置，不能伪造LLM运行证据。
