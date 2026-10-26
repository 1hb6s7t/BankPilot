# G8I 隔离源码交付与清洁副本复现

此工具交付最小运行源码，不打包现有`.env`、依赖、数据库、用户/会话、测试随机口令、历史评测、截图或trace。公共合成演示账号由原`setup.ts`创建，见下文；它不是任何真实银行凭据。`runtime-source-only`不包含测试与评测源码或历史证据，导出README由本文生成并在manifest注明origin，不能据此宣称完整比赛材料已提交。

## 前置条件与边界

- 接收机自行安装Node.js 24+、**pnpm 11.25.0**、Docker与Compose插件；工具不安装全局工具，不升级依赖。PostgreSQL使用原仓库固定17镜像digest。首次下载依赖/镜像需要网络，镜像与锁文件固定不代表离线包。
- 工具不读取工作区真实`.env`。API/setup/Worker使用显式私有JSON生成的进程环境；Vite使用空envDir；Compose显式指定本实例空env文件。默认scripted，不继承宿主模型配置。
- PostgreSQL是新容器与新命名卷，端口随机绑定127.0.0.1；API、Web也使用独立动态端口，拒绝55432/8787/5178。浏览器访问`http://localhost:<web>`，RP为localhost；独立cookie前缀避免同浏览器覆盖原实例会话。
- 本工具可复现的是已有Node/pnpm/Docker前置条件下的全新源码、全新依赖安装与全新数据库，不是空操作系统安装，也不是生产部署或真实银行/模型质量认证。

## 导出与安装

在原工作区运行（目标目录必须不存在，其父目录需存在）：

```sh
node scripts/delivery/export.mjs --out /tmp/bankpilot-clean-copy
node scripts/delivery/verify.mjs --directory /tmp/bankpilot-clean-copy
```

导出使用固定文件/目录allowlist，拒绝symlink和特殊文件，并记录每个文件的SHA256与字节数。verify检查清单与目录对应、必要运行入口及源码哈希；`delivery-manifest.json`本身的SHA256也由verify输出，可单独交接。清单依赖本地可信交接，只检查完整性，不是发布者签名、依赖闭包证明或真实性证明。只分发这份**安装前**的清洁导出，勿将安装后node_modules、私有状态或生成产物再整目录压缩。

在新副本使用独立store安装，严格保留锁文件：

```sh
cd /tmp/bankpilot-clean-copy
node --version
pnpm --version
pnpm install --frozen-lockfile --store-dir /tmp/bankpilot-clean-store
node scripts/delivery/verify.mjs --directory . --installed
pnpm typecheck
pnpm build
```

`--installed`只验证源码并明确允许生成的依赖/构建/本地状态目录；不表示该目录可以安全整包分发。package.json保留原仓库脚本便于对照锁文件，但本运行包只支持本文列出的交付命令、typecheck与build；test、eval、check、原dev/demo/db/setup等脚本不属于此profile，不应执行。运行包不含测试/scorer，不能在其中声称重跑全仓测试；独立的完整仓库验收记录须另行交付。

## 准备、启动与显式模式

```sh
node scripts/delivery/prepare.mjs --state-dir /tmp/bankpilot-clean-state
# Docker不在PATH时可追加 --docker /absolute/path/to/docker
node scripts/delivery/start.mjs --state-dir /tmp/bankpilot-clean-state
```

prepare拒绝覆盖现有目录，仅输出state路径、webUrl/apiUrl和mode。`private.json`为0600，含本次独立DB连接、随机认证secret、控制token和模型配置；不要提交、截图、附证据或输出该文件。`state.json`无密钥，ready后记录独立资源、Node版本、源码manifest摘要和子进程ID。启动直用原`setup.ts`、生产`main.ts`、原Worker及独立Vite配置，不复制业务服务；初始化不会重置同实例已有余额。控制台JSON `type=ready`或state.ready=true才表示页面代理与健康检查通过。

