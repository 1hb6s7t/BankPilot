# G9F：订阅查询授权后的原请求续办

2026-10-25。本阶段实现和验证“无查询授权的完整订阅请求 → 单独确认查询 → 原请求自动核对 → 独立确认每项写动作”。整体项目目标仍 active；本阶段不替代六域云模型质量、未见样本、容量或接收方验收。

## 实现及复用

沿用现有 LangGraph 规划、PostgreSQL 命令与租约、Hono API、Better Auth 登录、Core 授权与事务、React 聊天和 Playwright 隔离夹具。新增业务层原请求续办状态表、源文本前置契约和原子批量候选准备；未引入另一套编排或授权框架。

- 服务端只在完整、明确且属于支持语法的 1–8 个订阅取消/银行拦截请求上生成查询前置。前置不绑定商户 ID、不读取未授权目录、不调用模型。裸“退订X”统一交给普通语义路径，避免把“退订成功”等陈述当指令。详见[原文前置契约](g9f-subscription-prerequisite-contract.md)。
- 查询确认之后，子命令复用真实原始 user message ID、原文和 planning_input；只新增中性 assistant 状态消息。查询 grant 与每轮子命令精确绑定，重复确认、租约恢复和重试不新造用户指令。
- 正常语义、订阅领域和独立复核继续工作。每次模型 attempt_start（含重试与后继复核）复验精确查询授权；阶段结束和准备候选前再次校验。已派发的调用仍记录结束，授权过期后不再派发后继调用。
- 全部原请求范围、顺序、操作、实体、版本和 queryActionId 必须一致；缺项或多项均不生成部分候选。Core prepareBatch 在同一事务准备 1–8 项取消/拦截，失败不会留下部分新候选。确认查询不授权取消或拦截，每张卡仍单独确认。
- 查询过期需新建查询周期并再次本人确认；旧子命令和旧 grant 不改绑。可恢复失败允许显式继续原子命令。后台按用户和原请求稳定游标轮转，显式请求直达原记录；同一进程繁忙时显式重试排队，队列本身不承诺跨进程持久化。
- 历史落库只保存中性文字和脱敏卡片。读取历史时，对这些卡片通过 Core 重新判定当前可见性；有效授权可查看并确认，过期仍隐藏。等待/失败状态可停止续办；规划中停止返回冲突，停止续办不撤销已准备的卡片。

## 并行开发和复核

语义与模型派发边界由 GPT-6.1-sol/xhigh 子 agent 负责；持久化、并发、grant 周期由 GPT-6.1-sol/high 子 agent 负责；Core 批量准备、浏览器场景与验证协议由 GPT-6-sol/high 子 agent 负责。高风险的身份、授权和恢复交叉复核；主 agent 集成 API/UI、串行运行共享数据库与浏览器，并核对整体证据。这是开发分工，产品本身仍采用总控、领域和独立复核架构。

## 验证结果

本地全仓 [3019/3019 测试（115 文件）](evidence/2026-10-25-g9f-full-check-verified.log)、类型检查和构建通过。构建仍提示主 bundle 超过 500 kB，未声称容量优化完成。协议先行：[浏览器验证协议](g9f-validation-protocol.md)。受控首次报告与修后复测分别保留，真实云各凭证条件另行独立运行。所有模型数据来自合成账户。

首次受控浏览器实际发现：原请求、查询授权、两项候选均已完成，但刷新/重登后历史中的脱敏卡片覆盖有效授权详情，使确认按钮禁用。已修正历史读取投影并增加有效/过期授权 API 断言。首次失败报告保留于 `evidence/g9f-controlled-browser-2026-10-25/report.json`；后续复测不回填首次结果。

受控修后第一次复测在新聊天切换完成前填入文本，触发测试时序问题；修正为等待创建响应、选中目标聊天并结束加载。下一轮点击了按时间排序的第一张卡（实际为拦截），却错误等待取消成功；修正为按“取消商户订阅 / 限制银行扣款”标题精确定位。两轮原失败仍保留。最终[受控浏览器报告](evidence/g9f-controlled-browser-final-2026-10-25/report.json) 1/1 通过，场景 4.8 秒；这是一次修后复测，不冒充首次通过。业务断言未放宽。

[冻结清单](../evals/g9f-browser-manifest.json)绑定264个产品/测试/配置及协议文件；[配置记录](evidence/2026-10-25-g9f-provider-config.json)为用户指定 apiw.pro/v1 / deepseek-v4.1-flash，json_object，thinking/reasoning/temperature均省略，live单次attempt、无结构修复、provider60秒。冻结副本和当前文件完整性分别核对。

