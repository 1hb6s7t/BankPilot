# G8A 持久对话、字段澄清与原命令恢复验证

## 2026-10-24 G8N 当前证据与后续工作

[G8N 目标用途、日期与真实云端验收](g8n-cloud-goal-validation.md)已完成代码修复与分项验证：**1836/1836（83 文件）**，类型检查与构建通过，206 个受跟踪源码文件及副本冻结，与最终实跑版本零漂移。新增精确原文 purpose、共享 80 字标题边界、缺年诊断和一次受限日期重生；非日期字段、筹资关系及既有预算保持严格校验。开发按语义高推理、事实/模型评测、独立复核和主 Agent 集成并行分工。

完整已知 24 例原判 **21/24**，`executionComplete=true` 但 `validRun=false`：g708/g709 两例 HTTP 502 导致业务不可用，g719 为“不会取消商户”与旧固定子串的评分假阴性。后两类问题分开记录；g721/g722/g723 均首次通过，本轮真实日期重生触发 0 次。服务恢复后两例 HTTP 故障[独立补验 2/2](evidence/2026-10-24-g8n-model-http-supplemental.json)，未回填原轮。原轮 63 次请求闭合，其中 4 次 502；4 次缺 usage，总量未知；中位数 27.527 秒、P95 95.143 秒。详见[模型审计](evidence/2026-10-24-g8n-model-validation-v4.json)。此前 G8M 对 g719 的“事实遗漏”分类由本轮复核更正为评分假阴性，历史 20/24 不改。

当前受控六域浏览器 **6/6**；真实云端原轮筹资目标通过、另外两例 502，结果 **1/3**，随后[定向浏览器补验 2/2](evidence/g8n-live-browser-2026-10-24/http-recovery-retest/report.json)。三条真实云端路径分次完成，未合并为单轮通过率；11 次最终候选浏览器运行全部清理成功。只有受控资金三例使用显式营业日业务时钟，管理/转账和真实云端保持真实时间。补验采用新隔离环境，不是对原失败命令的恢复验收。

本地 API、Worker 已更新并加载指定 `apiw.pro/v1` / `deepseek-v4.1-flash`，页面/API 健康正常；49 表中 47 表摘要保持，另两张理财执行表有原有后台更新，原账户/回执/聊天/97 命令保持。见[最终核验](evidence/2026-10-24-g8n-final-verification.json)。未见泛化、更多真实云端业务链、服务波动/长尾/容量、新版本导出、接收方和比赛交付仍待完成，整体仍为部分证实。

## 2026-10-24 G8M 历史状态

[G8M 服务端准备请求与新浏览器恢复](g8m-server-preparation-recovery.md)已完成：**1684/1684（81 文件）**、类型检查和构建通过；新恢复 **8/8**、领域回归 **12/12**、历史回归 **10/10**、软件 Passkey **1/1**，31 项清理通过，无最终运行内跳过、重试或 flaky。202 个源码文件及副本已冻结，当前源码/浏览器候选零漂移；Vitest 通过后只修正了不在其输入内的一处浏览器等待逻辑，生产与单测依赖零变化，分别保留候选清单。

服务端接受、原输入、结果及停止状态持久化；停止和候选创建由同一登记行锁与事务决定。新浏览器可按当前账户找到原请求，重试保持原编号和内容，已准备结果只读返回；停止不取消已有动作。覆盖真实 PostgreSQL 候选连接终止、创建/停止竞争、旧映射参数冲突、目标提交后推进失败、延迟状态与分页故障。详见[最终核验](evidence/2026-10-24-g8m-final-verification.json)。

本地 API/Worker 已重启加载 G8M 和新模型，只增量新增登记表。原 48 表中 46 表摘要相同，两张理财执行表有后台查单更新；原账户、回执、对话与 97 命令保持。新模型 `deepseek-v4.1-flash` 在 `https://apiw.pro/v1` 的目录及真实结构化调用通过；固定已知集 **20/24** 业务通过、**59/59** 请求 HTTP/schema 通过、0 越权提案，模型预期调用阶段完整 **22/24**。四项失败为必需事实遗漏或生活目标提前澄清，仍未通过质量门槛；中位数 16.71 秒、P95 40.67 秒。评测的 29 个模型/评分依赖起止零漂移，同时期另有登记逻辑与两处测试共三文件变更，已显式保留全树差异。见[模型核验](evidence/2026-10-24-g8m-model-validation.json)。

