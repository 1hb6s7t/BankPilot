# G9I：模型指令链路诊断与银行卡同位表达

2026-10-25。本阶段工程与注册评测已完成，模型质量未达标；未发布、未完成整体目标。上一阶段G9H已封存，原报告、冻结副本与真实失败记录均保留。

## 本阶段范围

1. 用生产invokeStructured构造固定合成请求，离线证明schema/修复反馈实际进入请求，另行有界诊断当前云端是否遵守system约束。默认离线，显式live至多4次、每次1024 token/20秒；诊断与业务评测分开。user control成功不能替代system合格，不自动改角色、映射非法枚举或放宽schema。
2. 修复原文完整卡名与尾号的同位表达误拒，保持ID、原文坐标、唯一对象、否定和引用约束。不得针对已知案例硬编码。
3. 后续银行卡查询截图必须等到实际UI完成并展示与当前命令一致的卡片事实，继续检查旧账单隐藏结果没有泄漏。

根Agent负责恢复版本、独立审查与串行验收；GPT-6.1-sol/xhigh处理语义定位及反例，GPT-6.1-sol/high处理浏览器断言并交叉审查语义，GPT-6-sol/high负责有界诊断和纯测试。属于开发知情复核，不称盲审。

## 恢复与验证边界

API graph更新为bankpilot-planner-g9i-v1，语义规则版本更新为bankpilot-semantic-g9i-v1，结构state-v5保持。旧版本识别结果不得被新规则静默重新解释，原请求与旧快照保留；新请求使用新规则。补充纯API版本拦截反例和真实journal语义版本独立不匹配反例。

[初始只读快照](evidence/2026-10-25-g9i-runtime-before.json)确认原演示库49表及97命令相对G9H收尾无变化。测试与浏览器使用独立临时数据库，由根Agent串行执行。云端诊断、纯测试、受控UI和真实业务评测分别记录，未实际运行的项目不标通过。

## 已完成的局部验证

卡片原文绑定改动经历独立反例审查：初版曾错误接受旧稿、前后置条件及被排除对象，失败证据保留；最终将新同位许可限定为完整已知卡名主体、完整四位尾号及一个匹配的当前动作/查询，未知残余保持澄清。明确当前请求加“之后本人完成验证”的原例及独立对照仍通过。[最终独审](evidence/2026-10-25-g9i-card-apposition-independent-review-final.json)110/110纯测试通过，未把代码检查称为真实模型效果。

[生产路径小样本诊断独审](evidence/2026-10-25-g9i-live-diagnostic-independent-review.json)确认本轮2次HTTP200/stop、system与user control各首轮通过，输入181/198 token、输出39/69 token；未实际触发云端repair。它与G9H先前异常并存，不能证明大schema或上游服务稳定。默认离线诊断证明本地repair请求确实变化，纯测试同时检查凭据回显省略。

为后续业务评测增加可选requestObserver，按attemptId绑定派发前body/system/user/schema长度与SHA，记录实际schema位置和修复反馈；不保存原文、key或header。hook必须配attempt journal；写入拒绝/超时使本attempt以未发送结束，不发HTTP、不自动重试。无hook、开启hook和G9H旧冻结版本的相同输入wire比较保持原请求，不改变预算或模型参数。

[G9I评测协议](g9i-validation-protocol.md)复用共享执行内核和固定profile，保持原36→12及三套评分；新请求sidecar必须与attempt闭合，区分已准备未发送与实际派发。旧G9H报告不能充当前置阶段。独立新增profile入口避免复制整套执行循环，历史冻结副本保持。

[受控浏览器报告](evidence/g9g-isolated-test-2026-10-25T06-29-11-727Z-94f14829-5801-4f5a-883e-1dec9ff4717d/browser/report.json)13/13通过，11条UI流程+2项guard、无重试；独立测试库清理已验证。[根代理看图复核](evidence/2026-10-25-g9i-browser-root-visual-review.json)确认两张后续卡片图均已完成、包含当前卡事实，原账单withheld历史仍在。截图还显示账单拒绝消息包含原始诊断码，交付前应改成用户可读提示，机器诊断仍保留；不将当前画面称为最终产品体验验收。

