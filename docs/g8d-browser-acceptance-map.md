# G8D 现有浏览器验收映射（只读梳理）

核对日期：2026-10-23。本轮G8D运行已结束；本文记录现有测试的验收映射，以及第0、第3节明确引用的最终运行结果。本梳理Agent没有启动浏览器测试、云请求、数据库操作，也没有读取 `.env`。本次仅更新本文，冻结的 apps/packages/tests/scripts/evals 源文件保持不动。

## 0. 本轮最终进度与接受边界

**现有六流程浏览器6/6通过；直接理财/目标执行另行1/1通过。** 这是两个独立运行、不同合成账户和不同入口的结果，不合并为六领域从云模型到资金执行的全链验收。

- 六流程从UTC **2026-10-23T09:00:37.605Z**开始，运行报告总时长 **302720.39ms**；6 passed、0 skipped、0 failed、0 flaky，全部retry=0。135文件冻结快照的运行源码和副本均零漂移。
- 8个JSON附件去重得到7个返回计划，重放的同taskId结果规范化比较一致；其返回`ModelRun`共 **18条：15 success、3 failed**。这些来自应用返回结果，不是独立的逐次供应商请求持久化日志，不能把6/6写成18次模型均成功。
- **响应丢失恢复流程**：reviewer首轮`MODEL_SCHEMA_INVALID`，第二轮成功，最终`effectiveApproved=true`。保留首轮失败，不将它改记为一次成功。
- **资金查询流程**：reviewer连续两次`MODEL_HTTP_502`，`rawApproved=null`、`effectiveApproved=false`；确定性只读资金事实仍可返回，页面展示与服务器事实相同、账户/动作不变，因此通过现有测试断言。**该项通过不代表独立模型复核成功**，更不授权任何资金操作。
- 浏览器三笔转账草稿和一笔赎回草稿只到待确认/待强验证；本次六流程没有授权执行。零模型直接表单专项的T+0/目标执行、T+2等待保持独立证据，见第3节。transfer UNKNOWN恢复、管理闭环及额外自然语言组合未因这次六流程通过而自动获得本轮通过状态。
- 输入用量16条被报告为0，另2条失败请求缺失输入/输出用量；不能据此推断零费用或完整成本。

六流程原始[运行报告](../evals/results/2026-10-23-g8d-browser-six.json)、[响应及返回计划汇总](../evals/results/2026-10-23-g8d-browser-six-responses.json)和[独立证据清单](evidence/g8d-browser-six-2026-10-23/evidence-manifest.json)均保留，清单绑定全部trace、6张本轮截图、来源hash与失败尝试。G8D完整24例模型回归、自动化和下一阶段缺口以[主报告](g8d-semantic-reliability.md)为准；浏览器6/6不覆盖或提高该24例的评分。

## 1. “六流程”与“六领域闭环”是两个集合

本轮已通过的六流程是 `conversations.spec.ts` 三项 + `semantic.spec.ts` 三项，共六个测试。它覆盖消息恢复、澄清、所有者隔离、转账提案、资金只读问答、赎回提案；其中转账与赎回均停在待本人授权，资金查询reviewer未完成。它不能单独证明六领域执行闭环、全部独立复核成功、Passkey 签名验证或未知交易查单恢复。

现有 E2E 共 9 个 spec、14 个测试。六个 Agent 领域为 transfer/bills/investment/card/subscription/goal；联系人别名是额外管理能力。账单和资金查询的闭环终点是正确的只读答案及依据，不能为了“执行”而创建写动作。

## 2. 按现有测试复用的验收矩阵

