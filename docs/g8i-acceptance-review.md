# G8I 数据库故障与清洁副本交付：独立验收口径

本文件是 G8I 开始阶段的只读验收矩阵，不是通过报告。依据 README、`docs/ideal-state-acceptance.md`、G8H 最终报告及其最终核验/运行态摘要；未运行数据库、浏览器、安装或云请求，未读取 `.env` 内容，未修改源码。

## 当前证据边界

G8H 提供了重要基线：六项受控浏览器流程 6/6、1524 项自动化 1524/1524、167 文件冻结哈希零漂移；每个浏览器 fixture 有独立用户/schema/queue schema，且六项清理记录全部 clean。API 和 Worker 的正常重启也完成了 48 表摘要对比：46 张未变，`investment_actions` 与 `investment_outbox` 两张表在正常 reconciliation 中变化，6 笔 T+2 仍处于 SETTLING。

这些记录没有实际停止/崩溃 PostgreSQL，也没有覆盖 `COMMIT` 响应丢失、数据库进程重启后的 WAL 恢复或连接/事务不确定窗口。正常 API/Worker 重启不等于数据库故障注入。G8H 的浏览器使用受控模型 HTTP、云调用 0；它不能证明云模型语义质量、实体 Passkey、外部银行/商户动作或清洁机器交付。

## A. 数据库真实中断与提交未知矩阵

各行都应在新的独立 compose 项目、数据库容器和空业务 volume 中运行，避免污染演示库。当前合成 provider 原单、provider balance 与 entries 也存放在应用使用的 PostgreSQL/schema 中，因此它们会随同一数据库故障一起不可用或回滚；若要验证“外部已提交、应用数据库中断后仍能查回原单”，必须另建独立持久化的 provider simulator/API，或把结论限制为同库事务恢复，不得把同库 synthetic provider 叫作独立外部持久化。记录每个故障点的 PostgreSQL 容器 ID、日志、时间线、连接/事务状态、command/action/provider key、原始表快照和恢复后快照。对业务资金写入，必须把 API/动作视图、provider 原单、借贷分录、余额/占额、审计和 Outbox 一起核对。

| 故障窗口 | 最小注入方式与必须保留的边界 | 恢复后成功条件 | 不能据此声称 |
|---|---|---|---|
| 业务事务提交前数据库断开 | 在授权/预留/审计/Outbox 事务进行中停止 PostgreSQL 或断开连接；覆盖事务明确未提交。 | 整个本地事务回滚；没有授权证明、余额/占额/审计/Outbox 半记录；同一用户命令可安全重试且只生成一个有效动作。 | 仅抛 SQL 错误的 mock 覆盖了真实 PG crash/WAL 恢复。 |
| PostgreSQL 已提交但响应丢失 | 让 `COMMIT` 成功后，在服务端收到确认前切断连接或杀 API；使用原命令/请求重连。 | 重启后读到完整已提交交易；按稳定 command/action/provider id 回放原结果，不建第二动作/授权/分录；若应用无法确认 commit，外部行为标 UNKNOWN，先查询原单。 | HTTP 500/超时必然代表数据库回滚。 |
| 外部 provider 提交前后 API/Worker 被杀 | 对 provider dispatch 的 before-send、请求已发但响应丢失、provider 已记账但本地尚未提交三个点分别注入；provider 是合成外部边界，但必须保存独立原单和请求哈希。 | 已派发操作保留占额且 status UNKNOWN；只查原 provider key，禁止新 key 重发；确定 provider 未受理后才可按规则终止/释放。接受或结算的原单最终最多入账一次。 | 重启后 provider 本地表可查询等于真实银行网络已恢复。 |
| 独立 Provider 已结算，本地核验/记账事务提交前数据库中断 | 使用应用库之外的独立 provider simulator/API，先持久化原单和双边分录，再在 app DB 写入 mirror credit、position consumption、action/audit 时故障。若仍用当前同 PG provider 表，此行只能作同库事务边界测试，不能模拟外部提交。 | 独立 provider 原单在 app DB 重启期间仍可查询；本地交易保持 UNKNOWN/可对账，不出现半个 mirror transaction；持仓占用保留；恢复后用同一 provider receipt 核验并原子落本地余额、分录和审计，恰一次。 | 当前同库 synthetic provider 结果等价真实银行在独立系统成功记账。 |
| 本地账务/状态已提交，HTTP 回复丢失 | 在本地交易 commit 后而 response 发送前杀 API；浏览器刷新或重放原请求。 | 读取原成功状态和原收据；唯一约束/幂等键阻止二次余额变化、借贷记录、授权消耗或成功审计。 | 页面没收到成功提示就等于交易未完成。 |
| 数据库重启后 Outbox/pg-boss 旧、新队列竞争 | PG 硬停/重启，API/Worker 按实际部署策略重启；保留已派发/未派发行和可重复投递 job。 | `sent_at` 与 queue job 状态可以收敛；重复任务不产生第二 provider key；UNKNOWN 继续查原单；所有成功终态都由 receipt 与账务对齐。无遗留连接/重复消费。 | 只重新启动 Worker 并发现健康响应等于数据库 crash recovery。 |

