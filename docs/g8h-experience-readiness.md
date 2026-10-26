# G8H 六领域受控体验验收准备

**状态更新：本准备方案已执行，最终六域6/6、全仓1524/1524，详见[G8H验收报告](g8h-experience-verification.md)。下文保留执行前的调研、建议与当时边界，不代表当前仍未实施。**

本记录原为下一阶段执行准备，2026-10-23只读核对现有E2E、隔离夹具、UI/API/Core后形成；本轮不跑测试、不访问DB/云、不改冻结文件。G8G主线程最终报告1472/1472、类型/构建通过、157文件冻结；这不是新增浏览器结果。[理想状态基线](ideal-state-acceptance.md)仍以“部分证实”为总体结论，G8G评测适配已完成，本文仅准备后续体验验收。

## 证据起点与六领域边界

历史G8D已知24例19/24、六条既有浏览器6/6保持原数：后者18条返回ModelRun有3条失败，主要是UI/提案断言，不是六领域完整执行。独立直接理财/目标执行1/1另计，详见[浏览器验收映射](g8d-browser-acceptance-map.md)。G8F最终受控浏览器4/4覆盖服务故障恢复和格式错误，未授权执行；G8E真实云接入0/1也不被受控结果替换。

以下“现有断言”指测试实际检查内容，不宣称这些旧测试已在157文件冻结版重新通过。六领域是转账、账单、理财、卡片、订阅、生活目标；资金保护查询属于goal职责，不另算第七域。

| 域 | 已有局部证据／现有断言 | G8H必须补齐的用户链路与边界 |
| --- | --- | --- |
| 转账 | `transfer.spec.ts`定义聊天提案→黄档确认→真实Worker成功→第二笔红档虚拟Passkey签名→记账后超时UNKNOWN→刷新查原单，余额800000→740000→680000分，provider交易始终2笔；`conversations.spec.ts`有同名收款人澄清/金额与revision保留；`semantic.spec.ts`有307.50元精确草稿及示例零动作 | 同一隔离版本重新串通聊天语义、领域、reviewer、真实授权和执行；加未授权余额/占额不变、取消/重复确认不重复付款、UNKNOWN原回执与唯一provider key。禁止仅以出现确认按钮判闭环成功 |
| 账单 | `finance.spec.ts`核对原始流水、周期发现引用；资金保护2000→2500元规则真实保存，拟转4000元被保护规则拒绝，无动作；独立bills-coverage历史覆盖partial与缺月 | 通过聊天读期间/证据并跳转原交易；缺月不能当零，必要澄清不得创建资金动作；账单本身只读，无授权/执行回执，最终证据为report范围、流水引用及前后资金相同 |
| 理财 | `semantic.spec.ts`427.35元只到RED待强验证草稿；`investment-goals.spec.ts`第一项直接表单真实T+2 SETTLING无现金、T+0强验证到账并保留receipt；该直接专项历史1/1 | 补聊天→完整position/金额/版本→待验证→真实签名→Worker→赎回原单/分录/现金回执；T+2等待不冒充到账，未知持仓/金额澄清无占仓。T+2实际到期结算另立受控时间用例 |
| 卡片 | `management.spec.ts`直接表单准备挂失，授权前ACTIVE；虚拟Passkey强验证后LOST，再签名解挂ACTIVE，余额不变 | 补聊天查询/typed尾号/歧义→提案→管理签名→状态与版本/审计回读；卡片管理确认由服务端完成，不虚构pg-boss执行或转账回执 |
| 订阅 | 同文件先单独确认查询才显示快照，聊天取消支持商户的订阅；另一商户银行拦截后商户合同仍有效，明确不支持商户取消；余额不变 | 在隔离夹具重现查询授权grant→聊天提案→本人确认→取消与银行拦截各自终态；无grant不读订阅，不把bankBlocked当商户已取消；无周期扣款调度、真实商户执行能力，不能宣传完整自动退订/退款 |
| 生活目标 | `investment-goals.spec.ts`第一项直接建目标500.25→600.75元，筹资1000元到账后保留原赎回ID/receipt、独立准备并确认转账，所有节点成功且刷新保持；第二项聊天仅证明目标持久化；G8F75例守卫区分目标筹资与独立操作 | 补自然语言未来目的、完整截止日、目标金额与另一筹资金额→goal+investment+reviewer→持久化DAG→独立赎回授权→实际到账→独立转账授权→终态与账本。截止日期不等于自动付款许可，独立赎回/转账混合不能吞成funding |