## 全仓与冻结

[全仓日志](evidence/2026-10-25-g9i-isolated-full-check.log)：130文件3372/3372、类型检查与构建通过，包括新增request hook独审8项；独立测试库[清理记录](evidence/g9g-isolated-test-2026-10-25T06-31-57-650Z-392f02d8-b82f-426f-997d-e6ffad5098d9/cleanup.json)确认已删除、进程组消失。主JS787.35 kB/gzip228.86 kB，500 kB构建提醒仍在。之后仅加强先验元数据篡改测试，使改动文件SHA后仍能检查ID/角色/场景/token/outputMode/隐私字段/repair绑定，[最终39项纯复测](evidence/2026-10-25-g9i-root-final-pure.log)及类型检查通过，未重复宣称又跑全仓。

[request hook独审](evidence/2026-10-25-g9i-request-observation-independent-review.json)与[评测入口根审](evidence/2026-10-25-g9i-runner-root-review.json)已完成。准备摘要只证明客户端内容，不能证明上游收到/遵循。

[冻结manifest](../evals/g9i-manifest.json)绑定307文件，冻结时间2026-10-25T06:35:00.099Z；[预检](evidence/2026-10-25-g9i-preflight.log)通过。[检查后原库快照](evidence/2026-10-25-g9i-runtime-after-checks.json)49表与97条命令摘要保持。真实两组均已完成；不能以小样本诊断替代业务结果。

## 运行中已完成记录的独立诊断

[前三例请求证据独审](evidence/2026-10-25-g9i-head3-request-attestation-independent-review.json)绑定33条已完成行，而非追加文件的最终摘要。3例/8attempt按ID核齐；6次离线stub重建表明G9H冻结版与G9I当前版的三个首请求逐字节相同，四组件摘要均匹配真实G9I请求记录。semantic system从7137字节变为repair7520字节，schema6802字节；服务商报告input仍2552→2552、2568→2568、2547→2547，首轮较G9H逐例少1656。此证据证明客户端构造一致，不能证明上游如何收到或处理指令，也不是历史G9H网络抓包。

下一步兼容探索可在system完整保留的同时，向user侧程序生成的outputContract冗余schema，把业务task明确分开。它只是一项待验证方案，不能关闭本地严格schema/source/资金/授权门禁；额外输入字节、token和延迟都须测量。独立ABBA合成诊断在两组正式运行结束后派发了4次，不改本轮冻结候选或成绩。最初离线账单任务被根审替换为更能检验kind/id字段的纯只读合成卡片查询；校准发生在任何诊断live之前，旧dryrun保留。


## 已知组实际结果

[已知36例原始报告](../evals/results/g9i/default-known-2026-10-25T06-35-33-055Z-3a2ebe8c-00ae-4d04-89e1-60e8104f13bb/report.json)三套固定评分均为1/36，唯一通过g9-investment-04；35例不可评，最终错误为schema 26、截断7、JSON非法2。不可评包含semantic阶段27例、领域阶段8例。银行卡同位表达修复未取得本轮真实模型验证：card02先因模型结构错误结束，不能把纯测试通过当作云端修复已验收。

82次请求全部HTTP200，起止闭合，0未发送，预算完整；供应商报告输入196285、输出167767 token，无缺报。请求摘要82条，schemaMissing=0，38条修复反馈。38组修复的system摘要均变化，user/schema均不变，其中37组供应商报告输入token相同。该现象与本地请求变化不一致，但不足以定位上游内部原因。1个可评样本的安全分数不代表其他35例通过安全验收。


## 下一候选的实现边界（尚未落地）