| 现有文件与测试标题 | 实际成功断言 | 授权/执行终点 | 模型和运行条件 |
| --- | --- | --- | --- |
| `conversations.spec.ts` — `lost acceptance response, refresh during planning and sign-in restore the same saved request` | 服务端已接受 POST 后浏览器丢失响应；刷新仍仅一条原消息、一个 command、一个 317.25 元草稿；重新登录恢复完全相同消息及 modelRuns；provider 转账数为 0 | `AWAITING_CONFIRMATION`，没有点确认 | 现有脚本/模型两模式均可运行；只拦截并丢弃浏览器响应，真实 POST 已送达服务器；不是伪造计划 |
| 同文件 — `explicit payee clarification survives refresh and preserves the original amount and revision` | 张伟重名澄清；刷新后选尾号 3361；新 command 保留 root/parent/revision=1；金额 30000 分；typed 槽位固定且后续不再次运行 semantic_intent | 新草稿待确认；不执行 | 两模式可运行；测试时间上限 390 秒 |
| 同文件 — `signing in as another owner clears history and rejects old conversation IDs` | 另一用户聊天为空；旧会话读取 404；没有旧 ID/动作 | 所有者隔离 | 整文件应一起跑：第三项依赖前两项为第一个用户创建的会话，单独 grep 第三项可能没有前置数据 |
| `semantic.spec.ts` — `semantic cloud request creates an exact pending draft, survives refresh and ignores an example` | 口语三百零七块五→30750 分、备注书展票；成功角色为 semantic_intent/transfer/reviewer；刷新草稿存在；完整示例 no_action 且无 transfer 事件；provider 转账数 0 | 草稿待确认，不执行 | 明确 `test.skip(!BANKPILOT_MODEL_NAME)`；必须真实模型模式才构成此项验收 |
| 同文件 — `funds query answers the protected spendable amount and displays the same server facts` | 回答包含确定性可安排金额；资金计划页展示同值；amount=0，无转账/目标建议；前后账户及动作相同；请求输出 cap 合计≤32768；桌面/移动无横向溢出 | 只读答案 | 同上，真实模型；200 秒测试上限 |
| 同文件 — `grounded redemption amount survives domain handoff as a pending strong-verification draft` | T+0 产品 427.35 元→42735 分；精确 positionId/version；RED、`AWAITING_VERIFICATION`；持仓不变；刷新理财页仍有待 Passkey 赎回卡 | 只到待强验证，未注册/使用 Passkey，未赎回 | 同上，真实模型；200 秒上限 |
| `transfer.spec.ts` — `real UI, worker, database and signed WebAuthn: yellow → red → unknown → reconcile` | 第一笔 600 元黄色确认成功；第二笔累计升级 RED；普通 confirm 只到待验证；注册 Passkey 后签名；记账后超时进入 UNKNOWN；保留占用；刷新手动查单后成功；provider 转账总数始终 2，不重复付款 | 完整转账授权→Worker→合成记账→未知恢复 | 两模式可运行；API 必须启用 sandbox；独立 Worker 必须运行；需要 Chromium CDP；模型模式测试上限180秒，脚本模式60秒 |
| `management.spec.ts` — `confirmed personal alias, signed card changes and distinct subscription cancellation/blocking` | 别名保存前不写；确认后写；卡片强验证挂失 ACTIVE→LOST→ACTIVE；订阅先单独授权查询；聊天取消可取消商户；另一商户只银行拦截，商户仍有效；刷新可恢复；余额不变 | 别名/订阅本人确认，卡片 RED 签名验证；合成管理状态确实写入 | 两模式可运行；只有聊天取消订阅这一步走 Planner；其他动作从专用表单准备。管理授权在服务端处理，无需据此声称管理任务由 pg-boss Worker 执行。240秒上限 |
| `investment-goals.spec.ts` 第一项 — `T+2 waits without cash credit; T+0 funds a separately authorized and locally replanned birthday transfer` | T+2 100.50 元受理后 SETTLING，无回执、不入现金；T+0 1000元独立强验证后到账；生日目标500.25→600.75元重规划保留原赎回动作和回执；到账前未创建后继转账；再准备并独立确认转账；最终所有节点 SUCCEEDED；刷新保持完成 | 完整理财与目标资金 DAG；T+2只验证等待，不等两个业务日 | 此项走 UI 表单和确定性 API，不发聊天模型请求；真实 Worker、PG、WebAuthn 验证；120秒上限；T+0 业务日即时到账假设在非业务日不成立，不能将周末顺延误判为资金丢失 |
| 同文件第二项 — `configured cloud planner persists an explicit birthday proposal without an immediate transfer` | 聊天生日目标200元、未来30日日期；无立即转账；余额不变；刷新目标和详情存在 | 模型提案→目标持久化，不执行目标资金链 | 名称虽写 cloud，实际不 skip 脚本模式；断言按环境在 model/scripted 二选一。150秒上限 |
| `bills-coverage.spec.ts` — `current partial statement and unprovided month stay distinct on desktop and mobile` | 本月 partial 明示；2020-01 未提供账单时不显示汇总，移动端说明不能理解为零消费；无动作、余额不变 | 账单只读证据和数据完整性 | 不发送聊天，不依赖模型；截图直接写 `docs/evidence/g8c-bills-*.png`，复跑前要保护原文件 |
| `finance.spec.ts` — `bill evidence, confirmed budget editing, live multi-agent refusal and refreshed plan` | 查看周期提示原交易；最低保留2000→2500元；保护5500、可安排2500；拟转4000被拦、缺口1500；无动作、刷新保留；桌面/移动截图 | 资金规则确实写入，拒绝越过保护的转账 | 两模式可启动，但含旧模型角色/次数严格断言，见第5节；180秒上限 |
| `language.spec.ts` — `language routing reaches real API contexts and exact-money drafts without premature execution` | 账单+卡片+订阅多领域只读；订阅只准备待确认查询；理财只读；重名收款人尾号3361、106.08元精确草稿；无provider转账且无订阅查询grant | 跨域提案与未授权零执行 | 两模式可运行；一次测试连续4个 Planner 请求，240秒总上限，不等于每次都有240秒；固定2026-09账单时间需注意数据种子随当前月变化 |
| `negation.spec.ts` — `explicit negation returns no draft, authorization, reservation or debit through live UI/API` | 明确不要转账：无建议/动作/授权按钮，前后账户相同，provider转账0 | 否定请求零执行 | 两模式可启动；model分支仍固定期望旧transfer/reviewer调用集合，与当前semantic no_action提前返回不一致，见第5节 |