## 最有价值的完整演示主线

主线建议为“先核对本月账单与保护资金，再为明确未来学费目标筹资，到账后向指定收款人付款”。使用独立合成用户和目录中的真实对象，目标金额与赎回金额必须不同；截止日包含年份且明确晚于预计结算日。

1. 登录后查看账户、完整性提示、账单范围及原流水证据；聊天只读回答与服务端相同，不创建动作。保留资金保护规则；不足时展示业务拒绝，不伪装服务失败。
2. 聊天提出完整学费目标及指定T+0持仓筹资。受控HTTP返回真实格式的semantic候选，经过原来源校验、实际领域与reviewer调用后才落目标；检查两组金额/实体/期限、无独立即时转账或独立赎回建议，刷新仍保留同一目标。
3. 在目标详情准备赎回；授权前无持仓占用/现金变化；浏览器虚拟认证器完成真实注册和本笔签名，服务端验签、持仓版本/hash绑定后由隔离Worker执行。读取真实赎回receipt及现金入账，不能用预计时间线当到账。
4. 核对到账节点成功后才准备后继转账；该转账仍独立确认或按实际风险等级强验证。Worker完成后核对收据、借贷分录、账户/占额、全部目标节点及刷新/重新登录状态；重复advance/刷新不生成重复资金动作。
5. 保留原请求、command/root/revision、语义来源、阶段结果/历史、modelAttempts和动作引用。插入一次reviewer临时故障，刷新后显式重试原command，只继续未完成阶段；不能为通过另发用户消息或跳过reviewer。

这条主线在用户体验上贯通账单、理财、目标和转账；卡片、订阅另做短支线，避免为了六域同时出现而制造无意义的联合授权。受控输出证明产品链路和协议处理，不证明模型理解质量。

## 建议自动验收范围与复用方式

- 建议六项独立业务场景：①转账精确金额/澄清与YELLOW→RED→UNKNOWN查单；②账单证据/缺月及资金保护拒绝；③聊天理财T+0完成和T+2等待；④聊天卡片查询/歧义及挂失解挂；⑤订阅查询grant、商户取消与银行拦截；⑥上述生活目标全链。每项新用户；跨域主线另用自己的用户，不能依赖其他test留下状态。
- 复用现有测试步骤、locator和API/Core断言，不改旧cloud测试skip条件或削弱旧严格模型断言来声称通过。旧 `semantic.spec.ts`明确要求配置云模型，`finance.spec.ts`还固定旧4次成功调用口径；应保留历史，新建受控suite并绑定新证据。
- 完整保留G8F语义/领域/reviewer故障与永久格式失败4项，至少在主线插入一项恢复；其他故障作为原专项回归，不把四个恢复测试重新计为六域闭环。
- 真实服务链是浏览器→BetterAuth→Hono→实际Planner语义/领域/reviewer→PG→Core/管理器→真实Worker；只替换明确`.invalid`模型HTTP响应。受控候选使用输入目录和确定性context，仍必须经过生产schema/来源/领域契约校验，不能拦截页面业务API或用固定PlanResult绕过主链。
- 先typecheck与无DB受控provider单测，再隔离PG/API专项，最后Playwright单worker、retries=0；首次失败原报告保留。不得在未运行时预填通过数。选现有测试标题时不用`^T`等锚点，Playwright匹配完整标题含文件前缀。

## 隔离、授权与终态取证

