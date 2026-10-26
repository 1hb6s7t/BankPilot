# G9J：输出模式兼容性与账单拒绝提示

2026-10-25。本轮限定修复与诊断已完成，未发布；上轮G9I完成工程修复、正式48例及独立对照，属于有实质进展。整体目标仍未完成。

## 范围与分工

本轮只推进两个已由证据确认的缺口：当前服务的结构化输出稳定性，以及普通用户看到技术诊断码的账单拒绝提示。Provider Agent负责已有tools/json_object模式的固定有界对照；UI Agent修复用户展示路径；语义Agent独立复核信息隐藏及诊断判据；主Agent负责审查、真实调用、隔离数据库与浏览器验收。沿用GPT-6-sol/high处理协议工具、GPT-6.1-sol/high处理界面/跨层展示、GPT-6.1-sol/xhigh独立审查；开发Agent分工不改变产品模型配置。

## 模型对照边界

历史Phase2曾在旧服务上运行tools模式，也出现过结构错误；不能将当时结果外推当前apiw.pro。当前公开页面无法由网页工具读取，检索未返回官方参数说明；不据此宣称服务不支持某模式。仅使用生产适配器已有的两种模式，不引入未经核验的参数，不更改.env，不自动降级。

诊断拟使用同一合成卡片只读任务及同一合成账单任务、生产实际schema和validator；每任务每模式2次、总计最多8次，maxAttempts=1、repair=0、4096输出cap、temperature=0、60秒。脚本先离线审查后显式live。按真实生产语义接受合法request/query表达，不重复G9I诊断过严的条件；精确记录schema和业务事实判据。该诊断不替代六域业务验收、新样本或稳定性验证。

## 初始状态

[原库只读快照](evidence/2026-10-25-g9j-runtime-before.json)确认相对G9I收尾，49表及97命令保持。历史报告和冻结副本不改；本轮新的源码变动独立记录，不能继续把G9I冻结摘要称为当前源码。


## 模型模式诊断实际结果

[离线校准独审](evidence/2026-10-25-g9j-diagnostic-calibration-review.json)在任何live之前发现并修正诊断额外要求账单引用全集的误判，生产本来允许合法非空子集且保留完整事实。语义判据同样以生产解析后的对象及原文为准，不额外要求query标签或完整卡名mention；固定输入在live前加入尾号以覆盖合法另一种定位。原红证保留；产品schema和历史评分均未改。根代理[最终4项纯测](evidence/2026-10-25-g9j-diagnostic-root-final-pure.log)通过。

[唯一8槽live结果](evidence/g9j-tools-json-live-2026-10-25T07-22-43-975Z-0ae6cc41-69e1-42f4-a5e3-154ac6716943/final.json)：

| 任务 / 模式 | 通过 | 报告输入token合计 | 报告输出token合计 | 两次总耗时ms |
| --- | --- | --- | --- | --- |
| semantic / tools | 2/2 | 9224 | 1130 | 15737 |
| semantic / json_object | 2/2 | 8148 | 907 | 9559 |
| bills / tools | 2/2 | 3173 | 732 | 8513 |
| bills / json_object | 2/2 | 2650 | 760 | 9067 |

8次HTTP200，8组attempt/request/output闭合，sourceStable=true；总输入23195、输出3529 token。根代理重新计算五个输出文件摘要均匹配final。当前两个只读合成任务下两模式均可用，未显示稳定质量优势；每条件仅2次，不能据此推断六域可靠性、性能或货币成本。保留.env中的json_object，不自动切换或追加重跑；这8次成功不覆盖G9I正式48例失败，未作为新业务验收成绩。

## 用户展示修复

技术码来自conversations.onComplete将findings原样拼入assistant text，以及history原样恢复；新增纯展示helper统一处理新写入与历史读取。历史投影只使用已有同owner/conversation/command、complete结果批量查询，不增加逐消息查询，不写回原消息/结果；用户原文及非结果消息保持。缺失、坏或绑定不符的账单结果显示中性说明。