## 3. 最小选择及执行顺序

以下保留现有测试的精确选择，不新增测试或替代scorer。G8D24例及A六流程已经结束；B中仅直接理财/目标第一项在本轮另行通过，B其余及C没有在本文证据中获得本轮通过状态。后续复跑仍应独立记录、避免并发云请求。完全不调用模型的子集见下，可与纯Planner模型评测并行，但仍使用真实合成资金和数据库。

### 零模型子集：执行专项已1/1通过，账单项未复跑

精确选择是`investment-goals.spec.ts`第一项和`bills-coverage.spec.ts`一项。不要以`^T`锚定grep：Playwright匹配含文件前缀的完整测试标题，已发生匹配0项的实际记录。下列选择没有该锚点：

```sh
node node_modules/@playwright/test/cli.js test tests/e2e/investment-goals.spec.ts tests/e2e/bills-coverage.spec.ts --grep 'T\+2 waits without cash credit|current partial statement and unprovided month' --workers=1 --retries=0
```

- 两项均不发送聊天或调用Planner，API保留model配置也不会因这些步骤新增模型HTTP请求。管理整项会聊天取消订阅，不能混入此零模型子集；会话隔离第三项虽不发聊天，却依赖同文件前面测试生成会话，不应单独选择后称完整通过。
- 两项不mock或推进时钟，目标日期使用实际当前时间+30天；不改Worker全局参数，不设置全局或用户故障。第1项依赖已有Worker，不必另启动重复Worker。CDP虚拟认证器只存在当前浏览器context。
- 新用户主账户、卡片、持仓、目标、赎回/转账动作均按userId隔离；正常执行600.75元会累加共享合成收款账户`external:payee-lin`，不应称全局账本零写入。第1项留下T+2待结算动作，已有Worker固有的`processDue()`会继续扫描全库到期赎回；测试本身不推进日期或批量操纵其他用户。与不访问API/DB的独立Planner评测没有用户账务竞争。
- 主线程已于UTC **2026-10-23T08:45:51.556Z**启动第1项，报告总时长 **7505.965ms**、**1/1 passed、0 skipped、0 flaky、retry=0**。135个冻结源文件零漂移；保存的trace统计84次API请求，模型dispatch入口请求为0，结合这些表单API不经过Planner的源码路径支持零模型边界；浏览器trace本身不是供应商服务端网络或账单观测。它证明真实本地UI/API/PG/Worker、虚拟认证器真实签名的合成T+0/目标执行和T+2等待；不证明后续T+2结算、硬件生物验证或云聊天目标入口。
- 实际结果：[`2026-10-23-g8d-direct-investment-goal-browser-run.json`](../evals/results/2026-10-23-g8d-direct-investment-goal-browser-run.json)；独立归档：[`evidence-manifest.json`](evidence/g8d-direct-investment-goal-2026-10-23/evidence-manifest.json)，含trace、截图路径、hash边界。早先带锚点grep选中0测试的原报告已保留，不算业务失败也不删除。账单项尚未运行，主线程为保护其固定历史截图暂缓运行。