[真实云浏览器首次报告](evidence/g9f-live-browser-2026-10-25/report.json)为0/1：首次 semantic 调用返回 HTTP403，后续业务未完成。实际只派发1次云HTTP（501毫秒），attempt起止闭合，输出上限4096；没有领域/reviewer调用、没有受控模型替代，token usage未提供。浏览器按原协议等待命令完成至超时，场景总时长211.773秒，这不是模型推理时长。查询卡已由合成用户确认；写入动作0，余额未变化。子命令保留 MODEL_HTTP_403（semantic_intent，retryable=false）。隔离schema、用户、worker、端口和临时目录清理均成功。另一次[最小连通诊断](evidence/2026-10-25-g9f-cloud-connectivity-diagnostic.json)以16 token上限同endpoint/model请求也403；它独立计数，不是业务复测。仅凭这两份证据无法确定密钥、模型权限、账户状态或访问限制中的具体原因；没有把403描述为模型业务判断错误。

初次全仓运行 2997/3019 通过，22 个失败全部来自两个旧 journal 集成夹具的清理语句：新增外键后仅 TRUNCATE 命令表不合法。仅将同一隔离 schema 的续办表加入清理列表，不修改测试断言。另保留集成期类型错误和队列测试构造修正的日志；不将开发失败轮覆盖为通过。

## 运行态与后续边界

原演示数据库只读比对：49 表、97 条命令原字段摘要不变；相比 G9E 仅既有 investment_actions/investment_outbox 后台历史变化，无移除表。全仓旧夹具 `tests/api.integration.test.ts:15,84` 使用 public pool 执行 migrateApi，间接新建空的 public.bp_subscription_continuations；中途实查为50表，原97条命令摘要仍不变。这一临时 schema 影响单独保留，不能描述为原库完全未受影响。[清理记录](evidence/2026-10-25-g9f-legacy-fixture-cleanup.json)证明该表基线不存在且0行，在事务内独占锁后DROP RESTRICT，不使用CASCADE。最终[清理后只读对照](evidence/2026-10-25-g9f-runtime-after-cleanup.json)恢复49表、无新增/删除表差异，全部表摘要与本轮开始相同，97条原命令摘要相同。中途的auth用户/session/account变化随浏览器清理消失。后续全仓应显式使用独立 TEST_DATABASE_URL，避免旧夹具再次迁移演示public schema；本轮未重置原账户或执行原账户资金动作。运行时实查原 PID 31901/31902 已不在，8787/5178 无监听，不能声称原演示仍在线，也没有自动启动未发布候选。

G9E 已知36和补充12的缺口仍保留；本轮单个双订阅场景不提供新的六域总体成功率。未见样本、多轮浏览器故障覆盖、容量、更新交付包和接收方验收仍未完成。没有真实银行接入、资金交易或比赛提交。

[最终完整性核对](evidence/2026-10-25-g9f-final-integrity.json)：264文件当前/冻结副本无漂移，本轮文本与trace未发现配置密钥，.env权限0600且git忽略。旧凭证403的具体原因没有得到服务商确认；新凭证结果独立报告，没有修改模型参数或更换为受控输出来回填旧失败。

[浏览器独立汇总](evidence/2026-10-25-g9f-browser-independent-summary.json)分别保留4轮受控开发验证与1轮真实云结果：受控依次失败、失败、失败、通过；真实云失败。5轮均retry0、skip0、flaky0，cleanup.clean=true。额外HTTP诊断独立计数；最终全仓日志是full-check-verified，并非名称含final的早期失败日志。该复核agent曾编写浏览器spec，复核独立于主代理的运行与汇总，不冒充完全不了解实现的盲审。

## 用户更换凭证后的独立真实云验证

用户在本轮403反馈后提供新密钥；仅更新本地.env凭证，endpoint/model/其他参数及264个冻结文件不变。[条件变更记录](evidence/2026-10-25-g9f-new-credential-run-note.json)明确保留旧报告，不回填失败。

[新凭证轮真实云报告](evidence/g9f-live-browser-new-credential-2026-10-25/report.json)：**1/1通过，场景22.922秒**，Playwright重试0。3次实际云调用均HTTP200：semantic_intent 5.281秒、subscription 6.690秒、reviewer 4.443秒；持久attempt起止均闭合，每项一次。受控调用0。实际输出上限4096/14336/14336（总32768）；输入tokens7297、输出2092、其中reported reasoning1153，不将reasoning再加到completion总量。没有据此计算价格或宣称一般性能。

该场景实际完成无grant原请求、查询单独确认、保持原user message的自动子计划、两张独立待确认卡、刷新/重登恢复，以及逐项授权完成。真实Core中query proof1+write proof2，两个订阅分别商户取消/银行阻止，原账户余额和转账总账不受影响。全部隔离资源清理成功。旧403轮和最小诊断仍分别保留，因此本结果是新凭证条件下1/1，不是原轮从失败改为通过。

[新凭证轮独立审计](evidence/2026-10-25-g9f-new-credential-independent-summary.json)核对业务终态、调用元数据和冻结完整性；浏览器附件不提供raw模型语义全量重算证据。完整项目继续active，后续仍需六域质量缺口、独立未见样本、更多恢复路径、容量与交付验收。

新凭证轮收尾：[完整性与密钥检查](evidence/2026-10-25-g9f-new-credential-integrity.json)264文件无漂移、输出证据未发现新密钥；[原库只读复验](evidence/2026-10-25-g9f-runtime-after-new-credential.json)49表与97条命令全部摘要仍与本轮开始一致。
