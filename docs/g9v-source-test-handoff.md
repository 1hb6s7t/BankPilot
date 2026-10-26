# G9V 完整源码与测试包：接收方部署/复验交接

## 包内容与状态

交付文件名为 `BankPilot-G9V-source-with-tests-20261026.zip`，配套SHA256文件。公开仓库：[1hb6s7t/BankPilot](https://github.com/1hb6s7t/BankPilot)。包内为当前源码、测试与必要历史测试依赖，并附技术文档、候选PPT和MP4；历史全部评测数据、私有配置、依赖目录和数据库不随包分发。

独立范围审查首先列出519项，加入本说明后520项源码在独立目录安装新依赖和新store，类型检查、134文件3420项测试、构建均通过。最终归档随后增加本轮报告、证据和材料，以根目录 `submission-manifest.json` 的逐文件清单为准。打包后另行解压核对哈希；未重复声称在ZIP解压后重跑测试。

包内保留仓库原目录结构：应用在 `apps/`，业务与Agent在 `packages/`，测试在 `tests/`，提交材料在 `artifacts/submission/`。材料没有放入 `delivery/`，因此不会影响仅允许运行源码的既有导出工具。部分历史文档引用未分发的完整历史证据；这些链接不应当作当前候选新增通过证明。

比赛截止由用户确认为2026-11-02；GitHub发布、候选归档和赛事门户提交是不同步骤，目前没有门户提交回执。

## 接收方环境

完整源码测试包建议使用：

- Node.js 24或更新版本。
- pnpm 11.25.0。
- Docker daemon和Docker Compose。
- 固定隔离测试数据库使用`127.0.0.1:55432`。确认该端口可用；不要连接或重置其他项目的数据库。

首次依赖安装可能需要网络获取包和容器镜像，因此这是可复验源码包，不是离线安装器。

## 从清洁解压目录安装和复验

1. 将ZIP解压到新的、独立的工作目录。不要从原仓库目录或其`node_modules`继承依赖；在解压后含`package.json`的仓库根目录执行下列步骤。
2. 安装锁定的依赖：

   ```sh
   pnpm install --frozen-lockfile
   ```

3. 在接收方机器启动本项目的隔离测试数据库：

   ```sh
   pnpm db:up
   ```

4. 运行完整隔离验证：

   ```sh
   pnpm test:isolated
   ```

根据范围审查，该入口运行`pnpm check`所含的类型检查、全部Vitest测试和构建，并为执行创建随机拥有的测试数据库。入口默认剥离云凭据，且不读取`.env`，不调用云端模型。不要用裸`pnpm test`替代它：数据库集成测试需要显式绑定隔离测试数据库。

本机独立源码副本已实际运行该入口：134文件3420项测试通过、0失败、0跳过，Vitest部分88.87秒，类型检查和构建通过，整体退出0。专属测试数据库已按OID和owner核验删除。详见[源码副本验证](evidence/2026-10-26-g9v-source-test-verification.json)。

## 可选浏览器复验

在完整隔离检查之后，可单独安装Chromium并运行浏览器扩展：

```sh
pnpm exec playwright install chromium
pnpm test:isolated --browser
```

把该扩展的结果单独记录为浏览器证据；不得将浏览器scripted结果称为真实云模型业务验收或真实银行交易。若使用已指定模型的云服务验证，应使用接收方自己的本地配置，单列真实调用样本和实际费用；该结果不属于`pnpm test:isolated`通过的含义。

## 单独启动合成资金演示

如果需要让接收方交互查看本地合成演示，使用仓库已有的runtime导出、隔离实例准备和启动工具。该路径分配独立动态端口、私有状态目录和数据库；不要对接收方机器上的其他项目数据库执行`pnpm setup`。

以下示例假设完整源码已解压到`/tmp/bankpilot-g9v-source/BankPilot/`。先从该完整源码目录导出runtime副本并核对清单，再进入导出副本安装依赖、验证已安装状态，最后从该副本准备和启动隔离实例。`delivery:prepare`和`delivery:start`依赖导出包内的`delivery-manifest.json`，不要从完整源码根目录直接启动：

```sh
mkdir -p /tmp/bankpilot-g9v-demo
cd /tmp/bankpilot-g9v-source/source
node scripts/delivery/export.mjs --out /tmp/bankpilot-g9v-demo/runtime-source
node scripts/delivery/verify.mjs --directory /tmp/bankpilot-g9v-demo/runtime-source
cd /tmp/bankpilot-g9v-demo/runtime-source
pnpm install --frozen-lockfile
node scripts/delivery/verify.mjs --directory . --installed
node scripts/delivery/prepare.mjs --state-dir /tmp/bankpilot-g9v-demo/state
node scripts/delivery/start.mjs --state-dir /tmp/bankpilot-g9v-demo/state
```

保存工具实际选取的动态端口和报告位置；仅在隔离演示需要时使用。结束后使用同一state目录停止并销毁隔离实例：

```sh
node scripts/delivery/start.mjs --state-dir /tmp/bankpilot-g9v-demo/state --stop
node scripts/delivery/start.mjs --state-dir /tmp/bankpilot-g9v-demo/state --destroy
```

此独立演示使用本地合成数据。G9V既有资金场景采用scripted Planner/provider与虚拟WebAuthn；不调用云端模型，不是真实银行或实体Passkey验收。完整测试包中的隔离测试和runtime演示应分开报告。

## 已记录结果

- 独立测试目录：系统临时目录中的新源码副本，不在原仓库祖先依赖目录下；520项文件在测试前后逐条哈希一致。
- 环境：同一开发Mac，Node.js 24.19.0、pnpm 11.25.0，已有Docker和PostgreSQL前置条件。
- 依赖安装：新的独立store，冻结锁文件安装成功。
- `pnpm test:isolated`：类型检查、134文件3420项测试和构建通过，退出0；随机专属库已清理。
- 本轮没有运行可选浏览器扩展。G9V资金和录制使用另一个独立实例，实测2/2与录制2/2分别记录，不与本套测试合并计数。
- 最终包：逐文件清单为 `submission-manifest.json`，ZIP校验值保存在同名 `.sha256` 文件。接收方应自行核验下载文件。
- GitHub：[1hb6s7t/BankPilot](https://github.com/1hb6s7t/BankPilot)。
- 赛事提交：尚无提交回执；接收方复现与现场讲述计时仍待进行。

## 证据边界

完整源码包安装、全量隔离测试或scripted资金演示通过，只证明相应结果在记录的那台接收机器和那次配置下发生。它们不等于另一家接收方已独立复现、Windows兼容、生产部署就绪、云模型质量通过或真实银行资金交易验收。每种证据应按实际执行对象、模式、版本和结果分别记录。