### A. 保持与历史“六流程”可比较：6项

本轮已按现有测试完成6/6，最终失败尝试及复核边界见第0节。下列命令仅保留供复现，不需要为本文再重复运行。

```sh
node node_modules/@playwright/test/cli.js test tests/e2e/conversations.spec.ts tests/e2e/semantic.spec.ts --workers=1 --retries=0
```

必须报告 passed/failed/skipped 全部数量。没有模型时 semantic 三项跳过，不能写“六流程通过”。会话文件第三项保留在整文件中，避免前置会话丢失。

### B. 在A之后补齐授权、执行、未知恢复与账单数据边界：4项

```sh
node node_modules/@playwright/test/cli.js test tests/e2e/transfer.spec.ts tests/e2e/management.spec.ts tests/e2e/investment-goals.spec.ts tests/e2e/bills-coverage.spec.ts --grep 'yellow → red|confirmed personal alias|T\+2 waits|current partial statement' --workers=1 --retries=0
```

A+B共10项，为现有测试中兼顾历史比较与真实业务状态闭环的最小组合。B的理财/目标项通过专用表单，不能据此声称自然语言目标也通过。只验证核心资金执行时，可先在明确隔离的 scripted 服务栈执行 transfer + management + investment-goals 第一项，避免云随机性遮住签名/资金不变量；这部分必须标为脚本规划，不能算模型质量。

### C. 需要进一步证明六领域自然语言入口时：再加2项

```sh
node node_modules/@playwright/test/cli.js test tests/e2e/language.spec.ts tests/e2e/investment-goals.spec.ts --grep 'language routing|configured cloud planner' --workers=1 --retries=0
```

A+B+C共12项，覆盖多领域自然语言查询和生日目标语言入口。其余 finance + negation 两项已存在，不需要再造同类测试；但在当前真实模型模式下应先识别第5节所列历史断言差异，冻结期间不能为得到绿灯而修改或移除这些断言。完整运行9个spec共14项时，要保留这些失败并解释其层次。

## 4. 服务栈、端口、模式及重试边界

- `playwright.config.ts` 没有 `webServer`：测试不会自动启动 API、Vite 或 Worker。真实 API main、Web、Worker应预先运行，迁移须已完成；不要仅为了复跑而对已有演示库重复做setup。
- 默认入口 `http://localhost:5178`；Vite固定 `127.0.0.1:5178`、`strictPort:true`，`/api`代理到 `http://localhost:8787`。API可用 `API_PORT`改变端口，但Vite代理不会自动跟随，需运行器临时配置/代理。不要只改API端口就声称动态端口栈已联通。
- Passkey预期 origin 来自 `WEB_ORIGIN`，默认上述localhost；RP ID默认 `localhost`。浏览器baseURL、Better Auth可信origin、`BETTER_AUTH_URL`和签名expectedOrigin必须一致。切换为127.0.0.1或其他域名时不能沿用不相符RP ID。
- 默认Playwright每文件顺序执行，`fullyParallel:false`、workers=1，未配置测试重试；建议显式`--retries=0`。这不关闭生产Provider的重试。独立领域可能由LangGraph并行请求，同一测试Worker也不代表模型HTTP并发始终为1。
- 生产 `createPlanner()`默认语义入口；有同时配置的模型名称和地址时走真实模型，否则无provider走脚本。仅测试环境设置有模型名、API实际为scripted，会造成模式错配；仅给一半配置会启动失败。现有Playwright config主动读取`.env`，不能仅靠测试命令`unset`来假定跑到了脚本模式。隔离运行器应为API与测试使用同一份明确模式环境，必要时使用仓库外临时配置；本次没有读取该文件或确认当前配置。
- Provider默认单次60秒、最多2次，环境可限制至最多3次；语义结构修复复用这些次数与预算，不是无限重试。共享请求deadline最多180秒。`waitForConversationPlan`/会话poll上限190秒，只轮询已经保存的command，不创建或重发请求。个别测试自身60/120/150/180/200/240/390秒上限仍会先结束。
- Worker的pg-boss队列重试是资金执行/查单层重试，与模型重试、Playwright重跑不同。合成provider幂等及回执校验才是避免重复记账的保障。
- transfer故障注入需要 `SANDBOX_ENABLED=true`，否则后端故障接口404；UI目前仍可见演示控制。B中没有真实银行调用。

