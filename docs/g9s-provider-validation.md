# G9S 指定GLM目录与有界业务复验

2026-10-25。G9Q/G9R当前源316文件保持。最近G9M在17:00的唯一语义请求HTTP502，不能证明当前服务持续不可用；本轮先核服务目录，只有取得新的服务证据后才做一次固定业务复验。保持用户指定https://zwh.axchen.top/v1、GLM-5.3-Flash、现有凭据；不切换服务/模型、不跑48样本追分。

北京时间18:32:25一次GET /v1/models返回HTTP200、273ms、153字节完整JSON，目录只有1模型且精确包含GLM-5.3-Flash；.env摘要未变，推理调用0。这是目录层可用证据，不代表chat/completions或业务已恢复，详见[目录结果](evidence/2026-10-25-g9s-model-directory.json)。

## 执行前固定业务协议

复用G9M生产Planner诊断器，新G9S身份/输出/首跑标记，旧G9M不改。因当前前端已修复提示并拆分聊天加载，旧G9K316逐文件锁不能直接用于当前版本；新inventory绑定G9Q源证据SHA277a2a24d4c2a06cf38b3ffbadf36211b0df2bdbaf7efae60ccef2ba471fb85a与316当前清单，以及运行manifest63258314b0e77b5f557ff8c9477fa7198dd14f6e7f205e99f477dc18b02411dd。除工具身份/源绑定与HTTP错误诊断外，原业务输入、production解释器/卡Agent/复核链和断言保持。

固定合成只读请求：查询澄桥通勤卡尾号7251当前状态，不要挂失。成功要求semantic_intent/card/reviewer三角色各一次，绑定指定卡、ACTIVE状态、无管理建议且复核批准；不把HTTP200或少角色结果当业务通过。每阶段1attempt、无结构修复、60s timeout，总case180s，总输出预算32768（4096+14336+14336），工具硬上限4HTTP。无数据库、真实银行或执行工具。

若HTTP失败，仅有界读取error.code/type/message元数据，实际Key及sk-*先脱敏，限制大小/时长；不保存完整响应或隐藏推理。该诊断不额外发请求，不改变原Response给生产provider；写入失败阻止后续派发。成功仍仅是这个已知合成样本，不能替代未见集/六域/浏览器/恢复或金融正确性验收。实际结果见下文。

## 真实结果

北京时间18:39:06，唯一业务run在semantic_intent阶段HTTP502，278ms、1attempt/1dispatch，卡片领域及复核均未派发。服务端同一响应的脱敏诊断为 `error.type=upstream_error`、`error.message=Upstream service temporarily unavailable`。这解释了当前响应的上游不可用类别，但不是对故障根因、参数全面兼容性或恢复时间的独立证明。

结果validEvidence=true、businessPassed=false，316源/运行环境/本地.env均稳定；请求、dispatch与attempt start/end闭合，响应是完整JSON error对象。没有可评的业务输出，不把它称为GLM结构化能力不合格；也不把/models200当chat/completions通过。usage缺失，不能把报告sum0理解为实际消费0。整轮实际网络为1次目录GET加1次生成POST，未做额外推理重试或替代模型。

[真实运行final](evidence/g9s-smoke-live-2026-10-25T10-39-06-543Z-6432f396-60f1-4f6d-b611-25c378bcd305/final.json)、[同请求脱敏错误](evidence/g9s-smoke-live-2026-10-25T10-39-06-543Z-6432f396-60f1-4f6d-b611-25c378bcd305/http-errors.jsonl)、[请求attempt](evidence/g9s-smoke-live-2026-10-25T10-39-06-543Z-6432f396-60f1-4f6d-b611-25c378bcd305/attempts.jsonl)。首跑标记及所有历史G9M证据保留，不覆盖失败。

## 实现复核与当前处理

工具实现Agent复用G9M，独审Agent机械核对核心输入/解释器绑定/3role成功判据与观察器仍一致，根独占真实请求。根[8项离线纯测](evidence/2026-10-25-g9s-smoke-pure.log)通过；独审另在无继承provider配置的纯进程复跑8项通过。只有工具身份、当前源绑定与HTTP错误元数据采集新增，没有产品代码更改。纯测不计为真实云调用或模型通过。

原演示服务未启动，[原库49表97命令摘要](evidence/2026-10-25-g9s-runtime-after.json)保持。已向用户请求在服务商控制台或联系服务商确认该模型的上游通道恢复，现有配置和Key保留，无需重发Key。等待新恢复信息前不重复生成请求、不重跑48样本、不更换模型。服务恢复后仍须先单场景再完整同版云恢复及未见评估，G9S失败不替代这些验收。完整目标继续active。

[真实运行独立审查](evidence/2026-10-25-g9s-live-independent-review.json)核对首标、当前316源、7记录哈希和同attempt闭合，确认业务失败与usage缺失口径。[最终完整性](evidence/2026-10-25-g9s-final-integrity.json)确认公开阶段输出未包含实际Key、配置保持、原演示端口离线。

无云仍可推进的下一项为当前候选隔离多用户并发交易正确性：复用已有确认、Worker、幂等及账本检查入口，不把G9R的只读查询负载当写入验收。该项不依赖上游恢复，整体暂未达到blocked条件。