- 复用 `tests/fixtures/g8e-browser-app.ts` 的动态127.0.0.1 API/Vite端口、configFile:false与临时envDir，不碰8787/5178；真实BetterAuth使用单独authPool、随机secret/cookie prefix和动态origin，不迁移public auth全表。数据库连接只允许本机回环；不输出连接串/口令。
- 当前夹具仅生成transfer semantic/domain/reviewer输出、sandbox=false、未启动Worker，不能直接承担完整六域执行。扩展应在新增G8H夹具/受控响应工厂内完成，不覆盖G8E/G8F历史证据或改变生产配置。
- 每场景创建随机唯一user与独立业务schema；创建真实 `startWorker(pool,core,investment)`，其pg-boss使用`${schema}_jobs`，并只扫描该schema outbox/processDue。不能借用正在运行的原Worker或直接调用core.execute假装Worker完成。
- 使用Chromium CDP CTAP2虚拟认证器，真实生成密钥与签名，SimpleWebAuthn服务端实际验签；不mock注册/鉴权成功响应。它是软件认证器，不是实体Passkey、生物识别或生产银行认证验收。
- UNKNOWN故障只在专属fixture启用sandbox路由并绑定该用户/下一笔，模拟TIMEOUT_AFTER_COMMIT；不能修改本地API全局故障。只查原provider key，不换单重付；测试收尾前确认provider交易笔数及借贷分录唯一。
- 优先真实当前业务日运行T+0；若要可重复T+2到账，Core/Finance/Investment/Goals均已有实例clock选项，可为独立schema注入一致时钟并明确记录推进。不得改全局Date/共享Worker时钟；PG outbox用now()，必须同时核对派发可用时间，不能以任意推进浏览器时间替代实际结算。
- 终态附件包括：初始/最终dashboard、funds、持仓与卡片/订阅快照，原command/history及阶段/attempt记录，目标DAG、动作hash/version/status、真实receipt、provider_transfers/provider_redemptions、借贷分录/outbox和审计事件。按user/schema过滤；外部合成收款账户也写在该schema中，不声称全局账本无写入。
- 在未授权、被澄清、服务失败、业务拒绝节点均保存金额/占额/占仓与provider计数证明；读API响应和DB终态相互印证。UI成功文案、HTTP200、队列入列或模型approved=true都不能单独代替执行回执。
- 保存每项raw与截图/trace、独立JSON报告、源码冻结前后哈希、证据manifest和清理结果；脱敏认证cookie、密码、密钥和签名响应。截图至少覆盖待确认、强验证、到账等待、最终回执、恢复失败/成功及移动端关键卡片。
- 清理顺序：停止接入/排空规划→等待执行终态或明确记录待结算→停止专属Worker并记录errors→关闭浏览器/Vite/API与pool→删除仅本次业务及jobs schema、仅本次public auth user/session/account→删除临时目录。核验端口关闭、Worker/timer已停、schema/user已删；失败也执行finally清理且保留产物。

## 有事实支持的变更候选与保持的限制

1. 必需测试基础设施：新增六域受控响应、隔离Worker生命周期、schema/jobs/auth清理和只读终态快照；当前G8F fixture没有这些执行能力。无需先改Planner、Core金额规则或生产鉴权。
2. 目标页面当前将“生活目标”统一标成“生日目标”，节点内也写“生日目标转账”；`GoalsPage.tsx`直接展示action.status英文，投资页仍展示日历代码/版本。属于可定位的普通用户文案候选，先在体验测试取证，不能为通过断言仅改测试文案。
3. `transfer.spec.ts`/`management.spec.ts`/`investment-goals.spec.ts`旧afterAll只关pool，并不删除其合成用户；新suite必须采用隔离schema清理，不直接重跑这些共享库测试后声称资源已清理。
4. 尚无证据需要重做业务架构；若受控完整链发现真实缺陷，先保留失败和阶段/资金证据，再单独授权修复。无真实机构、商户周期扣款、T+2自然时间长跑、硬件认证、云模型质量、新未见集、数据库物理故障或空机器交付结论。

本阶段结束标准应分别报告六域各自通过/失败、实际授权/执行范围、跨域主线终态和资源清理；受控链路通过后仍保留真实模型质量与外部接入的独立未完成状态。