## 5. 当前旧断言与未覆盖项

1. `negation.spec.ts:33`的model分支固定模型角色为`reviewer,transfer`；当前`packages/agents/src/index.ts`在semantic no_action时提前返回，可能只有semantic_intent。此时“无写入/无授权”业务通过与旧模型调用集合失败须分别记录，不能把旧测试标题当成当下云模式已验证。
2. `finance.spec.ts:58`固定started角色为`bills,goal,reviewer,transfer`，且model成功调用数固定4；当前语义任务按真实领域分配，资金保护本身不必产生goal任务。应记录真实事件及旧断言差异，不临时强制多调用goal来满足测试。
3. transfer/management/language/目标提案等用`modelRuns.every(status==='success')`。若第1次结构失败、第2次合法修复成功，最终提案可能有效，但此严格断言仍失败。它验的是“所有尝试一次成功”式强条件，不能直接等价为最终业务语义失败，也不能删除失败attempt粉饰通过。semantic转账项只筛success角色，口径并不相同。本轮六流程已实际出现响应丢失流程reviewer首轮schema失败后成功、资金查询reviewer两次502仍以确定性只读事实通过的情况，6/6不能代表所有阶段或尝试成功。
4. 六流程、语言和生日提案测试不把聊天草稿再连续授权到成功；B提供的是另一个独立合成用户/专用表单的执行闭环。现有测试没有一个把六领域云聊天输出全部逐一授权执行。不能把不同账户/不同入口的两类结果拼成同一次全链闭环。
5. 浏览器只有transfer注入`TIMEOUT_AFTER_COMMIT`并查单恢复；没有浏览器赎回UNKNOWN恢复或T+2跨两业务日到账。现有`investment.integration.test.ts`已有UNKNOWN/结算/资金幂等验证，不必先复制新测试，但它不是浏览器验收。
6. 没有真实硬件Passkey、系统生物验证、跨设备同步Passkey、手机Safari或真实银行验收。当前浏览器桌面+390px视口是Chromium响应式检查，不是iOS实机。
7. 会话丢响应不是API/Worker进程崩溃。`api-shutdown-process.integration.test.ts`已有真实SIGTERM排空覆盖；lease/checkpoint接管另有集成测试，不能由浏览器reload推断进程恢复已通过。
8. 当前浏览器API main没有安装G7评测专用attemptObserver；浏览器附件/保存的modelRuns不等于`evaluate-g7.ts`的逐次fsync attempts JSONL。不要声称浏览器模型请求具有同样SIGKILL逐次日志证明。24例G7/G8D评测脚本也只评提案，不评本人授权或资金执行。

## 6. 强验证到底验证了什么

transfer、management、investment-goals使用Chromium CDP `WebAuthn.addVirtualAuthenticator`：ctap2/internal、resident key、UV=true、自动在场。浏览器确实生成密钥并签名，经`@simplewebauthn/browser`提交；`apps/api/src/webauthn.ts`的`@simplewebauthn/server`真实校验challenge、origin、RP ID、签名、UV、credential计数器、动作hash绑定及challenge一次性消费，校验结果未mock。

