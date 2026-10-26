**BankPilot：前端、评测与基础开发组件复用核验**

调研日期：2026-10-22（Asia/Shanghai）。本文件由主 Agent 完成，证据包括官方文档、固定 commit 的源码、GitHub REST 元数据和近期合并 PR。当前只完成资料与静态源码核验，未运行依赖兼容性或业务 PoC。

**候选与维护证据**

| 项目 | 许可证与来源 | 本次版本/活动快照 | 维护判断与复用结论 |
|---|---|---|---|
| assistant-ui | [根 LICENSE](https://github.com/assistant-ui/assistant-ui/blob/413b430b06979a861d1a7ce67c34ab47b900c0f7/LICENSE)、所读 package.json 均 MIT | React 包 0.15.30；发布于北京时间 10/20；固定源码 413b430；10/22 合并 [#10010](https://github.com/assistant-ui/assistant-ui/pull/10010) 修正 LangChain 文本数组 | 有官方文档、贡献指南、安全策略、近期功能修复。聊天基础组件直接复用；业务事件适配与交易卡片需适配。不能把仓库 latest release 的 generative-ui 子包版本当 React 主包版本 |
| React Flow / xyflow | [根 LICENSE](https://github.com/xyflow/xyflow/blob/017a41c69998bc8f16d2a3e6c3ca0084f320a24f/LICENSE) MIT | @xyflow/react 12.12.0，9/24；源码 017a41c；10/21 合并 [#6054](https://github.com/xyflow/xyflow/pull/6054) 修复卸载时 ResizeObserver 释放 | 活跃、有完整节点/边/可访问性文档。图形渲染直接复用；BankPilot 节点与状态映射需适配。Pro 示例与付费支持不等于开源库必需依赖 |
| Promptfoo | [固定源码 LICENSE](https://github.com/promptfoo/promptfoo/blob/03844fb957487102bd21f7434a229915cee90e02/LICENSE) MIT；云/企业服务单独考虑 | CLI 0.124.1，10/8；10/22 最新样本 [#11914](https://github.com/promptfoo/promptfoo/pull/11914) 为依赖更新；release 另含多个断言修复 | 有持续发行、测试和官方 provider/断言接口。测试执行器直接复用；BankPilot provider 与数据库断言需适配。近期 3 个 PR 恰为依赖机器人，不可据此推断人工响应速度 |
| Sierra tau2-bench | [固定源码 LICENSE](https://github.com/sierra-research/tau2-bench/blob/05736c27219b769d0be507574dd3135010916644/LICENSE) MIT | [v2.0.0](https://github.com/sierra-research/tau2-bench/releases/tag/v2.0.0)，10/20；10/22 北京时间仍有合并，源码 05736c2 | 官方研究组织维护，近期活动成立。借用任务环境与终态评分方法，属于适配；不能把旧 1.0.1 或早期 τ² 任务集当当前版本，不直接等同本赛题 |

原始 repo/commit/release/pulls JSON 保存在 evidence/。四个仓库在本次 REST 快照中均 archived=false；API 后续达到公共限流，补充核验改用官方发布页和固定 SHA 的 raw 源码。没有通过绕过鉴权获取私有内容。

**接入方案：聊天与业务卡片**

使用 `@assistant-ui/react` 负责消息列表、输入框、滚动、流式消息和工具结果插槽。其[官方运行时说明](https://www.assistant-ui.com/docs/runtimes/concepts/architecture)提供不同后端接入方式；本项目为自建 Hono 服务，优先通过 `useExternalStoreRuntime` 映射服务端会话与业务事件，避免为 UI 另起一套 Agent 服务。官方 [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store) 允许自有消息状态和回调。

实现一个薄 `BankPilotChatAdapter`：接收服务端 `message.delta`、`agent.started`、`proposal.ready`、`action.awaiting_authorization`、`receipt.updated` 等事件，转换为消息和独立业务卡片；历史记录与重连以服务端快照为准。协议事件名称是本报告的设计建议，不是该库既有 API。

交易卡片从服务端 `PreparedAction` 取收款人、金额、费用、动作版本、有效期与风险等级。用户确认通过经过身份验证的业务端点提交动作 ID；页面自己生成的 `approved=true` 不能产生有效交易授权。旧的官方股票审批教程只可参考组件交互，不能直接复制其审批语义。

源码定位已核验：`packages/react/package.json`、`packages/react-langgraph/package.json`、`packages/react-langchain/package.json`。后两者依赖 LangGraph SDK（当前读到 ^1.9.20），不能假定任何自建 Hono SSE 都兼容它们。主包支持 React 18/19，项目必须锁定统一 React 版本并验证构建。

接入验证：中文长消息、工具结果、授权过期、取消后重连、跨页面返回、事件乱序/重复、两个浏览器标签页的同一动作确认。聊天的编辑/重新生成应只影响展示或创建新命令，不得隐式重放既有支付。

**接入方案：计划与资金可视化**

使用 `@xyflow/react` 绘制依赖节点及边；[自定义节点](https://reactflow.dev/learn/customization/custom-nodes)承载待查询、待确认、执行中、待查单、完成等状态。默认只读，节点连接来源为服务端计划，拖动只改变布局，不改变执行依赖。资金时间表用普通 React 表格/图表呈现已结算金额、占额、预期到账与支出，金融计算独立在服务端实现。

可复用的是渲染、缩放、选中、可访问性基础设施；计划版本差异、证据查看、资金缺口与授权联动需要自行适配。[官方 Pro 页面](https://reactflow.dev/pro)明确核心库保留 MIT，首版无需购买高级模板即可实现基础计划图。

**接入方案：评测**

Promptfoo 通过[自定义 JavaScript Provider](https://www.promptfoo.dev/docs/providers/custom-api/)调用一个隔离的 BankPilot 测试 API。每条样例独立创建 fixture、固定时钟与主体，执行多轮对话/测试授权，等待任务进入终态或规定等待态，再返回 `taskId`、动作、授权事件、回执与账本快照。不要只把一句最终回答作为评测输入。

使用[JavaScript 断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)检查账户余额、双边记账、日累计、授权存在性、回执关联、重试扣款次数、过期提案是否被拒收。评分查询凭据只存在隔离测试端，模型不应获得数据库管理员权限。LLM judge 可用于表达质量、遗漏目标，不能取代资金和权限断言。

状态型端到端评测必须关闭输出缓存或使用隔离唯一运行身份，避免缓存文字掩盖未执行的业务步骤。测试层分工：Vitest 验证确定性规则与状态机，Playwright 验证用户确认和中断恢复，Promptfoo 比较模型与多 Agent 架构。工具本体直接复用，具体案例和业务断言自建。

当前 Promptfoo 固定源码 package.json 声明 Node >=22.22.0；CI 需要满足这一要求，且运行工具可以放在独立评测环境。不能直接套用旧教程的 Node 18 要求。[源码](https://github.com/promptfoo/promptfoo/blob/03844fb957487102bd21f7434a229915cee90e02/package.json)

Sierra 源码已核对 `src/tau2/domains/banking_knowledge/environment.py` 与 `src/tau2/evaluator/evaluator_env.py`：它有可变业务环境和终态评测接口，适合借鉴结构。建议将方法与少量合适任务适配成中文人民币 fixtures，保留出处与版本，单独报告 BankPilot 分数。首版不把完整 Python 评测服务作为在线银行执行依赖。[环境源码](https://github.com/sierra-research/tau2-bench/blob/05736c27219b769d0be507574dd3135010916644/src/tau2/domains/banking_knowledge/environment.py)、[终态评分源码](https://github.com/sierra-research/tau2-bench/blob/05736c27219b769d0be507574dd3135010916644/src/tau2/evaluator/evaluator_env.py)

**基础依赖的筛选深度**

[Hono](https://github.com/honojs/hono)、[Zod](https://github.com/colinhacks/zod)、[Vitest](https://github.com/vitest-dev/vitest)与[Playwright](https://github.com/microsoft/playwright)均核对官方仓库的用途与许可标识；前三项 MIT，Playwright Apache-2.0。此次没有像核心选型候选一样逐项完成其 issue 响应样本审计，不能给它们虚构维护评分。它们分别承担 HTTP、结构校验、单元/集成测试和浏览器验证，均采用依赖包方式复用。Zod 校验形状，不代表金额、权限和业务事实已正确。

**本轮边界**

没有安装并运行这些库，也没有执行模型成本基准。本轮结论是“具备可复用依据，值得按优先级验证”；依赖锁定、许可证清单、兼容性与故障 PoC 完成后才能进入正式开发基线。已读取的固定 SHA 是证据锚点，不等于推荐直接依赖未发布 main。