每个窗口都要报告“未提交 / 已提交 / commit 结果未知”三类而不是统一叫失败。附证据至少包含：具体故障注入点、PostgreSQL/应用进程退出与重启时间、重启前后 WAL/数据库日志摘要、API 返回状态、journal/outbox/provider/action 状态、金额与双边分录、重复重试次数、cleanup。确认 `UNKNOWN` 不释放占额且不能换单；确认已成功的本地/外部账务在超时后不重复执行。

适合复用的现有能力包括：G8H 受控 Worker fixture、PgBoss/outbox 实现、`tests/investment.integration.test.ts` 和 transfer/Core 幂等/UNKNOWN 回归、PostgreSQL 独立 schema 与账本快照工具。需要适配/新增的是真正控制独立 PostgreSQL 容器/连接的故障协调器和提交前/后屏障，以及对外部 provider 与本地 commit 窗口的独立记录。普通 Vitest rollback、mock throw、`TIMEOUT_AFTER_COMMIT` 应保留为单元边界，但不能替代真实 DB restart 故障证据。

## B. 清洁副本安装、启动与演示矩阵

“可复现”需标明所在层级。一次全新 checkout/容器只能证明该环境下的复现；不能自动推论任何空机器。

| 级别 | 最小过程 | 必须保存的证据 | 能支持的结论 |
|---|---|---|---|
| 干净源码副本 | 从精确 commit/冻结版本复制到新的目录或 clone；不复用现有工作区、运行数据库 volume、`.env`、`node_modules`、浏览器 profile、测试产物或共享服务。用 lockfile 安装依赖，记录 OS/CPU、Node、pnpm、Docker/Compose 版本和镜像 digest。 | commit/manifest SHA、干净目录基线、安装命令与 exit code、镜像 digest、禁止使用既有运行时/依赖缓存的说明或可核验记录。 | 该版本在列明的软件环境和依赖可安装。若仍使用原主机 Docker daemon/缓存，这不是空机器验证。 |
| 独立容器/数据库 | 为本轮设唯一 compose project、全新 volume、随机 schema/user/端口；只从 `.env.example` 构造新的本地 secret，不复制任何现有 `.env`、DB volume 或 auth 表。迁移、seed、health check，完成演示后核实所有专属容器/volume/schema/session 清除。 | `docker compose ps` 目标项目、容器/volume 标识、Postgres health/log、API/Worker health、随机 demo 身份和数据、前后 cleanup 清单。 | 独立容器环境可启动和清理。若宿主机仍预装 Docker/Node，不能称无依赖空机器。 |
| 完整产品演示 | 使用生成的新身份和虚拟/本机认证方式，从注册/登录开始演示六域导航、至少一条授权→执行→receipt、澄清与拒绝、UNKNOWN 原单恢复、刷新/重登；确认只有合成银行/商户。 | 固定演示脚本、浏览器版本、截图/trace 的私有存放政策、API/DB final states、业务动作与原始收据、运行退出与资源清理。 | 该限定环境可复现所列演示。受控 fixture 通过不等于云模型自然语言表现或生产认证通过。 |
| 空机器/交付介质 | 在没有预置 Node/pnpm/Docker、缓存、环境变量和工作区数据的独立虚拟机或实机上，从实际发布压缩包/提交物开始，按文档安装并演示；所有外部依赖均需明确安装或打包来源。 | VM/机器基线、发布物 SHA、安装时间线、完整命令输出、网络需求、没有宿主共享缓存的证据、演示及清理结果。 | 仅当该层实际跑完，才可称清洁机器/裁判机可复现。仓库说明或同机重启不够。 |

