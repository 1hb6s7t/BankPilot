# G8I 数据库故障恢复与独立源码交付验收

日期：2026-10-23。G8I 已完成四个真实数据库故障窗口、连接生命周期修复，以及同机独立导出副本的安装、业务执行、全服务停止重启和资源清理。项目仍为本地合成银行沙箱；云模型质量与比赛最终交付尚未完成。

## 本轮结果

| 检查 | 结果 | 证据与范围 |
|---|---|---|
| 全仓自动化 | **1544/1544，69 文件，0 跳过，进程退出 0** | [最终 JSON](../evals/results/2026-10-23-g8i-final-tests-v2.json)。前一轮 1540/1540 保留，独立复核后新增 4 项交付校验测试。 |
| 真实数据库故障 | **4/4，退出 0，未处理异常 0** | [最终测试](../evals/results/2026-10-23-g8i-db-fault-attempt-6.json)、[逐窗口业务和清理证据](../evals/results/2026-10-23T15-18-23.995Z-g8i-db-fault-evidence.json)。独立 PostgreSQL 17 容器、专属卷和动态端口。 |
| 事务与 Worker 定向检查 | **18/18** | [单测](../evals/results/2026-10-23-g8i-shared-database-unit-v2.json)。包含借出连接错误、原错误保留、监听移除、连接淘汰和安全日志。已计入全仓分母，不相加。 |
| 独立数据库既有业务回归 | **80/80，7 文件** | [业务回归](../evals/results/2026-10-23-g8i-core-regression-isolated.json)、[独立资源与清理](../evals/results/2026-10-23-g8i-core-regression-isolation.json)。 |
| 交付工具定向检查 | **14/14** | [报告](../evals/results/2026-10-23-g8i-delivery-review-retest.json)。清单漂移、文件缺失、意外文件、符号链接、私有配置和显式模式。已计入全仓分母。 |
| 清洁副本浏览器 | **初始业务 1/1；实际重启后 1/1** | [初始通过](evidence/g8i-clean-delivery-2026-10-23/initial-attempt-2/report.json)、[重启通过](evidence/g8i-clean-delivery-2026-10-23/restored-attempt-1/report.json)。两次独立运行，retry=0，0 skipped/flaky；使用实际导出源码、认证、Worker、数据库和 Chromium 软件认证器，scripted 模式。 |
| 类型检查与构建 | **通过** | 原工作区类型检查通过；独立副本类型检查与构建退出 0。JS 739.14 kB / gzip 215.78 kB，原有大包提示仍在。[安装与构建记录](evidence/g8i-clean-delivery-2026-10-23/installation-verification.json)。 |
| 可分发源码归档 | **70 个源码文件＋1 个 manifest** | [ZIP](../artifacts/BankPilot-G8I-runtime-source-20261023.zip)，312621 字节。[归档核验](evidence/g8i-clean-delivery-2026-10-23/archive-verification.json)。逐成员哈希与 CRC 通过，未打入真实 `.env`、模型密钥、依赖、私有实例状态、数据库或历史 trace。 |

## 数据库故障与修复

第一项在授权 COMMIT 前真实终止本测试的 PostgreSQL backend，确认动作仍待确认、凭据和占额未残留；原动作重试后只执行一次。第二项将真实授权 COMMIT 发给数据库，独立连接先确认提交已持久化，再丢弃 18 字节回应并断开客户端；重复授权按原契约拒绝，原动作和原 outbox 仍能完成，只有一个凭据和一笔提供方原单。

第三项丢弃合成提供方 COMMIT 的响应：提供方已记账，应用进入 UNKNOWN、保持占额，本地余额尚未扣减；随后沿原提供方键查询并恢复，多次执行/查单不重复付款。第四项对自有数据库容器发送 SIGKILL，确认退出 137，同容器与专属持久卷重新启动并观察到 WAL 恢复；运行中的 Worker 重连并执行原授权 outbox，终态只含一笔原单和一组双边分录。

故障暴露了两处运行问题：借出连接发出的 `error` 事件未被事务包装器处理；生产池的 idle client 错误也缺少监听。现在 `packages/core/src/database.ts` 统一管理借出连接、事务与空闲池错误，Core、Finance、Investment、Management、Goals 和 Worker 复用。断线连接被淘汰，回滚失败不会覆盖原始错误；日志仅记录受限错误码。它不会自动重试事务或猜测 COMMIT 结果。授权、占额与原单恢复仍由既有业务状态机决定。

应用和合成提供方仍是**同一数据库内的独立事务**。上述故障不证明独立外部银行可用、宿主机掉电恢复、任意持久化窗口恢复或所有对话/规划事务均已覆盖。

## 新副本的真实业务和重启

在已有 Node 24.19.0、pnpm 11.25.0、Docker 29.8.2、Compose 5.6.0 的 macOS arm64 主机上，首次导出副本用全新私有 store 下载 257 个包，冻结锁文件安装成功，用时 40.3 秒。独立复核后仅修改导出校验，第二份新副本用本轮新建的 store 安装全新的 node_modules，用时 2 秒。固定 PostgreSQL 镜像已在主机缓存；这不是空机器或离线安装证明。

