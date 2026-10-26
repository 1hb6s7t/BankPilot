# G9R 多用户持续查询验证

2026-10-25。G9Q产品源码保持，补充G9P单用户72查询短批次之外的多用户持续查询证据。不调用云模型，不把查询负载当支付写入或生产容量验证。

## 执行前固定协议

复用G9Q独立安装副本与已有delivery工具，新建scripted实例72d1893b9093c67c，另建u1/u2/u3三个合成账号。每账号实际DB中1账户、9条当月流水、16条当前/上月可引用流水、2持仓；expected集合和持仓account/product绑定由根直接按owner SQL提取，不从API响应学习预期。共同产品/收款人目录不视为串户，资金动作和赎回动作预期为空。

每用户4个顺序worker，共12worker，每worker60槽，目标每秒发一次GET，dashboard/bills2026-10/investments轮换；720预定槽、每用户240、每用户每路80。无预热/重试，登录和session各用户2次前置请求不纳720。整体自认证开始120秒截止，每请求10秒或剩余截止时间、2MB上限。超时/坏响应/错误归属/缺项/未派发都必须算失败；无法发完不能缩小分母。并发最多12，预登记总体和每用户已派发P95<=1500ms且720全部有效为本地观察门槛，不是生产SLO或容量上限。输出仅label、槽位、路由、状态、时长、调度延迟和布尔/数量，不保存cookie、password或响应正文。

账户/流水/持仓ID集合与各用户预期精确一致；流水及持仓accountId属该owner，持仓productId符合直接DB映射。账单evidenceTransactions及findings的引用限该用户当前/上月集合，categories引用限当前月。此为当前合成数据与读取端点的身份归属检查，不等于跨账号攻击、金额/分析完整正确性或所有API安全认证。

保留32业务表前后摘要，dashboard首读可能初始化daily_usage零用量行；不称GET严格无副作用。原演示库49表97命令独立只读快照保护；最终destroy隔离实例。实现/验证工具Agent负责有界采集与纯测，高推理Agent独审归属和分母，领域Agent只读核seed契约，根独占数据库/认证/负载运行与整合。

固定源manifest：63258314b0e77b5f557ff8c9477fa7198dd14f6e7f205e99f477dc18b02411dd；本轮不重新打包或更改G9Q产品。本轮实际结果如下，首次执行无重试。

## 实际结果

唯一运行exit0，总耗时59180ms（包括认证和结果落盘），720个预定槽全部派发、全部HTTP200、全部业务形状与该用户预期集合校验通过；未派发0、失败0。原始记录恰好720个不同(label,worker,slot)，每用户240、每用户每路80，公开state摘要保持。

| 账号 | 查询数 | P50 | P95 | 失败/未派发 |
| --- | --- | --- | --- | --- |
| u1 | 240 | 40ms | 70ms | 0/0 |
| u2 | 240 | 42ms | 72ms | 0/0 |
| u3 | 240 | 42ms | 69ms | 0/0 |
| 合计 | 720 | 41ms | 71ms | 0/0 |

本轮最长查询87ms、最大计划起点偏移27ms；达到预登记本地门槛。工作流并发上限12、每worker目标1Hz是施加的请求节奏，不代表系统吞吐上限。约一分钟三个同机合成用户不足以证明长时间稳定性、生产SLO、容量极限、并发交易写入或全API权限安全。本轮没有浏览器操作，也没有新云模型调用；身份检查覆盖所列账户/流水/证据引用/持仓字段，不能扩展为金额与报告分析算法完整正确。

## 数据与清理

负载前后32张bankpilot_core业务表中31张完全相同，daily_usage由0行变3行；根独立READ ONLY观察明确对应u1/u2/u3各一行、日期2026-10-25、used_minor均0，没有不认识的owner。bp_plan_commands总数0，没有生成规划命令。首次dashboard初始化属于既有GET副作用，不把本轮称作数据库严格无写入。

原演示数据库49表97命令全部摘要保持。测试实例72d1893b9093c67c已destroy，工具报告子进程、容器和卷均清理成功，主会话exit0。316源文件相对G9Q零漂移，仍使用G9Q源码包，不因增加证据重打新包。

## 证据

- [完整720条查询记录](evidence/g9r-read-load/requests.jsonl)、[统计汇总](evidence/g9r-read-load/requests.summary.json)、[首次运行标记](evidence/g9r-read-load/requests.first-run.json)。
- [隔离数据准备](evidence/2026-10-25-g9r-fixture-created.json)、[前月证据与持仓绑定](evidence/2026-10-25-g9r-fixture-extended.json)、[预登记脚本哈希](evidence/2026-10-25-g9r-prerun-manifest.json)。合成账号凭据及原始ID集合仅留本地fixture，不打入报告或源码包。
- [根执行的5项纯测](evidence/2026-10-25-g9r-load-pure.log)、[工具独审](evidence/2026-10-25-g9r-runner-independent-review.json)。独审另有3项小型反例，总计8/8；没有把离线工具检查算成真实负载。
- [业务表前](evidence/2026-10-25-g9r-business-before.json)、[业务表后](evidence/2026-10-25-g9r-business-after.json)、[行级观察](evidence/2026-10-25-g9r-business-observation.json)、[原库核对](evidence/2026-10-25-g9r-runtime-after.json)、[隔离环境销毁](evidence/2026-10-25-g9r-destroy-state.json)。

G9P单用户短批次、G9Q首屏优化和G9R三用户一分钟查询各自形成有限证据。后续优先解决指定GLM服务的可用输出与同版云恢复/未见质量，保留跨日完整付款、长时间及交易负载、接收方机器和正式比赛提交边界；目标继续active。

[结果独立复核](evidence/2026-10-25-g9r-results-independent-review.json)确认720唯一槽、分布与分位数一致；每worker约1Hz按取整时戳推算，并非严格毫秒级速率保证。[最终完整性](evidence/2026-10-25-g9r-final-integrity.json)确认316源零漂移、测试进程/端口停止、指定模型配置保持，公开输出未包含真实Key或合成测试账号密码。
