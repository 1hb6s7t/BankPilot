# G9L：响应形态诊断与当前运行源码包复现

2026-10-25。本阶段已完成有界诊断、候选包导出与部分新副本恢复验收，整体目标active。G9K旧服务质量16/36、9/12，23例不可评；尚未达到完整质量门槛。G9L注册运行期间不改变模型或业务代码，不回填历史结果。G9L封存后，用户另提供GLM服务配置，配置切换及验证独立记录于G9M。

## 分工与范围

Provider Agent复用生产语义解释器和适配器实现四槽只读响应诊断；流程Agent复用现有交付导出器、校验器及运行框架；独立审查Agent重点检查旁路采集的行为等价、凭据边界及错误归因。根Agent负责真实云派发、新副本安装/启动/浏览器、原演示库比对和最终证据整合。沿用协议工具GPT-6-sol/high、跨层流程GPT-6.1-sol/high、独立风险审查GPT-6.1-sol/xhigh分工，产品仍使用指定云模型。

## 响应诊断

预登记在`.local/g9l-response-envelope-protocol.md`：同一个既有合成只读卡查询，固定4槽json_object、每槽1attempt/0repair/4096输出上限/温度0/60秒。仅原Response的clone旁路有界读取，原Response仍交生产解析；不落盘正文、headers全集、Key或隐藏推理。完整body才分类，超限/超时仅记录不完整。首跑标记排他创建，不以未复现为由追加槽位。

独审发现并修复结构输出观察器写失败覆盖生产错误的风险，初始红证保留；最终仅以durable attempt_end为生产结果来源，本地错误单列。每槽及收尾检查内存中的.env文件摘要，防止只检查process.env而漏掉文件变化。最终[根定向测试](evidence/2026-10-25-g9l-envelope-pure.log)5/5通过，独审20种外层响应与生产解析对照及额外探针通过；产品源未改。

[唯一四槽结果](evidence/g9l-envelope-live-2026-10-25T08-37-03-966Z-607ce94f-9d21-42a0-992f-314360f556d2/final.json)：4次HTTP200、4个完整json_object，3次MODEL_SCHEMA_INVALID、1次MODEL_OUTPUT_TRUNCATED，业务0/4。未复现G9K外层响应无效。完整外层JSON不等于内部业务schema或语义有效；没有正文/字段违例细节，不能从本轮反推上轮body或确定客户端修复。输入9692、输出6686 tokens，reasoning6523是输出中的报告子集；四槽合计49040ms，不是性能基准。[独立审计](evidence/2026-10-25-g9l-envelope-live-audit.json)核齐首标、source、4组attempt/request/envelope/output、预算和文件摘要，全部通过。没有追加第五次。

## 运行源码包与新副本

[导出说明](g9l-delivery-notes.md)、[来源清单](evidence/2026-10-25-g9l-delivery-source-map.json)和[导出执行证据](evidence/2026-10-25-g9l-delivery-verification.json)对应导出阶段时点：`.local/g9l-runtime-source`含86源文件加manifest，manifest SHA256 `5a0515d2626686f26846d97a331d36427252ff670b3a02fc36bbd3368a0423f7`。81成员绑定G9K冻结源，5个辅助输入独立绑定；README仍来自历史G8I安装说明，旧结论保留历史身份。该说明中“尚未安装”是导出阶段状态；其后的新副本执行以本报告与新证据为准，不覆写已绑定的说明哈希。

[根代理逐成员复核](evidence/2026-10-25-g9l-delivery-root-audit.json)确认origin/manifest一致、无额外成员，并扫描当前配置Key无匹配。清洁导出目录保持未安装；另外复制到`.local/g9l-installed-copy`，使用全新`.local/g9l-install-store`，实际下载并安装锁定的257包。[安装日志](evidence/2026-10-25-g9l-fresh-install.log)12.8秒完成；[installed verify](evidence/2026-10-25-g9l-installed-verify.json)、[类型检查](evidence/2026-10-25-g9l-installed-typecheck.log)、[构建](evidence/2026-10-25-g9l-installed-build.log)通过。主JS仍787.35kB，500kB提示未关闭或宣称优化。宿主预装Node/pnpm/Docker且镜像可能已缓存，不称空机器或离线安装。

