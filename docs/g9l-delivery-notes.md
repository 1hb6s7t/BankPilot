# G9L 运行源码候选交付说明

2026-10-25。本轮准备供审查的运行源码目录，内容来自 G9K 冻结候选；**质量门槛未通过，候选未发布**。没有正式 release、上传或接收方验收结论。本文是目录外的当前版本说明，须与来源对应清单一起阅读。

## 来源与本次交付范围

- 当前候选：`evals/g9k-manifest.json`，SHA256 `d26da69d9576e3a5d3c7097a75e06acd2df9ab7be5aebdf5c572eeb3642158c3`。
- 316 文件冻结来源：`evals/baselines/g9k-candidate-2026-10-25T07-53-07-252Z/source-manifest.json`，SHA256 `b590d632d6cf3fe6c33a5e6f273d4f96e624f6251d6a6c5327713d9b191a44e3`。
- 新运行源码目录：`.local/g9l-runtime-source`；不是包含全部测试/评测的完整仓库。沿用现有 `runtime-source-only` allowlist，导出并校验 86 个源文件和 1 个 `delivery-manifest.json`。
- 外部来源清单：`docs/evidence/2026-10-25-g9l-delivery-source-map.json`；执行与验证证据：`docs/evidence/2026-10-25-g9l-delivery-verification.json`。以实际证据中的输出、目录清单和 SHA256 为准。
- 导出器仍把历史 `docs/g8i-clean-delivery.md` 复制为包内 `README.md`，在 manifest 中记录 origin。两份文件中的 G8I 实测描述保留其历史身份，**不代表本目录已重做 G8I 清洁安装、业务或重启验收**。本文未被悄悄插入运行目录，也没有修改旧包或冻结源码。

本轮只完成文档、源码导出和现有校验。没有安装依赖、typecheck/build 新副本、prepare、启动服务、数据库迁移、浏览器或云调用，也没有生成 ZIP 或上传。校验通过证明成员内容/入口符合本地 manifest，不能替代可运行性、来源签名、通用秘密检测或接收方验收。

## 当前业务证据与未验收范围

[G9K 结果说明](g9k-validation.md)记录了唯一一次完整已知 36 与开发知情补充 12：当前 G9G 评分分别 **16/36、9/12**，另有 **20、3 个不可评**，全部保留在分母。两组 validRun=true 只说明记录有效；23 个不可评最终均为 `MODEL_RESPONSE_JSON_INVALID`，其边界为外层响应 JSON 解析或对象格式无效。原始 HTTP 响应体未保存，不能进一步断言具体网关、空内容或模型语义原因。原 G9/G9E/G9G 三口径和历史报告保持不变。

独立一次真实模型订阅浏览器 **1/1 通过**，3 次 HTTP200，受控调用 0；覆盖查询授权前零模型派发、原用户消息接续、父/根/版本关联、原 query/cancel/block 三动作、分别授权、proof/actionHash、刷新重登与 UI 回执。本地合成商户取消和银行拦截分别生效，余额 8000 元保持，无新增转账或总账分录。证据为 `docs/evidence/g9g-isolated-test-2026-10-25T08-08-50-019Z-2c83a83a-fda6-4cab-99f5-b328a87660bb/browser/report.json` 及 [订阅独立审查](evidence/2026-10-25-g9k-subscription-independent-review.json)。该成功不证明本次导出目录已运行，也不证明转账 UNKNOWN、目标局部重规划或进程重启已取得同版云浏览器验收。

产品仍是合成银行/商户环境，涉及的是本地合成账本和操作；浏览器使用 Chromium 软件认证器。没有真实银行资金、真实商户或实体认证设备的验收。真正未见首测、有限负载与费用分析、当前包清洁安装/实际重启、接收方机器、正式录屏与平台提交仍各自待完成。G8I 历史 ZIP 及其同机清洁副本成绩不计为本轮新结果。

## 实际执行的导出与校验命令

在完整仓库根目录、Node.js 24+ 环境执行以下两条命令；目标目录必须事先不存在，不覆盖旧导出或私有状态：

```sh
node scripts/delivery/export.mjs --out .local/g9l-runtime-source
node scripts/delivery/verify.mjs --directory .local/g9l-runtime-source
```

导出白名单会复制公开 `.env.example`，不会读取工作区实际 `.env`。不要把当前 `.env`、模型密钥、用户/会话、数据库、依赖、私有实例状态、历史 trace 或测试附件放入运行目录。公开模板及安装说明中的合成演示配置不是真实凭据；接收方不得用于真实服务。后续根代理独立进行秘密和来源核验，本轮不把有限模式扫描称为绝对无秘密证明。

## 后续安装与启动命令（本轮未执行）

接收机需自行具备 Node.js 24+、pnpm 11.25.0、Docker 与 Compose；首次依赖/镜像获取需要网络。本目录不是离线包、系统安装器或生产部署。先核对外部来源清单和 `delivery-manifest.json` 哈希，然后在新副本执行：

```sh
cd <新运行源码目录>
pnpm install --frozen-lockfile --store-dir <新独立store目录>
node scripts/delivery/verify.mjs --directory . --installed
pnpm typecheck
pnpm build
node scripts/delivery/prepare.mjs --state-dir <全新私有state目录>
node scripts/delivery/start.mjs --state-dir <该私有state目录>
```

prepare 会创建含随机认证/数据库/控制配置的 0600 私有文件，不要把它附在日志、证据或交付包中。默认 scripted，清除宿主模型配置；model 模式需使用接收方自己的显式私有服务配置，缺配置不回退 scripted。现有 prepare 默认 provider timeout 45 秒/2 attempts，并不等于 G9K 正式质量评测的 60 秒/2 attempts/temperature 0，也不等于其订阅 live 的 60 秒/1 attempt 配置。未另行验证前不能将任一种运行结果互相替代。

ready 状态才表示服务健康检查通过。使用输出的 localhost 动态端口及独立 cookie，避免原演示端口。运行包只承诺安装说明列出的交付命令、typecheck/build，不包含完整仓库 tests/evals；不要在包内用缺失脚本声称完成全仓回归。

分别授权每个动作；查询许可不是取消/拦截许可，赎回或期限也不是自动付款许可。旧安装说明的公共演示账号仅服务于合成沙箱。停止/重启/最终清理复用原命令：

```sh
node scripts/delivery/start.mjs --state-dir <该私有state目录> --stop
node scripts/delivery/start.mjs --state-dir <该私有state目录>
node scripts/delivery/start.mjs --state-dir <该私有state目录> --destroy
```

stop 保留实例数据卷供重启核对；destroy 仅清理绑定实例。后续验收必须实际记录原回执/状态、进程与 PostgreSQL 启动变化、无重复操作和实例清理，再分别说明源码、依赖 store 与私有配置是否保留。同机新副本与接收方新机器应各留自己的证据；本说明及源码目录均不构成这些步骤已通过的声明。