恢复浏览器为合成数据和同机独立上下文；模型评测只产出规划，不执行交易。新未见样本、真实云浏览器、性能容量、新源码包、接收方与比赛提交仍待完成，G8I ZIP 保留为历史包。整体状态继续为部分证实。

## 2026-10-24 G8L 历史状态

[G8L 领域操作丢响应恢复与订阅披露期限](g8l-domain-response-recovery.md)完成：**1671/1671（79 文件）**、类型检查与构建通过；194 文件冻结，与最终实跑版本零漂移。本轮恢复浏览器 **12/12**、聊天恢复回归 **10/10**、软件 Passkey 转账回归 **1/1**，无跳过/重试/flaky，23 项临时资源清理通过。新增 25 项请求记录/业务查单/隐私测试和 7 项目标合并测试已包含在全仓分母内。

准备动作持久保存原编号与内容，查单明确区分缺少命令映射和读取失败；目标提交后子动作冲突仍保留身份，每次再次发送前失效前次拒绝证据。已有动作读取失败时阻止重复授权，重新进入页面先核对原动作。旧列表不撤销恢复选择，同计划合并保留确定的完成证据；订阅明细按原授权截止时间隐藏，旧缓存不能覆盖新脱敏观察。业务只读接口不推进、不准备、不执行或释放占额。详见[最终核验](evidence/2026-10-24-g8l-final-verification.json)。

API、Worker 与 Web 已运行 G8L，48 表中 46 表摘要一致，原账户/回执/会话/消息/97 命令保持，两张理财执行表有后台更新。10:02 上海时间模型目录仍暂停，本轮 2 次目录 HTTP、0 次云生成；G8I ZIP 仍为历史包。当前标签页恢复不等于跨设备恢复；未知原请求持续被拒绝时仍保留编号，未实现服务器撤销未受理请求协议。后续继续其他持久化故障窗口、真实模型与新未见样本、性能容量、接收方/比赛交付。总体仍部分证实。

## 2026-10-24 G8K 历史状态

[G8K 聊天分页与恢复事项](g8k-bounded-history.md)已完成：**1639/1639 自动化（76 文件）、10/10 历史与恢复浏览器、1/1 软件 Passkey 转账回归**，类型检查与构建通过，187 文件冻结并与实跑版本零漂移。列表按页访问超过 100 个聊天，较早选中项精确恢复；消息页仅关联本页命令，旧 pending/failed/waiting 通过独立摘要分页发现。取消/回答同事务推进父版本，成功响应在后续读取失败时仍关闭旧澄清，真实迟到响应窗口已验收。11 项临时资源清理通过，5178 演示已恢复运行且原账户/聊天/97 命令摘要保持。详见[最终核验](evidence/2026-10-24-g8k-final-verification.json)。09:20 上海时间目录仍暂停，本轮云生成 0；性能容量、其他未知响应、云质量与比赛交付继续独立完成。

## 2026-10-24 G8J 历史状态

[G8J 长历史、规划与账户恢复](g8j-history-recovery.md)已完成：**1602/1602 自动化、8/8 规划数据库真实故障、4/4 长历史与状态浏览器、1/1 软件 Passkey 转账回归**，类型检查与构建通过，183 文件冻结。修复旧计划选择、历史缺页、同时间状态顺序、逐命令额外查询、连接错误，以及迟到账户快照和已提交确认响应丢失后的展示恢复。最终用例均已清理临时资源，本地 API 与 Worker 已更新，原数据摘要核对完成。详见[最终核验](evidence/2026-10-24-g8j-final-verification.json)。本轮模型 HTTP 受控、云调用 0，没有重新探测云服务；全量历史 payload、100 聊天上限、其他未知响应窗口、真实模型质量与比赛交付仍未完成。

## 2026-10-23 G8I 历史状态

