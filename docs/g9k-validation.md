# G9K：同版业务质量复验与真实订阅续办

2026-10-25。当前状态：本轮316文件冻结、两组正式业务复验与一次真实订阅浏览器验收已完成。质量未通过，订阅链路通过；尚未发布或完成整体目标。

## 范围与并行分工

沿用已授权的多Agent开发协作。Provider Agent（GPT-6-sol/high）复用G9H/G9I执行内核增加G9K入口与结果审计；流程Agent（GPT-6.1-sol/high）补强既有订阅测试的原请求、动作身份与UI终态断言；独立审查Agent（GPT-6.1-sol/xhigh）检查冻结、证据门禁和环境隔离。主Agent负责整合、最终反例校验、真实调用和隔离浏览器。按跨层风险分配审查强度，避免多个Agent同时修改同一冻结文件或操作数据库。这是开发分工，产品仍使用指定云模型。

本轮69个apps/packages产品文件与G9J快照完全相同；未改Planner、schema、prompt、输出模式或预算。G9J展示修复不应被解释为Planner质量提升的原因。本轮不同时间的服务复验只有一次，输入已暴露，不是盲测。

## 冻结与准备证据

- [正式manifest](../evals/g9k-manifest.json)：SHA256 `d26da69d9576e3a5d3c7097a75e06acd2df9ab7be5aebdf5c572eeb3642158c3`。
- [316文件源码清单](../evals/baselines/g9k-candidate-2026-10-25T07-53-07-252Z/source-manifest.json)：绑定G9I父manifest和G9J快照，产品69文件零变化。
- [预检及篡改反例](evidence/2026-10-25-g9k-preflight-audit.json)：全部冻结副本匹配；模型、输出模式、服务地址指纹三种篡改均拒绝；本地.env保持。
- [独立审查](evidence/2026-10-25-g9k-runner-independent-review.json)：最终6文件40/40纯测通过；[根代理定向测试](evidence/2026-10-25-g9k-focused-tests.log)同样40/40，[类型检查](evidence/2026-10-25-g9k-typecheck.log)通过。未重复上一阶段3410项全仓测试，本轮不将历史全仓结果标成新跑。
- [业务复验预登记](g9k-validation-protocol.md)固定known36→quality12、三套评分、原预算及每组唯一首跑标记；[多轮预登记](g9k-recovery-protocol.md)固定一次既有订阅场景，独立于质量分母。

## 正式结果

[known36原报告](../evals/results/g9k/default-known-2026-10-25T07-53-43-790Z-66cede48-63a7-4b34-a3c1-e5a7eb910430/report.json)、[quality12原报告](../evals/results/g9k/default-quality-2026-10-25T08-03-46-896Z-4e32dbc0-4779-4862-9e78-0f1178f1a862/report.json)均按顺序仅运行一次，分别用时563.554秒和222.244秒。两组validRun=true；[独立结果审计](evidence/2026-10-25-g9k-final-independent-audit.json)重新核对三套评分、attempt/request/semantic/bill、首跑标记、前置报告和源码绑定，overallEvidenceValid=true、issues为空。

| 组别 | 原G9通过 | 历史G9E通过 | 当前G9G通过 | 当前业务可评 | 不可评 |
| --- | --- | --- | --- | --- | --- |
| 已知36 | 15/36 | 16/36 | 16/36 | 16 | 20 |
| 开发知情补充12 | 9/12 | 9/12 | 9/12 | 9 | 3 |

已知组各域当前通过数为转账2/6、账单3/6、理财2/6、卡片2/6、订阅4/6、目标3/6；补充组依次为0/2、2/2、2/2、1/2、2/2、2/2。原G9与后两口径差异仅来自goal06的历史评分契约，三份分数并列保存，没有改判旧报告。当前25个可评案例全部通过不等于48例通过；23例不可评仍在原始分母内，质量门槛未达到。

两组分别70和31次请求/attempt，全部起止闭合；100次HTTP200，另1次timeout没有HTTP状态。请求schemaMissing=0，结构修复feedback各2次且body/system摘要变化；所有请求输出预留预算在每例32768内。已报告输入token分别145784/70317、输出51656/24745，reasoning44159/20247属于报告字段，不能另加成输出总量。分别21和3次缺usage，因此完整token总量及计费成本未知。

