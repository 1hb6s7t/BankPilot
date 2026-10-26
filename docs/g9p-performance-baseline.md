# G9P 生产首屏与有限只读负载基线

2026-10-25。在G9O候选不改源码的前提下测量，先建立可解释基线，再决定是否拆分代码。复用G9O安装副本和现有交付工具，另建独立scripted数据库/API/Worker/Web实例；另开Vite production preview提供实际构建dist，空envDir、真实隔离API代理，无开发入口。不读取或改变模型服务配置，不调用云模型。

## 运行前固定方案

首屏：同一桌面Chromium进程内5个全新context、1440×1000、禁HTTP缓存与service worker、不模拟CPU/网络。只打开未登录页面，不提交登录。登录控件需在15秒观察窗口内可编辑/可点击；此窗口是测量有效性条件，不是性能SLO。记录全部五次结果、原始导航/资源字节、FP/FCP和登录可操作时间，仅报告min/median/max；任一样本无效即不把整轮称有效基线。实际JSON401视为正常未登录，HTML fallback不当API成功。浏览器transferSize、响应体encoded/decoded大小与构建gzip估算分开。

只读负载：首屏测量结束后独占同一隔离实例，通过公开合成账号登录一次，Cookie只留内存。顺序执行并发1、4、8，每档24个GET，共72个；账户dashboard、2026-10账单、持仓各占每档8次，无预热、无重试。每请求10秒超时、2MB响应上限，失败与错误形状全部保留分母；业务形状要求真实非空合成账户、账单和持仓，不能只测health。预设本地阈值为每档24/24成功且P95分别不超过1500/3000/5000ms，nearest-rank统计全部请求；吞吐包含采集落盘时间。通过仅表示这组小样本达到阈值，不能称容量上限、长期稳定性或生产SLO。

前后只读比对隔离库bankpilot_core业务表；登录session与队列表不属于该业务摘要范围。原演示库另按既有49表97命令摘要保护。测试后停止preview及交付实例并核清理。

## 分工与证据

流程Agent只读分析静态依赖与潜在切分点；工具Agent实现固定72请求采集器；高推理审查Agent实现5次首屏测量并独审负载分母与计时；根负责注册条件、运行、比对与最终判断。前端只读分析发现ConversationsPanel是assistant-ui唯一静态导入入口，可能成为最小延迟加载切口；当前未改产品，不能预先声称节省字节或提速。

G9O源manifest为`5eafc9a853dd6c55aea0863f7bcef68b70339cf20ae58336c81ebfb0b1112dd8`，独立state位于`.local/g9p-delivery-state`；生产preview公开绑定见`docs/evidence/2026-10-25-g9p-baseline-preview.json`。下述结果来自该绑定版本的唯一首轮实际执行，产品源码保持G9O版本。

## 实际结果

首屏用例1/1通过，内部5个全新context全部有效、0重试。浏览器Chromium 156.0.8078.4，darwin/arm64；单浏览器进程、无CPU/网络限速、禁缓存，不是5次冷启动操作系统。登录可用时间原值为117.1、64.7、59.4、59.6、59.4ms，min/median/max分别59.4/59.6/117.1ms；FCP原值100/76/52/52/52ms，min/median/max为52/52/100ms。登录没有提交；两条初始化API分别返回真实JSON401，未拿HTML回退冒充API。

每次主JS解码后787529字节，实际gzip响应体227027字节，Resource Timing transferSize为227327字节；JS+CSS静态资源合计编码241316、解码854434、transferSize241916字节，不包含HTML及API。构建器gzip估算228.87kB与实际服务压缩响应不是同一指标。当前仍为单一主JS，500kB构建提示存在。

| 实际并发 | 业务GET数 | HTTP200且业务形状有效 | P50 | P95（nearest rank） | 批次墙钟 |
| --- | --- | --- | --- | --- | --- |
| 1 | 24 | 24/24 | 5ms | 9ms | 242ms |
| 4 | 24 | 24/24 | 14ms | 21ms | 116ms |
| 8 | 24 | 24/24 | 28ms | 41ms | 113ms |

总计72/72，错误0；每档账户/账单/持仓各8次。登录POST与会话GET另2次前置请求，不属于72次业务测量分母。各档均满足预登记有效性和内部阈值，公开state哈希保持；无预热或重试。每档仅24次、百毫秒级短批次，不把测得吞吐作为稳定QPS、容量上限或长期SLO，也没有测云模型、支付写入、多用户隔离或完整金融正确性。

## 数据变更核查与清理

**查询型GET不等于数据库严格只读。** 完整保留32张bankpilot_core表的前后摘要，其中31张一致；daily_usage由0行变为1行。另一次READ ONLY事务观察到业务日2026-10-25、used_minor=0。core.dashboard(index.ts:225-240)调用daily(:70-73)会INSERT零用量行；ON CONFLICT不会重置已有用量。这与当前差异一致，未观察到扣款、占额或ledger变化。该行的owner未单独落入本轮行级证据，不将其作为逐响应所有权验证。dashboard还可能过期待处理动作，investment.dashboard也有到期处理，所以预登记中的“只读”应按客户端只发业务GET理解；严格32表不变条件未满足，不能将本轮整体包装成完全无写入验收。

原演示库独立READ ONLY摘要仍为49表97命令，所有摘要保持。隔离实例2a43a167b4c3717d已destroy，工具确认childrenStopped/containersRemoved/volumeRemoved均true，交付主会话exit0。production preview发SIGTERM后会话exit143，其关闭标记为空文件，未证明优雅退出；最终以独立进程/端口检查记录实际停止，不把空标记当成功JSON。空标记原样保留。

## 结论与下一步

本轮建立了当前G9O候选的生产首屏和有限查询负载基线，没有修改产品或生成新候选包。本机登录首屏未显示明显延迟问题，但未登录仍下载完整聊天依赖；后续可单独评估ConversationsPanel延迟加载，须量化实际初始字节变化，并回归已登录聊天、切换会话、重登与失败恢复后才能采纳。当前没有优化前后对照，不能声称提速。

用户指定GLM-5.3-Flash及本地凭据保持；本轮云调用0，最近G9M实际HTTP502仍是云验收缺口。完整跨日到账付款、同版云恢复/未见质量、多用户持续负载、接收方机器和比赛提交均未因本轮通过。整体项目目标继续active。

实际证据：
- [五次首屏原始数据](evidence/g9p-first-load-browser/samples.json)与[Playwright结果](evidence/g9p-first-load-browser/report.json)。
- [72条业务请求记录](evidence/2026-10-25-g9p-read-load.jsonl)与[汇总](evidence/2026-10-25-g9p-read-load.summary.json)。
- [业务表前](evidence/2026-10-25-g9p-business-before.json)、[业务表后](evidence/2026-10-25-g9p-business-after.json)、[零用量行观察](evidence/2026-10-25-g9p-daily-usage-observation.json)。
- [原库核对](evidence/2026-10-25-g9p-runtime-after.json)与[隔离环境销毁](evidence/2026-10-25-g9p-destroy-state.json)。

- [结果独立复核](evidence/2026-10-25-g9p-independent-review.json)重算5次首屏与72条请求，与汇总一致；复核明确保留daily_usage变化。
- [最终完整性](evidence/2026-10-25-g9p-final-integrity.json)：316源文件零漂移，7个相关端口未监听，5个测试进程均已停止；本地指定配置匹配，.env权限600且被Git忽略，公开输出未包含实际密钥。