[G8I 数据库恢复与独立交付](g8i-database-delivery-verification.md)已完成：**1544/1544 自动化、4/4 真实数据库故障、独立副本初始与重启后浏览器各1/1**，类型检查/构建通过，173文件冻结。真实断连/COMMIT回应丢失/数据库SIGKILL揭示并修复连接事件未处理问题；新副本完成逐笔授权、业务终态与全服务重启持久性验证，可分发最小源码ZIP已逐成员核验。旧本地演示已加载G8I并保留原数据。G8I云生成0，23:08上海时间只读目录仍为暂停页；合成同库故障、同机新副本与真实模型/空机器/比赛提交分别计量。

## 2026-10-23 G8H 历史状态

六领域受控体验已完成：**1524/1524 自动化（67 文件）、浏览器6/6、类型检查和构建通过**，167文件源码冻结且零漂移。本地API和Worker已加载G8H；赎回时间一致性/异步恢复、Worker启动清理、订阅刷新读取与生活目标文案已修复。六域终态、52项新增测试、失败轮次、资源清理和运行数据比较见[G8H报告](g8h-experience-verification.md)与[最终核验](evidence/2026-10-23-g8h-final-verification.json)。本轮模型HTTP受控、云调用0；真实云质量、数据库物理故障和清洁环境交付仍待后续。下文G8G及更早记录保留其当时结论，不作为当前未完成项列表。

**历史续记：G8G（当时状态）。** 三个评测入口已适配阶段失败和独立attempt观测，保留局部错误、完整调用、未知usage、预算与业务不可得分母。**1472/1472（63文件）**、typecheck/build通过，冻结157文件；脚本五组188/188，G7无语义组3/24与隔离复跑G8F冻结版逐例相同。详见[G8G报告](g8g-evaluation-observation.md)。本地API继续运行G8F，上一阶段4/4受控浏览器证据保留；G8G无新增云或浏览器验收。最近G8E真实接入仍为0/1，当时目录返回暂停页。下文保留G8A–G8D历史；G8G当时未完成的六领域受控体验已由G8H接续完成，其余数据库故障、未见样本和交付仍待继续。

日期：2026-10-23，续记：2026-10-23。G8A 已实现，G8B 冻结版全仓自动化为 **889/889（39 文件）**，恢复/迁移/退出专项为 **8 文件、40/40**，包含真实 SIGKILL 并行领域恢复和 SIGTERM/SIGINT 排空。G8C v1 通过 **1039/1039（46 文件）**、typecheck 与 build，冻结 130 文件；v2 通过 **1091/1091（47 文件）**、typecheck 与 build，冻结 131 文件。v1、v2 的六流程云模型浏览器分别为 **5/6**、**5/6**，不是本页历史 G8 流程的 1/6；v2 修复了赎回误判，但示例转账仍误判。G8C 账单页面专项 **1/1** 是独立无模型检查。G8D 自动化 **1218/1218（50 文件）**、typecheck/build 通过，135 文件源码已冻结；全 24 例真实已知回归严格通过 **19/24**，G8D 六条既有浏览器流程 **6/6**。后者包含 18 条返回的 ModelRun，其中 3 条失败，因此只证明现有 UI 断言通过，不是模型全成功或六领域执行验收。详见 [G8C 报告](g8c-semantic-completion.md)及历史 [G8D 可靠性报告](g8d-semantic-reliability.md)。这些证据不互相替代。生产图恢复仍由 `BANKPILOT_CHECKPOINT_RECOVERY=true` 显式启用，默认关闭。

## 实现与复用