新副本没有工作区 `.env`；数据库、Cookie 前缀、四个端口及私有配置均独立。启动器核验运行源码清单，浏览器每例再对照实际副本的 manifest SHA256、文件数、实例、模式和地址。界面明确显示脚本验证模式，浏览器 HTTP 请求未拦截替换，合成银行服务实际运行。

浏览器实际检查账单缺月/部分覆盖、资金计划、两项理财持仓及生活目标：初始现金 8000 元，准备赎回时没有凭据、占仓或提供方记账；通过软件 Passkey 强验证赎回 1000 元后，现金到 9000 元；到账本身不会创建或授权后继付款。显式准备下一步，再独立确认 600.75 元转账，目标完成，现金 **8399.25 元**、占额 0。赎回和转账各一笔提供方原单，各两条 DEBIT/CREDIT 分录。

卡片挂失和解挂各有强验证；订阅查询、商户取消和银行拦截各有单独确认，五个管理动作凭据齐全。刷新后先隐藏订阅，显式读取仍有效的原授权。退出重登后原目标仍完成。

初始启动进程 27182 完成后执行真实 stop，API、Worker、Web、数据库容器停止，命名卷保留；第二次启动进程为 30509，PostgreSQL postmaster 启动时间也前进。重登后核对原目标、原提供方收据、余额和分录完全相同，再次检查目标不会重复记账。移动宽度 390 像素无横向溢出，并保存了[重启后截图](evidence/g8i-clean-delivery-2026-10-23/restored-attempt-1/artifacts/g8i-clean-delivery-RESTORE-5a997-rker-and-PostgreSQL-restart/clean-copy-after-all-services-restart.png)。

最终显式 destroy 后，[独立清理复查](evidence/g8i-clean-delivery-2026-10-23/cleanup-verification.json)确认 10 个本轮进程 ID 均已退出、四个动态端口关闭、该实例容器和卷不存在。临时源码副本、私有依赖 store 和 0600 私有配置留在本机临时目录，不在交付 ZIP 中。

## 失败记录、复核与源码对应

- 数据库早期轮次曾出现“JSON 断言全通过、进程退出 1”的未处理连接错误；没有将其计为通过。[各轮计数、退出码和异常记录](../evals/results/2026-10-23-g8i-db-fault-run-status.json)保留。第四项首轮还暴露了重启时动态映射端口改变的测试环境问题，随后固定本轮动态选择的端口。
- 清洁副本首次浏览器在执行业务前因测试读取不存在的 `ledger_entries` 失败。实际表名为 `provider_entries`；同时把账户占额改为按真实动作表聚合。只修正测试读取，不修改业务或放宽金额/唯一性断言。[首轮失败](evidence/g8i-clean-delivery-2026-10-23/initial-attempt-1/report.json)完整保留。
- Luna 只读复核发现 installed 校验过早跳过生成目录、E2E 缺少运行 manifest 对照；已修复并加入检查。[独立复核](g8i-acceptance-review.md)区分静态审查与主线程实跑结果。
- [最终源码快照](../evals/baselines/g8i-delivery-final-2026-10-23T15-33-15-335Z/source-manifest.json)冻结 173 文件。初始快照保留；两者仅 G8I 浏览器读表修正不同。最终交付归档与浏览器实跑副本只有 README 和交付说明的验收文字不同，其他 68 个清单成员字节相同；未因文档更新重复浏览器运行。

本轮沿用固定 PostgreSQL/pg、pg-boss、Better Auth、SimpleWebAuthn、Vite 和 Playwright，没有新增或升级依赖。Astra 负责高风险提交未知、并发和事务修复；Sol 负责边界明确的导出、隔离启动与清理工具；Luna 做独立只读复核；主 Agent 负责真实安装、浏览器、重启、源码归档与综合验收。开发协作分工与产品内多 Agent 规划分别记录。

## 原演示和未完成项

本地 5178 的 API 与 Worker 已平稳更新，旧进程退出 0，新进程健康。[48 表摘要对照](evidence/2026-10-23-g8i-runtime-refresh.json)显示 46 表完全一致；投资动作与 outbox 两表摘要发生变化；随后只读检查仍有6笔未来到期的SETTLING赎回，与Worker周期查单行为一致。这两表没有捕获逐字段前后对照。账户、提供方原单、用户、会话、消息与规划命令没有丢失；没有重新初始化或清空演示数据。

指定模型目录在 2026-10-23 23:08（上海）再次返回“服务已暂停”：2 次只读目录 HTTP 请求包含一次同源重定向，**模型生成调用 0**。[诊断](evidence/2026-10-23-g8i-provider-catalog-diagnostic.json)不含密钥或响应全文。本轮没有新的云模型业务质量分数；历史 G8D 19/24、G8E 接入 0/1 不转记为 G8I 成绩。

继续推进真实模型已知回归与新的独立未见样本、尚未覆盖的对话/规划数据库故障和长历史、可量化性能、接收方环境复现、比赛录屏及正式要求核对。该 ZIP 是可分发的最小运行源码，仍需 Node/pnpm/Docker 和网络安装依赖；它不是完整评测仓库、离线包、生产部署或已经提交的比赛材料。总体目标保持未完成。