并行只读设计审查建议：若独立对照支持探索，在共享invokeStructured中对json_object统一增加版本化user契约，保持system原文、原schema及原输出解析。原task作为不可信数据完整隔离，不得覆盖应用契约；修复反馈复用生产安全字段，不复制仅适用于semantic的诊断白名单。各领域、joint与reviewer使用同一入口；tools请求保持。观测须单独记录原task摘要，因新增repair会使user摘要变化；恢复身份应绑定实际wire契约，拒绝旧条件下的缓存。该方案尚未实施，也没有改动本轮冻结候选。


## 两组正式评测收尾

| 组别 | 原G9 / G9E / G9G通过 | 可评 | 不可评 | 实际HTTP调用 |
| --- | --- | --- | --- | --- |
| 已知回归36 | 1 / 1 / 1 | 1 | 35 | 82 |
| 开发知情补充12 | 5 / 5 / 5 | 5 | 7 | 34 |

[补充12例报告](../evals/results/g9i/default-quality-2026-10-25T06-56-08-451Z-6a7d2ee5-81b8-400c-8e51-736a854f1df2/report.json)最终5例schema错误、2例截断；三套口径5/12一致。两组116次HTTP200，0未闭合请求，116条请求摘要均有schema；48次repair带反馈。供应商报告合计输入276061、输出215855 token，无缺报；缺少可信价格数据，不换算货币成本，也不以失败早停的时延称性能提升。

所有样本均按注册预算完成首轮，没有为成绩重复运行；两组validRun=true表示记录与执行有效，不能据此认定产品合格。两组只有6例可评，不可评的42例不能算作安全通过。候选未发布，真正未见样本、多轮恢复、容量与新交付验收仍待完成。


[两组独立审计](evidence/2026-10-25-g9i-final-independent-audit.json)overallEvidenceValid=true、issues为空；307份当前源码和冻结副本零漂移，首次运行标记、前置报告SHA与三套评分、semantic/bill/request证据均核齐。

## 独立四次兼容对照

[固定ABBA诊断](evidence/g9i-user-contract-abba-live-2026-10-25T07-02-56-753Z-4eb7d708-0360-41fd-9c9a-c2a3f1f7259a/final.json)仅查询合成卡片，未执行银行动作。A为原请求，B保持system完整并新增user侧契约；各执行两次，四次均HTTP200/stop，JSON/schema有效且解析为ready只读card_query。预注册严格通过为A 1/2、B 1/2；另外两次disposition=request，不满足脚本固定query条件。脚本sourceValid是合并判据，不能把其false直接称为原文来源错误。[独立复核](evidence/2026-10-25-g9i-abba-independent-review.json)确认生产代码对card_query允许request，四次均正确解析为完整原请求与唯一目标卡片的只读查询；这两次不是产品业务错误。原分保留，诊断条件过严的限制单独注明。A第一次原始mention尾坐标多包含一个字，由既有唯一原文text回退定位成功；脚本也没有把raw坐标完全一致作为通过条件，不能称为严格原始坐标验收。

B额外7789字节，供应商报告平均输入5752对4070，增加1682 token；平均延迟B 4345ms、A 5186ms，仅各两次，不能宣称速度改善。单一只读输入、没有云端repair，不代表六域业务或稳定性。该对照没有证明冗余schema优于原方式，当前不把此探索方案合入产品；下一步应先验证服务的结构化输出能力及稳定性，再据证据选择适配。

[最终原库只读快照](evidence/2026-10-25-g9i-runtime-final.json)49表、97命令与初始一致；本轮正式模型评测与ABBA均不连接业务数据库。新Key已解除403，但输出质量门槛仍未达到。


[端口收尾](evidence/2026-10-25-g9i-final-ports.json)确认5178/8787未监听，测试环境未发布为在线演示。[收尾完整性扫描](evidence/2026-10-25-g9i-final-integrity.json)记录源码/副本摘要、当前凭据输出扫描及.env权限与Git忽略状态。
