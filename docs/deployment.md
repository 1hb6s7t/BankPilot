# BankPilot 部署说明

版本：2026-10-28比赛提交候选。应用为本地合成银行原型，不连接真实银行。

## 环境

- Node.js 24或更新版本，pnpm 11.25.0。
- 可运行的Docker daemon和Docker Compose。
- 本机浏览器。强验证场景需浏览器与系统支持WebAuthn；受控自动化中的虚拟认证器不等于实体Passkey实测。
- 安装时需要获取npm依赖与PostgreSQL镜像。源码ZIP不包含依赖、数据库、登录状态或模型密钥。

## 开发与演示启动

克隆仓库或解压源码ZIP，在包含`package.json`的目录运行：

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

编辑本地`.env`，将`BETTER_AUTH_SECRET`设为至少32字符的随机值。保留模板中的本机数据库地址，确认5178、8787和55432端口可用。

```sh
pnpm db:up
pnpm setup
pnpm demo
```

打开http://localhost:5178，通过页面创建本地演示账号。终端显示的Web/API/Worker均应正常启动。`setup`仅用于本项目演示库，不要将`DATABASE_URL`改为其他业务数据库后执行。

`pnpm demo`启动API、Web和Worker，服务端修改后需手动重启；开发时可用`pnpm dev`。停止演示在启动终端按Ctrl+C。数据库常规停止使用`docker compose stop`，不会删除本项目卷中数据。

## 独立端口的隔离演示

已有实例或端口占用时，从完整源码根目录导出隔离运行副本：

```sh
node scripts/delivery/export.mjs --out ../bankpilot-demo/runtime-source
node scripts/delivery/verify.mjs --directory ../bankpilot-demo/runtime-source
cd ../bankpilot-demo/runtime-source
pnpm install --frozen-lockfile
node scripts/delivery/verify.mjs --directory . --installed
node scripts/delivery/prepare.mjs --state-dir ../state
node scripts/delivery/start.mjs --state-dir ../state
```

工具生成独立端口、专属数据库配置与私有状态，并输出实际访问地址。`prepare/start`依赖导出副本的`delivery-manifest.json`，不可跳过导出步骤。默认隔离演示采用受控模型。

停止该隔离实例：

```sh
node scripts/delivery/start.mjs --state-dir ../state --stop
```

只有明确需要删除该实例数据时，才对相同`state-dir`运行`--destroy`。这与普通停止不同。

## 可选真实云模型

在自己的本地配置中填写Base URL、模型名和API Key，Key仅保留在被Git忽略的`.env`或实例私有状态中。默认隔离测试不需要这些配置，也不会验证云服务权限或余额。

云模型受服务权限、输出质量、网络延迟与限流影响。历史已知8例回归不能代替接收方配置验证或云模型资金执行链验收。

## 接收方核对

1. 核对源码ZIP的SHA256及包内逐文件清单。
2. 安装冻结锁文件依赖，不从制作机器复制`node_modules`。
3. 按[测试说明](testing.md)执行隔离验证。
4. 启动合成演示，核对资金概览、确认卡与原单回执。
5. 记录实际系统、Node/pnpm版本、结果与限制。制作侧验证不代表Windows、生产环境或其他接收方已完成复现。