最低交付包安全检查：先采用 allowlist 构建 release，而非打包整个工作区；逐项检查归档内容和最终发布物哈希。不得包含 `.env` / `.env.*`（`.env.example` 例外）、云 API key、Better Auth secret、DB URL/密码、私有 session/cookie/local storage、持久化数据库 volume/dump、既有用户/会话/认证凭据、Playwright raw trace 或含登录网络内容的 HTML trace bundle。G8H 报告明确 raw trace 含临时登录网络内容、仅供本地复核，不能原样外发。`.gitignore` 排除 `.env`、`node_modules`、`dist`、`test-results` 和 `playwright-report` 是保护措施，不是最终 zip 的内容审计；仓库没有因此自动获得安全发布证明。发布前应检查归档路径清单并扫描敏感键名/已知 canary secret，不读取或复制工作区 `.env`。

README 示例账户是公开合成演示凭据，不应与当前演示数据库或真实认证状态一起交付。新建空数据库并重新 seed；不得复制现有演示数据目录或 `bankpilot` 持久 volume。报告复现步骤依赖 Node 24+、pnpm 11.25.0、Docker，当前说明提供的无 Node PATH 还是 Codex 工作机绝对路径；这仅方便同一工作站，不能证明其他机器可复现。`pnpm setup` 明确不会重置既有余额、动作或回执，所以必须证明所用 DB volume 是新建的。实时模型评测需要真实密钥，而默认干净安装应以无密钥 scripted/controlled 模式运行；密钥经专用安全输入注入，不放进包、日志或证据附件。

## 不能合并的验收声明

- 独立 PostgreSQL 容器或 G8H 隔离 schema ≠ 真实 DB 宕机/commit-unknown；后者必须见到真实 postmaster/连接中断、重启及 crash window 之后原单恢复。
- 同机 clean checkout/容器 ≠ 空机器；报告环境镜像、软件前置和共享缓存即可，不可省略。
- Chromium CTAP2 软件认证器及有效签名 ≠ 实体安全密钥、生物验证或生产身份认证。
- 固定模型 HTTP fixture、`cloudCalls=0` 的完整六域流程 ≠ 云模型语义准确率、真实模型质量或开放输入泛化。云质量需要明确真实云请求、模型/版本、预算、逐次调用、失败与冻结样本，独立报告业务评分。
- README、有启动指引、服务 health 200、构建通过 ≠ 发布包已清除 `.env`、cloud key、用户数据和 trace；只有对最终交付物本身做路径清单和内容审计，才能说明其安全范围。
- 截图、计划卡、provider mock 或单边分录 ≠ 成功交易；必须以原始 provider key、合法 receipt、双边分录、余额/占额和授权证明同时对齐。

## 当前复用判断