默认`private.json.mode="scripted"`；UI明确标注脚本验证。可选择编辑为`"model"`并填写本私有文件中`model.baseURL/name/apiKey`，三个字段必须全部非空，另可配置outputMode、timeoutMs及maxAttempts。缺配置/非法配置启动失败，不回退scripted；scripted忽略并清除宿主`BANKPILOT_MODEL_*`。模型模式的自然语言规划会访问用户明确配置的服务；提供配置入口不代表本轮云接入通过。直接表单操作不需要调用云模型。

登录`bankpilot@example.test`，密码`BankPilot-demo-2026!`（公开、仅合成演示）。使用新输出的localhost地址，不访问原5178。可先查看账单原流水与资金规则，再在生活目标表单准备目标和T+0资金来源；核对金额/日期，逐笔完成赎回Passkey授权、等待实际回执，再独立确认后继转账。卡片需要逐动作强验证；订阅查询必须单独确认，刷新后显式“查看已授权订阅”。期限不是自动付款许可，T+2预计到账不当现金。实体Passkey与Chromium软件认证器的验证证据应分开报告。

## 停止、重启与仅本实例清理

```sh
node scripts/delivery/start.mjs --state-dir /tmp/bankpilot-clean-state --stop
node scripts/delivery/start.mjs --state-dir /tmp/bankpilot-clean-state
# 最终确认不再需要此合成实例后：
node scripts/delivery/start.mjs --state-dir /tmp/bankpilot-clean-state --destroy
```

stop经本实例随机token的回环控制端点排空/停止自己创建的子进程，再执行显式compose项目down，**保留命名卷及private配置**供重启登录核对目标、余额与回执。destroy仅对绑定instanceId的项目/容器/卷执行down --volumes，事前核对Compose项目与自定义owner label；没有全局prune、没有默认compose down，不删除其他实例。不存在控制端点时不会按陈旧PID盲杀进程；失败状态必须查看state中的固定清理错误码，不可当清理成功。

destroy保留私有配置和无密钥state作为本地审计；如不再需要，单独删除自己创建的私有状态目录和独立依赖store。全新state与目标副本、store是否被删除由验收清理记录分别说明。停机不会撤销已成功合成交易，未完成状态与原回执保存在该实例DB中；只有显式destroy移除此实例数据卷。

## 本机复现的已验证范围

交付工具的14项无数据库定向测试已通过（`tests/g8i-delivery.test.ts`，仅完整仓库携带），验证导出/篡改/入口缺失/意外文件/符号链接拒绝、私有状态隔离与模式选择。这些检查与下面的实际运行分别计量。

2026-10-23，在已有Node 24.19.0、pnpm 11.25.0和Docker的macOS arm64主机上，首份清洁副本使用新的独立store下载257个包，冻结锁文件安装成功；交付校验加固后的副本重新创建node_modules，复用本轮刚建立的store。后者类型检查与构建通过，启动实际API、Worker、Web和独立PostgreSQL，浏览器分别完成初始业务与服务重启后的恢复检查（两次独立运行各1/1，retry=0）。

实际合成业务为强验证赎回1000元，到账后另外确认支付600.75元，余额8399.25元；卡片挂失/解挂与订阅查询、商户取消、银行拦截也经逐动作授权。停止后命名卷保留，重新启动的进程与PostgreSQL启动时间均改变，原目标、收据和余额保持，重复检查未重复记账。最终只清理本实例容器、卷和进程，动态端口关闭。本轮使用Chromium软件认证器和scripted模式，云模型生成调用为0。

完整仓库的G8I验收报告、失败轮次、冻结源码与原始证据单独保存，本运行包不包含它们。上述结果不代表空机器、其他操作系统、实体认证器、真实银行或真实云模型质量已通过，也不代表比赛材料已上传。完整的初始安装、实际业务、重启与清理证据需与本包清单哈希一起交接；后续接收机验证仍应记录自己的运行结果。