23例最终错误都是`MODEL_RESPONSE_JSON_INVALID`。已知组attempt还出现2次截断和1次超时；补充组还有2次schema失败，属于案例内原有预算允许的尝试，不是补跑。源码`provider.ts`此错误既覆盖`response.json()`解析异常，也覆盖解析后为null、数组或非对象；必须表述为**外层响应JSON解析或对象格式无效**，不能仅凭错误码断言语法失败。对应错误attempt都记录HTTP200；语义sidecar记录not_text，其他角色没有结构sidecar。原始HTTP响应体未保留，无法确定空内容、截断、网关页面或其他具体原因；也不等于模型语义提案违反JSON schema。审计文件中“外层解析失败”的简写按此更精确边界解释。

保留失败及不可评原始分母，不因结果不理想补跑、切换模式或改判。完整且有效的记录只能证明证据闭合，不能替代业务通过；本轮比G9I分数高不能归因于G9J展示修复，服务时点与随机性没有受控。

## 真实订阅浏览器

两组记录完整且独审有效、源码与.env再次核对后，串行运行唯一一次 `pnpm test:isolated --browser-live-subscription`。该显式入口复用原隔离测试框架；默认与受控测试不触发云模型。[实际报告](evidence/g9g-isolated-test-2026-10-25T08-08-50-019Z-2c83a83a-fda6-4cab-99f5-b328a87660bb/browser/report.json)1/1通过，0失败/跳过/flaky/重试，测试33.451秒、suite35.430秒。实际3次HTTP200（semantic/subscription/reviewer），0受控调用，不把测试耗时称为纯模型延迟。

一次既有输入覆盖查询授权前不派发模型、原消息接续、父/根/版本、原query/cancel/block三个动作、两项独立确认、proof/actionHash绑定、刷新重登、真实UI回执及数据库业务状态。查询授权不等于取消或拦截授权；先取消云音乐时银行拦截仍待确认，之后再确认城市健身银行拦截；本地商户取消与银行侧拦截的状态/后果不同，余额8000保持，无新增转账或总账分录。测试使用随机独立库和合成银行/商户。

[订阅独立附件审查](evidence/2026-10-25-g9k-subscription-independent-review.json)核对实际保存附件与trace：原user_message_id匹配202接受的唯一用户消息，source r0与child r1同root/原文；三个confirm POST各一次，原动作/proof/actionHash绑定，取消后拦截仍待确认。3个持久attempt起止完整，各云调用时间落入唯一对应attempt区间；cloudCalls本身不带attemptId或请求body元数据，不能夸成正式48例同等级的request sidecar验证。三角色cap分别4096/14336/14336，总预留32768；已报告输入7574、输出3662 tokens。

[根代理看图记录](evidence/2026-10-25-g9k-browser-root-visual-review.json)绑定三张实际PNG：重登后的两个待确认卡、第一项完成而第二项仍待确认、两项各自完成回执。截图支持UI终态，精确身份/授权绑定由测试与持久化附件核对，不凭截图猜测。这里只支持当前已知订阅流程，不能外推转账UNKNOWN、进程重启、目标局部重规划或任意中文指代。

## 环境与收尾

[测试库清理](evidence/g9g-isolated-test-2026-10-25T08-08-50-019Z-2c83a83a-fda6-4cab-99f5-b328a87660bb/cleanup.json)确认本次库身份匹配、已删除、验证不存在及进程组消失。启动日志中的空新库Better Auth缺表提示发生在初始化迁移发现阶段，后续真实登录与完整流程成功，不代表未修复的最终数据库错误。

[最终完整性扫描](evidence/2026-10-25-g9k-final-integrity.json)核对316个当前文件与冻结副本、.env完整性/600权限/Git忽略、当前凭据在本轮输出中的泄漏匹配及测试库清理。

[原演示库只读快照](evidence/2026-10-25-g9k-runtime-final.json)确认49表、97命令及全部摘要与开始相同；没有迁移、seed或修改原库。[演示端口检查](evidence/2026-10-25-g9k-final-ports.json)5178/8787未监听，不称在线演示。

## 尚未完成的整体门禁

已关闭本轮验收工具准备和当前已知订阅续办证据缺口；正式48例质量仍未通过。下一步应先针对保存的外层响应错误确定可行动的边界，补足必要的响应诊断或取得可验证的服务条件，不能因“可能恢复”再次整组追分。没有证据支持更换模型、模式或无限追加重试。

稳定版本的真正未见首测、转账UNKNOWN及目标局部重规划的同版云浏览器、有限负载/费用分析、新交付包与接收方环境复现仍各自待证。并行只读核对确认现有实际ZIP/安装/重启证据仍对应G8I；当前导出器可复用，静态枚举86路径、16新增模块，没有生成G9K新包或执行新安装，不能把静态清单称交付成功。比赛完整正式条款与平台提交仍无新证据。整体目标保持active。