直接复用项目已有的 Vitest/Playwright、真实 PostgreSQL schema 隔离、pg-boss、G8H 清理 fixture、原单查询与资金双边分录验收；适配复用当前 `docker compose` 启动、Node/pnpm 锁定依赖和 G8H 最终受控浏览器流程，为新 project/volume 和清洁副本做隔离。数据库 hard-kill/commit-ack 屏障、最终归档 allowlist+secret scan、空机器交付证据仍需新增。无需为基本验收另加开源依赖；报告应分别列源码复现、容器复现、空机器交付、数据库故障和真实模型质量，不合并分数或结论。

## G8I 实现独立审查（只读）

审查范围为 `packages/core/src/database.ts`、Core/Finance/Investment/Management/Goals/Worker 的事务调用点、API pool error handler、`scripts/delivery/*.mjs`、Compose 配置、两套 Playwright 配置及 G8I clean-delivery spec。未运行数据库、浏览器、安装、测试或云请求，未读取 `.env`，未修改生产代码。

事务包装器在借出期间捕获 `PoolClient` 的异步 socket error，事务函数返回后会先检查连接错误再 COMMIT；错误路径不重试，并以 `release(error)` 交回断连连接。COMMIT 附近的错误会向调用方抛出未知结果，不会猜测回滚成功。各业务事务封装均使用该 helper；Goals 的 advisory lock 使用单独有限连接池，连接错误时跳过 unlock 并废弃连接。API pool idle-error handler 按 pool 去重监听，只记录受限错误码，正常 query 失败继续通过其 Promise 返回。代码未见静态 P1；提交确认丢失等实际故障覆盖须以独立 PostgreSQL 故障报告为准，不能由静态审查替代。

交付工具采用显式路径 allowlist、拒绝源路径 symlink、每个文件 SHA-256 manifest、仅新建导出目录、私有 state 目录与权限、随机项目/volume/端口/认证密钥、隔离 `.env`/Compose 环境、Compose project+instance 标签校验。stop 默认保留专属 volume，destroy 才删除；重启按同一 private state 复用项目和 volume。G8I Playwright 配置不加载工作区 `.env`，精确选中 opt-in spec；默认 Playwright 配置已忽略该 spec，避免未提供专用 state 时误跑。spec 直连由服务运行的独立端口及数据库，不 mock 应用请求；通过 runner PID 改变、PostgreSQL postmaster start time 前进、目标/收据/双边分录/余额重启前后相同来证明实际重启和持久化。此测试支持“列明本机环境中的清洁副本复现”，不支持空机器、实体 Passkey 或云质量结论。

此前指出的两个验证边界现已在代码中关闭。`verifyBundle(..., {allowGenerated:true})` 现在先 `lstat` 并拒绝 symlink，且仅允许真实目录作为生成目录跳过；交付测试新增 `node_modules`、`.local`、`apps/web/dist` 三种 symlink 反例和真实生成目录/文件校验。G8I E2E 现在要求 `BANKPILOT_G8I_SOURCE_DIR`，读取该副本 manifest，并在每个 case 核对 runtime 的 `sourceVerified`、`pristineExport`、manifest SHA-256、fileCount，以及实例 mode 与 URL；scope 附件也记录核验的 manifest hash。旧的 symlink 绕过和硬编码 scope 证据问题可标记关闭。此处只读审阅了修复实现，没有独立运行这些定向测试；14/14 结果来自主线程提供的测试记录，不能写成我方复跑结果。

本轮 source/manifest 关联断言显著增强副本来源可复核性，但对“空机器”或发布归档仍不构成证明：`BANKPILOT_G8I_SOURCE_DIR` 是测试输入，需结合实际运行命令和最终运行态证据确认它指向本轮导出的副本；导出 manifest 也不能代替对最终压缩包路径与内容的审计。

未发现交付脚本会导出 `.env`、测试证据、数据库 dump 或现有认证记录：源清单只含运行源码/锁文件/文档，随机 private state 在导出目录外；公开 state 不含密码或 auth secret。最终发布物仍须对实际归档做路径与内容审计，当前 exporter manifest 不能证明后续人工打包未另行加入敏感文件。浏览器 trace 的私有留存边界继续按 G8H 既有说明执行。