本轮继续适配 assistant-ui ExternalStoreRuntime、PostgreSQL/pg、Better Auth 和现有 command journal/Core。没有新增数据库、托管聊天服务或依赖。框架只渲染应用提供的消息；消息同步与持久化仍由应用负责，符合 [assistant-ui 官方接口](https://www.assistant-ui.com/docs/runtimes/custom/external-store)。消息顺序与澄清并发由 PG 行锁、唯一键和版本条件控制，复用了 [PostgreSQL 的显式锁能力](https://www.postgresql.org/docs/current/explicit-locking.html)。选型、维护与许可证据延续 [G8 复用调研](phase8-reuse.md)，本轮核对官方能力与本地安装接口，未升级冻结依赖。

- `apps/api/src/conversations.ts` 与共享 contract：保存原文、消息顺序、clientMessageId、原 command、root command/revision、助手答复及失败；消息和 pending command 同事务接收。历史 GET 用 REPEATABLE READ READ ONLY 快照，避免混读完成状态和缺失答复。
- `apps/api/src/plan-runner.ts`：旧 `/api/plan` 与聊天复用一个内部规划执行器。完整 PlannerInput 在领域规划前按当前租约冻结并绑定版本/digest，重试验证后复用；proposal 写入不覆盖输入快照。随后仍先冻结 proposal，再使用稳定业务子命令创建草稿；result 和最终助手消息同事务。失败按 lease attempt 保存，旧 token 不能覆盖结果或追加旧失败。
- `apps/api/src/clarification.ts`：支持单笔转账的收款人/尾号消歧和缺金额，以及无赎回依赖目标的完整日期补充。原金额、对象和日期来源保留；仅补所请求字段，候选姓名/银行/尾号改变时拒绝续接；缺年份必须保留原月日。一个问题的并发回答只能产生一个后继 revision。
- 前端：服务端历史为权威，以稳定 ID/sequence 渲染；显式选择“继续补充此请求”，默认是新请求；未知响应复用冻结的消息 ID 和 payload，失败/过期原命令可重试。历史文字保留当时事实，“查看计划”读取当前动作状态。
- 会话隔离：账号及聊天各有 generation/abort 防线；切换立即清空旧消息与计划，迟到响应被丢弃。sessionStorage 仅保存按账号隔离的选中聊天 ID 和退出中布尔标记，不保存消息正文或授权信息。退出成功后才开放登录；刷新时优先完成尚未结束的退出。

后台规划是在消息提交之后启动的应用 Promise；它本身不是持久队列。若进程在提交后终止，数据库保留 pending/过期 running，用户通过原 command 的继续/重试入口恢复，不能把它描述为后台任务自动跨进程继续。授权、占额、Outbox 和执行保持在现有 Core/Worker 内，聊天回复或恢复不能授权交易。

## 并行开发与独立复核

Astra 负责服务端聊天、字段来源和 CAS 澄清，并只读复核主 Agent 的 runner/API；Sol 负责 UI 恢复、会话隔离与退出生命周期；Luna 独立编写 API 故障验收；主 Agent 负责共享 runner、路由、可信字段接入及浏览器实测。按资金语义/并发风险、前端状态复杂度和测试任务分别分配，开发模型分工不等于产品已经实现多供应商路由。

Luna 的首轮扩展 API 检查发现两条 typed transfer 因默认备注不一致而失败：用户没有提供备注，领域解析器却补入系统默认备注。修复显式设置空备注，保留严格相等检查；同一测试后通过。另一项首测失败是隔离套件共享 Core schema 下的旧计数假设，已改为前后增量断言。Astra 的独立审查发现 claim 前后提案与 prepared input 版本混用，已改为从同一个 UPDATE RETURNING 行读取。

## 自动化与源码记录

G8 首次集成检查 756/756 通过；记录在 [集成 JSON](../evals/results/2026-10-23-g8-integration-final.json)。这不等于浏览器或语言质量通过。首次云模型浏览器对应 [105 文件源码快照](../evals/baselines/g8-first/source-manifest.json)，运行结束核验漂移为零。

第一次局部修复后 [全量自动化 764/764](../evals/results/2026-10-23-g8-postfix-tests.json) 通过，typecheck、构建通过；其中服务端 PG 31 项、独立 API 10 项、前端状态 14 项。构建 JS 735.41 kB / gzip 214.55 kB，仍有单包大于 500 kB 提示。第二轮浏览器对应 [105 文件快照](../evals/baselines/g8-postfix/source-manifest.json)，运行结束核验漂移为零。该清单包含源码、测试、配置和生成的 HTML/CSS，不包含密钥。

## 云模型浏览器首测：1/3

[首测 JSON](../evals/results/2026-10-23-g8-browser-first.json)：1 通过、2 失败、0 跳过、0 flaky；耗时 83.63 秒，Playwright retry=0。首测源码、失败截图和 trace 保存在 `docs/evidence/phase8-browser-first/`；成功的 [澄清历史响应](../evals/results/2026-10-23-g8-browser-first-histories.json)独立保存。

1. **丢失已接收响应、规划中刷新、同账号重新登录：失败。** POST 已提交后模拟丢失响应，刷新确实恢复了唯一原消息；原 command 也完成。但语义模型在 `tasks[0].scope` 出现 `SEMANTIC_SPAN_NOT_FOUND`，无转账草稿，因此该完整流程失败，后续重新登录断言尚未到达。不是恢复机制丢失消息，也不能把失败改记为全链通过。[当次 command 与模型诊断](../evals/results/2026-10-23-g8-first-response-loss-command.json)保留。
2. **同名收款人澄清后刷新续接：通过。** 原请求“给张伟转账300元”保存；刷新后明确选择尾号 3361，生成 revision 1，保留 30,000 分及原字段来源，原澄清变为 resolved，得到待确认草稿；没有重新调用语义模型猜测原金额。首测截图拍摄时 UI 尚处在下一次轮询之前，截图只证明当时状态；后续测试增加等待确认卡可见后再截图，不用该首测截图证明 UI 已完成更新。
3. **切换另一个账号：失败。** 点击退出后立即导航，可能中止 signOut 请求/清 cookie 响应；新页面恢复了旧 cookie，邮箱输入无法出现而超时。已增加独立退出中/退出失败状态及刷新优先退出的标记；首测失败保留，修复后重测单独记录。

另有独立合成检查发现同一收款人的姓名与别名重复出现时，两次转账可能被误合为一个缺金额请求。首测结束后增加重复同域请求检查和正/负测试；目标包含自身未来转账仍作为单一目标，不计为第二次目标。

## 局部修复后复测

[第二轮 JSON](../evals/results/2026-10-23-g8-browser-postfix.json)：2 通过、4 失败、0 跳过、0 flaky；137.45 秒，retry=0，包含 3 条 G8 与 3 条既有 G7 浏览器流程。失败截图、trace 和成功截图保存在 `docs/evidence/phase8-browser-postfix/`；[结构化响应](../evals/results/2026-10-23-g8-browser-postfix-responses.json)单独保存。

| 流程 | 第二轮结果 | 实际证据 |
|---|---|---|
| 已接收响应丢失、刷新、重新登录 | 失败 | 原消息和 command 恢复；`tasks[0].scope` 引用失败，无草稿，重新登录断言未到达 |
| 同名收款人刷新后补尾号 | 通过 | revision 1、原金额 30000 分、待确认卡可见；移动截图本次等待卡片显示后拍摄 |
| 退出并切换账号 | 失败 | UI 已保持空态与退出未确认提示，但网络 trace 证实 sign-out 返回 415；不能称退出已经完成 |
| 自然语言转账草稿 | 失败 | `SEMANTIC_SPAN_NOT_FOUND`，无草稿 |
| 资金查询 | 失败 | `SEMANTIC_SPAN_NOT_FOUND`，未产生要求的资金答复 |
| 赎回待强验证草稿 | 通过 | 金额与领域传递一致，仅生成待授权草稿 |

第二轮尚未改变 G7 语义代码；原文引用失败与此前同类错误一致，但只保存了诊断、摘要和输出 digest，没有原始模型字段，不能推测具体字符改写原因。结构 JSON 成功也不等于原文语义有效。

### 退出 HTTP 契约修复后的定点复测

客户端 `api.signOut` 原来只有 POST、没有 JSON body，通用 request 因而不附 JSON Content-Type，Better Auth 实际返回 415。现明确发送 `{}`，并保留退出中标记与空态屏障。新增直接调用实际 api 方法的 fetch 契约测试，旧实现会触发 mock 415；前端检查增至 15/15，typecheck 通过。

[真实浏览器定点复测](../evals/results/2026-10-23-g8-signout-fix-browser.json) 1/1 通过，3.18 秒，retry=0：点击退出后立即导航、登录另一个账号、无旧消息、旧 conversation ID 返回 404。该测试不调用云模型。这证明 HTTP 修复和生命周期恢复在该流程生效，不替代其他模型失败项。

### 扩展 API 与真实进程终止

独立 API 套件从 10 增至 13 项，[13/13 通过](../evals/results/2026-10-23-g8-recovery-api-extended.json)。新增检查在 planner 屏障期间并发重发相同 client ID 和读取历史，仍只有一个 command、一次规划和一条最终消息；新话题生成新 root，不继承待澄清请求中的金额/收款人；消息事务提交前的 PG trigger 故障不留下消息或 command，同一编号重试只保存一次。

`tests/conversations-process-recovery.integration.test.ts` 使用真实 Node 子进程、动态 HTTP 端口、实际 createApp/runner/Core 与唯一 PG schema，目标测试 1/1 通过。仅测试 helper 包装 Core 返回点：真实草稿事务提交后停在 IPC 屏障，父进程确认 proposal 已冻结、result 为空，再发 SIGKILL，验证进程退出信号。

新 PID 启动后，GET 历史不触发规划；显式重试原 command 复用 proposal，恢复进程的 planner 调用为 0。Core 接收同一稳定命令两次，但只有一个草稿、一次 ACTION_PREPARED 和一条最终消息；原 client/message/root/revision、金额、备注与 action hash 保持一致。authorization proof、outbox、provider transfer/entries 为 0，双方账户余额未变。测试清理自身子进程、连接池与 schema。

为缩短测试，只将隔离 schema 中该 command 的 updated_at 老化五分钟，模拟生产四分钟租约到期；这不是实际等待四分钟。认证使用测试 session，planner 使用确定性替身，不把这项证据称为真实认证/云模型测试或数据库断电测试。

## 原文引用修复的独立审查记录

原实现只把 JSON schema 失败交给 provider 的有限重新生成；语义 source 校验在调用返回后才运行。模型可能得到一次“结构调用 success”，但完整计划仍因原文不匹配停止。首个补丁将严格限定的单一转账/无字段资金查询 scope 复制失败放入运行时 Zod refinement，沿用现有 maxAttempts、一次结构重生成和总请求预算，不修改 provider 或确定性完整校验。

该初版 [793/793 自动化](../evals/results/2026-10-23-g8-source-repair-tests.json) 通过之后，独立复核追加了一条业务语义漂移测试：第一次为缺 scope 的合法转账，第二次变成资金查询。原补丁接受第二种操作，故 [独立首测 7/8](../evals/results/2026-10-23-g8-source-drift-independent-first.json) 未通过。这是新增案例揭示的缺陷，不能用此前全量通过将其忽略。浏览器复测因此推迟，先绑定重新生成前已核对的业务字段，再统一验收。

## 全句原文引用与别名指令遮蔽修复

模型复制中文标点会改变码位，导致基于复制文本的 source span 找不到原句。现在单任务可以明确输出严格的 `{ "source": "whole_message" }` 标记，服务端只从原始 `input.message` 构造完整 UTF-16 范围，不归一化标点、不补缺失来源；多任务使用该标记会直接拒绝。既有有界 scope 重试仍校验所有非 scope 字段不漂移，金额、对象、日期、备注、否定、引用和额外操作检查继续针对原始消息执行。契约见 [semantic-intent-contract.md](semantic-intent-contract.md)。

独立盲审发现，若只把已 grounding 的对象名从整句额外业务检查中遮掉，带命令内容的已保存别名也会一起被遮掉。现在遮蔽之前会拒绝命令式对象提及，覆盖转账、账单查询、投资买卖/赎回、卡片挂失/报失/注销/补办、订阅取消/拦截/启用，以及目标创建等对应 resolver 动词；连接词需要后接动作才触发，普通名称“并蒂莲”和产品名“晨星储蓄计划”保留正向通过。六个语义测试文件 **206/206**、独立复核 **136/136** 通过；实现方针对别名的修复前红测曾复现多个错误 `ready`，修复后均澄清且不生成任务。完整回归为 [862/862](../evals/results/2026-10-23-g8-whole-source-acceptance-tests.json)。

## 历史 G8 完整源码浏览器验收：1/6

最新运行使用真实配置云模型，`retry=0`，耗时 101.15 秒。对应的 [111 文件源码快照](../evals/baselines/g8-whole-source-acceptance/source-manifest.json)在测试结束后核验 **0 漂移**。完整 [Playwright JSON](../evals/results/2026-10-23-g8-whole-source-browser.json)、[结构化响应摘录](../evals/results/2026-10-23-g8-whole-source-browser-responses.json)和[失败截图/trace](evidence/phase8-whole-source-browser/evidence-manifest.json)分开保存。

| 流程 | 结果 | 证据与边界 |
|---|---|---|
| 已接收响应丢失后刷新、恢复同一请求 | 失败（上游模型复核调用） | 原消息和 command 已恢复，语义意图与转账领域提案成功；独立 reviewer 两次分别返回 HTTP 520/521，最终无动作草稿，因此后续重登录断言未到达。不能算完整链通过。 |
| 收款人澄清刷新后续接 | 失败（上游模型调用） | 原始澄清路径可继续，但恢复后的 transfer/reviewer 请求均返回 HTTP 521，没有最终草稿。 |
| 切换另一账号并验证旧会话隔离 | 通过 | 新账号为空态，旧 conversation ID 返回 404。 |
| 口语转账草稿 | 失败（上游模型调用） | semantic_intent 两次请求均返回 HTTP 521；没有脚本降级或动作提案。 |
| 受保护资金查询 | 失败（上游模型调用） | semantic_intent 两次请求均返回 HTTP 521；未产生答复。 |
| 理财赎回待强验证草稿 | 失败（上游模型调用） | semantic_intent 两次请求均返回 HTTP 521；没有赎回提案。 |

对 `https://ai.anna.tf/v1/models` 的无凭据连通性探测返回 HTTP 401；这只说明路由要求凭据，不验证 API Key，也不能证明模型服务健康。此次五项失败的记录是认证请求阶段 HTTP 520/521；完整浏览器验收因此受云端依赖阻塞，自动化与源码级语义安全验证仍为独立通过证据。未对这些用例进行重试或改写标签。

后续在 2026-10-23 06:26 UTC 使用现有配置执行了一次结构化模型连通性检查，8.123 秒内成功返回 schema 要求的 `ready`，见 [原始检查记录](../evals/results/2026-10-23T06-26-37-019Z-g8b-model-connectivity-probe.json)。随后 G8B 的完整 24 例 G7 已知回归严格通过 **16/24**（两组各 8/12），结果见 [完整记录](../evals/results/2026-10-23T06-33-43-689Z-g7-semantic-live-all-production.json)。这些是规划与模型调用证据，不改写上述历史浏览器结果。

## 后续版本索引（2026-10-23）

G8C v1 已知 24 例为 **19/24**；该分数对应 v1 冻结源码。v1 六流程浏览器 **5/6**，理财赎回因内置产品名误判失败。G8C v2 的自动化为 **1091/1091（47 文件）**，typecheck/build 通过、131 文件源码冻结；六流程浏览器为 **5/6**，赎回通过，示例转账因误判失败。v2 未重新执行全 24 例。版本分析和原始记录见 [G8C 阶段报告](g8c-semantic-completion.md)。

当前 G8D 自动化为 **1218/1218（50 文件）**，typecheck/build 通过，135 文件源码冻结于 [manifest](../evals/baselines/g8d-semantic-2026-10-23T08-38-10-627Z/source-manifest.json)。冻结版本真实 24 例已知回归严格通过 **19/24**，两组分别为 pilot-known **9/12**、reserved-known **10/12**。失败为 g703、g710、g711、g712、g722；G8C v1 的旧失败 g704、g705、g706、g707、g714 本轮均通过，同时五个此前通过样例转为失败，净分数持平。62 次尝试有 62 个开始和 62 个结束：53 成功、9 个 HTTP 502，重试 5 次（其中 1 次成功、4 次失败），请求 cap 全部记录有效；尝试上限总和 315,392 tokens（cap 不是实耗）。成功调用的 input usage 报告为 0，9 个失败调用没有 input/output usage；缺失或报告为 0 均不能证明零费用。`modelComplete=19/24` 是预期模型阶段完成口径，不是业务成功率或真实银行动作完成率；本评测只生成规划提案。独立重算了 24 个输入/标签摘要、135 项冻结哈希和 25 个运行跟踪哈希，均与冻结文件一致，详见[审计数据](../evals/results/2026-10-23-g8d-live-audit.json)；最新阶段索引见 [G8D 可靠性报告](g8d-semantic-reliability.md)。

### G8D 六条浏览器流程：6/6 UI 断言

[原始 Playwright JSON](../evals/results/2026-10-23-g8d-browser-six.json)记录 6 个既有流程全部通过，耗时 302720.39 ms，0 skipped/unexpected/flaky，6 项均 retry=0。响应摘录中有 8 个 JSON 附件、7 个唯一 PlanResult；递归规范化对象键顺序后，重复结果的两组对照均完全一致，`conflictingTaskIds=[]`。18 条返回的 ModelRun 中 15 成功、3 失败：response-loss 转账复核首尝试 `MODEL_SCHEMA_INVALID`、第二次成功；资金只读查询 reviewer 两次 `MODEL_HTTP_502`，但确定性余额/受保护/可用金额事实展示正确、`effectiveApproved=false`、没有动作。冻结 135 文件及其快照副本均零漂移。独立核对详情见[浏览器审计 JSON](evidence/2026-10-23-g8d-browser-audit.json)和[证据清单](evidence/g8d-browser-six-2026-10-23/evidence-manifest.json)。这六条流程覆盖当前转账、会话恢复、资金只读、赎回待强验证草稿等 UI 断言，不是六领域完整执行验收，也不代表 18 次模型调用均成功；ModelRun 是应用返回的摘要，不是独立持久化 provider-attempt journal。

同一 G8D 快照下，[受控 API/PG 模型失败重试探针](evidence/2026-10-23-g8d-model-failure-retry-probe.json)实际注入两次模型 HTTP 502：命令仍落库为 `complete`/`retryable=false`，之后即使端点可用，对同一命令发 retry 仍返回完成且模型调用数不变（2→2）。该证据复现模型失败被包装成正常计划完成、因而无法显式重试的缺口；它不是修复、真实云端故障或浏览器认证验收。无动作发生，余额与预留均不变。

另有独立的 G8D [理财/目标直接执行专项 1/1](../evals/results/2026-10-23-g8d-direct-investment-goal-browser-run.json)：T+2 未到账不计现金；T+0 强验证赎回到账后，目标局部改金额保留已完成赎回与回执，再单独确认转账。该专项使用真实本地 API/PG/Worker 与 Chromium 虚拟验证器签名，不调用模型，合成余额为 8000→9000→8399.25 元。它和上述六条云模型页面流程分别记录；不代表 T+2 到期结算、真人硬件验证或全部跨域组合已通过。详细证据见 [专项清单](evidence/g8d-direct-investment-goal-2026-10-23/evidence-manifest.json)。

## 当前未验收范围

- typed 补充需要同次补齐当前所有缺失字段；不是任意聊天历史推断或任意多轮修改。多域、赎回依赖、重复动作或未支持语法仍要求完整重述。
- 消息已分页，但 commands/clarifications 仍完整返回；大型长会话的性能与保留策略未验收。
- 本轮故障检查包含逻辑重建、租约接管、数据库触发器拒绝、已提交 HTTP 响应丢失，以及真实 SIGKILL/新进程显式恢复；数据库连接中断/断电仍未验收，不把这些注入混为同一种恢复证据。
- 本轮 G8B 恢复专项共 40/40：包含 fencing/迁移、冻结输入、新 Pool 恢复、原消息 replay 与显式 retry、两个真实提交前 SIGKILL 事务窗口、reviewer 与并行领域中断后新 API 恢复，以及真实 SIGTERM/SIGINT 排空。成功分支输出在精确 checkpoint 上确认持久化后才杀进程；恢复未重跑该分支。生产 graph 使用同步 durability，PostgresSaver 格式版本已纳入 graph version，主程序恢复默认关闭。数据库断连、提交响应未知、图内澄清 interrupt 和物理数据库故障仍未验收。
- 全部银行动作是合成沙箱。上述六条云模型浏览器流程只生成待确认草稿，不授权或执行资金；另列的理财/目标直接专项执行了沙箱动作。模型质量、只读事实、授权和执行分别报告。