独立state使用随机端口、新容器和数据卷，默认scripted，清除宿主模型配置。没有把原.env放进导出或实例。实际API/Worker/Web与PG已启动，ready和源manifest绑定成功。

## 首次浏览器失败及真实业务日边界

[旧INITIAL首次实跑](evidence/g9l-clean-delivery-initial/report.json)0/1，失败保留。已通过登录、账单/理财/目标页面与赎回强验证，随后旧测试在25秒内等待SUCCEEDED，实际为SETTLING。不能称完整INITIAL通过，也不把部分操作推断为六域交付验收。

[原实例只读诊断](evidence/2026-10-25-g9l-delivery-pending-diagnosis.json)确认唯一赎回100000分、STRONG proof一条、持仓占额保留、提供方ACCEPTED，账户800000分，后继转账0笔。实际acceptedAt为周日`2026-10-25T08:25:51.066Z`，due为周一`2026-10-26T08:25:51.066Z`。`estimateSettlementAt`按上海时区的合成工作日规则将周末顺延，即使businessDays=0；这不是法定交易日历。款项尚未入账，SETTLING与该规则一致；旧测试在工作日成立的立即到账假设不适用于此次周日。

沿用同一原实例、原目标与原赎回，另登记`.local/g9l-pending-recovery.spec.ts`的BEFORE/AFTER，两CLI之间实际stop/start。首次grep锚定完整测试名不匹配，日志记录No tests found，未执行任何测试；改为明确选中`BEFORE original`，不是重跑失败业务。实际[BEFORE](evidence/g9l-pending-before/report.json)1/1、[AFTER](evidence/g9l-pending-after/report.json)1/1。runtime/API/Worker/Web PID和PG启动时间确变，稳定业务快照摘要均`dc6c96...`（完整值见附件），原action/proof/provider key/inputhash、100000分持仓占额、800000分余额不变；无后继付款、无结算分录，无重复提交审计。正常reconcile读取可继续，不把查询次数不变作为要求。

[独立附件审查](evidence/2026-10-25-g9l-delivery-independent-review.json)核对86源/installed/origin和前后实际附件；[根看图](evidence/2026-10-25-g9l-pending-visual-review.json)确认两张UI均显示次日预计到账、未到账及后继步骤等待。没有新增交易、修改时钟或强制到账。旧INITIAL完整成功与后续到账付款仍未验收，pending恢复不能替代完整六域或真实云链。

## 包归档与清理

已生成[候选运行源码ZIP R2](../artifacts/BankPilot-G9K-candidate-runtime-source-20261025-r2.zip)，根CRC与逐成员摘要校验通过，含86运行源加运行manifest，以及外层来源清单、当前说明与结果边界；不包含安装后依赖、实际.env、实例私有配置或数据库。[R2归档校验](evidence/2026-10-25-g9l-archive-r2-verification.json)记录92成员、431834字节，SHA256为`56897504d391b9238a2e728f7799ff123a6b46d35cfd8ffd3df6162a94f39dd0`。模型切换后仅修订外层说明，不改运行源码或G9K清单；初版归档与校验保留。

[本实例最终状态](evidence/2026-10-25-g9l-delivery-final-state.json)确认childrenStopped、containersRemoved和volumeRemoved均true。[G9L完整性收尾](evidence/2026-10-25-g9l-final-integrity.json)在用户新配置切换前确认316冻结源零漂移、旧.env阶段内未变/600/Git忽略、143输出文件对当时配置Key无匹配，实例与原演示端口均关闭。[原库只读比对](evidence/2026-10-25-g9l-runtime-final.json)49表97命令全部摘要保持。安装副本、独立store与本地私有state保留，不在分发物中。

## 未完成目标

G9K质量门槛、真正未见首测、其他同版云故障恢复、有限容量/成本、接收方实际机器及正式比赛交付仍各自待证。当前候选导出与部分新副本运行不能替代它们，整体未发布。