因此可以写“虚拟认证器产生真实签名，真实服务端验证通过”，不能写“真实用户完成指纹/面容验证”。`tests/api.integration.test.ts`另用Node crypto构造真实签名及错误签名/UV/origin/重放反例；Core集成测试直接传入`{level:'STRONG',proofId,...}`只是鉴权服务输入测试，本身不构成WebAuthn签名验收。

## 7. 新建用户与实际数据写入

E2E均通过Better Auth服务端API创建随机邮箱的独立合成用户，而不是共用setup的固定演示用户。浏览器测试连接`DATABASE_URL`，不会自动使用`TEST_DATABASE_URL`或临时schema；`afterAll`仅关闭连接池，不清理用户和业务记录。

| 选择/文件 | 用户数量与独立对象 | 会产生的实际写入和余额断言 |
| --- | --- | --- |
| A：conversations | 2个`conversation-e2e-*`用户 | 每人独立`acc-main-{userId}`；第1人会话/command/草稿/澄清修订；无转账或占用，800000分不变；第2人隔离检查 |
| A：semantic | 1个`semantic-e2e-*`用户，全文件共享 | 30750分转账草稿、42735分赎回草稿、保存计划与示例；不授权、持仓不变，余额800000分 |
| B：transfer | 1个`e2e-*`用户 | 两笔60000分合成转账；本地余额800000→740000→680000；UNKNOWN时第二笔60000分占用，成功后0；provider转账2笔及借贷分录；Passkey凭证/challenge/授权proof/审计/outbox/队列记录 |
| B：management | 1个`management-e2e-*`用户 | 用户私有联系人别名；`card-main-{userId}` ACTIVE→LOST→ACTIVE；2项订阅的授权grant、商户取消和银行BLOCKED；凭证/管理授权与审计；账户800000分不变 |
| B：investment-goals第一项 | 1个`investment-goals-e2e-*`用户 | T+2赎回10050分受理/占用未到账；T+0赎回100000分；目标改版及60075分转账；余额800000→900000→839925；T+0持仓500000→400000分；独立provider赎回与转账分录 |
| B：bills-coverage | 1个`bill-coverage-*`用户 | 独立合成流水/种子月标记/保护规则，读账单；余额800000分，无动作 |
| C：language | 1个`language-e2e-*`用户 | 10608分转账待确认草稿及未确认订阅查询候选；没有订阅query grant、没有provider转账；余额800000、占用0 |
| C：目标提案单独选择 | 新一轮运行创建另1个`investment-goals-e2e-*`用户 | 创建20000分目标、未来30日日期、保存计划；不执行、不改变当时余额；与B另一次命令运行的用户不同 |
| finance（额外） | 1个`finance-e2e-*`用户 | 最低保留200000→250000分、版本2、合成流水；没有实际转账，余额800000分 |
| negation（额外） | 1个`negation-e2e-*`用户 | 保存否定计划/会话，不产生授权、占用、转账，余额800000分 |

共有种子：主账户初始800000分；资金最低保留200000分、房租义务300000分；当前月+上个月合成流水（历史账单不再加到现金）；理财T+0本金500000分、T+2本金1000000分及各自`investment-fund:position:{userId}:...`合成provider资金账户；卡片为用户私有，商户订阅为云音乐/城市健身合约。

隔离边界：payee目录`payee-lin/chen/zhang-*`及合成provider收款资金账户`external:payee-*`是共享的，不是每用户独立。真实合成执行会累计这些共享收款余额；用户私有主账户和按userId过滤的provider_transfers不受其他E2E用户扣款影响。不可把“随机新用户”写成“完全独立数据库/全局资金账本隔离”。后台Worker也可能处理旧合成账户已经到期的T+2队列，因此应记录栈和库的复用边界。

## 8. 证据落盘与保留首测

