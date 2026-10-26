# 第三方组件记录

本项目为比赛合成银行原型。以下为本次实际安装的直接依赖及其 package.json 元数据，不代表原项目已为 BankPilot 的业务正确性背书。完整依赖树固定于 pnpm-lock.yaml；各软件包中附带的 LICENSE、NOTICE 和版权声明保持原样。PostgreSQL 17 使用 PostgreSQL License，参见 [官方许可证](https://www.postgresql.org/about/licence/)。

| 组件 | 固定版本 | 声明许可证 | 来源 |
|---|---|---|---|
| @assistant-ui/react | 0.15.30 | MIT | [项目来源](https://github.com/assistant-ui/assistant-ui) |
| @hono/node-server | 2.1.5 | MIT | [项目来源](https://github.com/honojs/node-server) |
| @langchain/core | 1.2.20 | MIT | [项目来源](git@github.com:langchain-ai/langchainjs) |
| @langchain/langgraph | 1.5.2 | MIT | [项目来源](ssh://git@github.com/langchain-ai/langgraphjs) |
| @langchain/langgraph-checkpoint-postgres | 1.1.2 | MIT | [项目来源](ssh://git@github.com/langchain-ai/langgraphjs) |
| @simplewebauthn/browser | 14.0.0 | MIT | [项目来源](https://github.com/MasterKale/SimpleWebAuthn) |
| @simplewebauthn/server | 14.0.3 | MIT | [项目来源](https://github.com/MasterKale/SimpleWebAuthn) |
| better-auth | 1.7.12 | MIT | [项目来源](https://github.com/better-auth/better-auth) |
| hono | 4.13.13 | MIT | [项目来源](https://github.com/honojs/hono) |
| lucide-react | 1.61.0 | ISC | [项目来源](https://github.com/lucide-icons/lucide) |
| pg | 8.23.1 | MIT | [项目来源](https://github.com/brianc/node-postgres) |
| pg-boss | 12.38.0 | MIT | [项目来源](https://github.com/timgit/pg-boss) |
| react | ^19.3.1 | MIT | [项目来源](https://github.com/react/react) |
| react-dom | ^19.3.1 | MIT | [项目来源](https://github.com/react/react) |
| zod | 4.6.7 | MIT | [项目来源](https://github.com/colinhacks/zod) |
| @playwright/test | 1.64.1 | Apache-2.0 | [项目来源](https://github.com/microsoft/playwright) |
| @types/node | 26.6.5 | MIT | [项目来源](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| @types/pg | 8.23.1 | MIT | [项目来源](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| @types/react | 19.3.0 | MIT | [项目来源](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| @types/react-dom | 19.3.0 | MIT | [项目来源](https://github.com/DefinitelyTyped/DefinitelyTyped) |
| @vitejs/plugin-react | 6.1.2 | MIT | [项目来源](https://github.com/vitejs/vite-plugin-react) |
| concurrently | 10.0.6 | MIT | [项目来源](https://github.com/open-cli-tools/concurrently) |
| tsx | 4.23.15 | MIT | [项目来源](privatenumber/tsx) |
| typescript | 7.0.2 | Apache-2.0 | [项目来源](https://github.com/microsoft/TypeScript) |
| vite | 8.3.5 | MIT | [项目来源](https://github.com/vitejs/vite) |
| vitest | 5.0.5 | MIT | [项目来源](https://github.com/vitest-dev/vitest) |

未复制 Actual、Fineract、TigerBeetle 等参考项目的业务源码；相关调研材料只用于模块选择和设计比较。若后续复制原项目源码，应同时保留该源码附带的许可证和版权头。