仅明确billAnswerReview.status=withheld的返回结果使用固定摘要、澄清及事件说明，隐藏旧自由账单附件/证据，避免旧其他领域自由文案再次带出未核对事实；保留typed actions/status、fundsPreview与机器findings/diagnostics。审计字段保留不等于对所有API字段进行去敏；本轮验证的是普通用户展示路径。普通非withheld结果不改变语义，未知concern不展示原始payload，真实业务提示及用户原文中的技术字样保留。固定中文说明要求完整重述查询，避免误导用户用简短字段续接。

本轮没有修改planner/provider/语义规则、资金授权或执行状态，因此不人为提升graph/semantic版本；验证新的展示逻辑及恢复读取即可。


## 全仓与独立复核

[首轮全仓日志](evidence/2026-10-25-g9j-isolated-full-check.log)3409通过/1失败，失败发生在根代理新跨聊天夹具设置阶段：两条final响应碰到user/command/response_key唯一约束，尚未进入读取断言。保留失败记录，修为唯一的合成response_key，并让另一聊天使用普通非withheld私有canary，防止投影本身掩盖串结果问题；没有修改数据库约束或产品逻辑。

[最终全仓日志](evidence/2026-10-25-g9j-isolated-full-check-final.log)132文件、3410/3410通过，类型检查与构建通过。包含34项新展示纯测及4项真实DB集成，后者验证新文本持久化、旧消息/结果不写回、跨聊天不借结果、用户原文与分页保留。两次随机测试库均已验证删除、进程组消失。主JS仍787.35kB/gzip228.86kB，500kB提醒未处理，不称性能优化。

[展示独审](evidence/2026-10-25-g9j-conversation-presentation-independent-review.json)独立34纯测及21纯探针通过；根代理负责实际DB与浏览器。[模型证据复核](evidence/2026-10-25-g9j-tools-json-live-independent-review.json)核齐全部8槽、原始可见输出、生产校验及usage；由协议作者只读复算、根代理独立核对摘要与逐槽结果，不称盲审。


## 浏览器及收尾

[受控浏览器报告](evidence/g9g-isolated-test-2026-10-25T07-29-19-711Z-cc608414-a289-40cc-aebd-6035673b7263/browser/report.json)13/13、0跳过/失败/flaky，11项UI流程和2项guard，66.389秒；原库之外的随机数据库已删除、进程组消失。[根代理实际看图](evidence/2026-10-25-g9j-browser-root-visual-review.json)复核重登后的中文拒绝原因/完整重述指引，以及后续卡片查询已完成、名称/尾号/状态/版本显示，旧账单拒绝历史未重新显示隐藏流水。冷刷新/重登适用；没有改变前端同ID消息的不可变合并协议，不宣称未刷新的旧页面会被即时改写。

[原库收尾快照](evidence/2026-10-25-g9j-runtime-final.json)49表和97命令摘要与初始一致；[端口记录](evidence/2026-10-25-g9j-final-ports.json)5178/8787未监听。当前是经本地验证的候选，未将受控环境发布为在线演示。

[源码摘要](evidence/2026-10-25-g9j-source-snapshot.json)记录本次验证的当前源码和相对G9I的五个文件变更；这是验证快照，不是新业务评测manifest或发布。[收尾扫描](evidence/2026-10-25-g9j-final-integrity.json)核对旧冻结副本、当前凭据输出、环境权限和三次隔离测试清理。

## 当前判断与下一步

账单拒绝展示缺口已关闭，工具调用兼容性已有当前实际响应证据。两模式没有显示足以支持切换的质量差异，继续json_object，保留指定供应商/模型。G9I的已知1/36、补充5/12仍是最近完整业务质量结果，未被本轮8槽诊断替代。下一阶段应在固定当前版本和预算下登记完整质量复验，验证关键多轮恢复，再开展真正未见首测、容量及新交付包/接收方验收；整体目标保持active，不能认定已达到理想状态。