- 默认trace=`retain-on-failure`、screenshot=`only-on-failure`：成功用例并不自动保留trace。默认HTML位于`playwright-report`，框架结果位于`test-results`。要逐次保留，使用独立`--output`以及独立`PLAYWRIGHT_HTML_OUTPUT_DIR`；JSON reporter输出也给独立文件，不用`--last-failed`或成功后覆盖首测。
- 测试中的显式`page.screenshot({path:'test-results/...'})`不服从`--output`重定向；账单覆盖项甚至固定写`docs/evidence/g8c-bills-*.png`。重跑前先归档原有这些具体文件，结束后复制到本轮独立证据目录，保留旧文件副本。单改`--output`不能保证固定截图不被覆盖。
- semantic的每次plan通过`test.info().attach`保存；conversations保存command和history附件；其余旧spec没有逐计划JSON附件，成功时通常仅显式截图和断言结果。要加强原始证据，可用运行器开启`trace:on`并保存API/Worker日志，但不应改测试或伪造未有的附件。
- 结果清单至少包含UTC起止、冻结snapshot/hash核对、完整test标题、mode、passed/failed/skipped、重试配置、API/Web/Worker端口和版本、合成用户/账户标识、JSON/HTML/trace/截图路径、余额/状态断言与失败层次。只保留非敏感配置，禁止记录凭据或连接串。
- 精确测试名称、固定截图路径和默认配置均已列出；本梳理Agent没有执行测试或创建新的浏览器测试/runner。第3节的单项执行证据由主线程提供，并已只读核对归档manifest和原始运行报告。

## 9. 普通页面目前可见的技术术语/代码位置（仅记录）

| 页面入口与位置 | 当前实际暴露 | 源码位置 |
| --- | --- | --- |
| 转账工作台→助手标题旁模式帮助 | tooltip直接提`PlanResult.mode` | `apps/web/src/App.tsx:576` |
| 同页→计划与执行进度，无计划空态 | `PlanResult.events`；处理中/已授权解释使用`Agent`、`Worker` | `App.tsx:780`、`:803`、`:805` |
| 同页→规划失败末节点 | 未经业务翻译的`failedModelRun.role`、稳定`errorCode`，如semantic_intent/SEMANTIC_* | `App.tsx:782` |
| 同页→模型运行记录 | 模型标识、每次耗时ms、失败errorCode、`schema`校验提示、`LLM`缩写；始终在普通计划卡展示 | `App.tsx:830` |
| 同页→下一笔执行故障 | 普通页面直接出现演示故障控制、`UNKNOWN`术语；后端sandbox关闭也没有此处UI条件隐藏 | `App.tsx:620`至`:630` |
| 同页→交易授权卡 | `RED/YELLOW`原始风险枚举、动作hash截断摘要；手动查单提示`动作 ID` | `App.tsx:1019`、`:1040`、`:1044` |
| 同页→聊天请求记录 | command失败时直接显示`lastErrorCode` | `apps/web/src/ConversationsPanel.tsx:257` |
| 全局→审计抽屉 | `auditDetail`直接拼原始字段名和值，如actionHash/proofId/policyVersion，未知event类型仅下划线转空格 | `App.tsx:680`、`:708`、`:711` |
| 账单→原始流水/周期对照 | 原记录ID是合成内部ID（例如fixture/user/month序列）；原交易按钮也带ID | `App.tsx:884`至`:886`；计划依据`:827`。这项兼具原始证据用途，不能仅因技术性就丢掉可追溯性 |
| 理财→总览、持仓规则 | `DEMO_WEEKDAYS_V1`日历代码和持仓版本；确认卡动作版本/hash摘要及模拟provider流水号 | `apps/web/src/InvestmentPages.tsx:65`、`:87`、`:117`、`:120` |
| 生日目标→节点内转账卡 | `action.status`原始英文状态（AWAITING_CONFIRMATION/AUTHORIZED/SUCCEEDED等）及provider流水号 | `apps/web/src/GoalsPage.tsx:123` |
| 卡片/订阅/联系人→管理动作卡 | 动作hash摘要；卡片/订阅数据版本 | `apps/web/src/ManagementPages.tsx:111`、`:214`、`:271` |
| 登录页、账单/资金错误态 | `本地 API`、`账单 API`、`资金规则 API`；多个错误区直接输出Error.message | `App.tsx:750`、`:878`、`:976`；管理/理财错误区亦如此 |

上述是面向普通用户的信息表达边界，不是源码/密钥泄露结论。仅保留为后续普通用户文案项；本轮没有修改界面或交互，也没有展开新的设计任务。
