# G9K 默认参数完整复验预登记

2026-10-25，冻结与正式云端派发前登记。G9K 对已经暴露的 G9 已知 36 例与开发知情补充 12 例作一次完整复验，不是盲测。G9、G9E、G9G、G9H、G9I 的冻结文件、报告和历史结论不回填。

## 候选来源与固定项

G9K 候选是 G9J 展示路径修复后的产品版本。G9J 源码快照 `docs/evidence/2026-10-25-g9j-source-snapshot.json` 记录相对 G9I 正式 manifest 的 310 文件及改动；本轮 G9K source manifest 必须以 `evals/g9i-manifest.json` 为 `previousManifest`。G9K manifest 须绑定两者的实际 SHA，并要求当前 `apps/`、`packages/` 的 69 个产品文件与 G9J 快照逐项一致。新增评测入口、协议和纯测试可进入新 source 副本，但不得借复验修改冻结后的产品。展示路径改动和模型兼容能力应分别陈述，不能称新语义修复或预设质量提升。

固定 G9 已知与 G9C 补充 fixture 的输入、标签、顺序，原 G9、历史 G9E 和当前 G9G 三套评分器及各自分母。当前质量结论以 G9G 契约为准；原两套评分并列展示，不合并或重算历史报告。固定 G9I manifest 的 provider 指纹与默认 `json_object` 输出模式，不因 G9J 诊断改用 tools；`reasoningEffort` 仍 omitted。固定 `G9_LIMITS`：每例 180 秒，单次 provider 60 秒，最多 2 attempts、1 次结构修复、温度 0、语义阶段上限 4096 tokens、整例输出预算 32768 tokens；下游阶段由 `createStageOutputPlan` 分配。模型、密钥、schema、prompt、修复次数和业务预算均不可在本轮临时变更。

G9J 的 tools/json_object 合成诊断在当前服务上对两个只读输入各条件 2/2，只有 8 次调用。该证据不替代 48 例质量复验，也不证明模式优越、服务端稳定或发布可用。G9K 与 G9I 非同期，模型随机性与供应商后台变化可能影响结果；即使代码差异受控，单次顺序运行也不能作单因果归因。

## 顺序、门禁与证据

先用独立 `evals/g9k-manifest.json`、`evals/baselines/g9k-*/source-manifest.json` 和 `evals/results/g9k/` 冻结，然后仅运行一次 default-known 36 例；已知组完整且证据有效后，以同一 manifest 与源副本仅运行一次 default-quality 12 例。每组在网络前排他写入含 manifest hash 的 `.first.json`，逐例顺序执行；每例领域阶段沿用生产并行图。不可把 G9I 或其他版本的已知报告充作 G9K quality 前置证据，不自动补跑失败例或整组，不覆盖结果目录。

沿用 G9H/G9I 共享执行内核与生产 Planner。每个 attempt 必须有持久化 start/end；语义和账单的可见结构输出分别保存有界 sidecar，并逐条核对 attemptId、role、status、长度、摘要。显式 `requestEvidence=required` 的可信 G9K profile 也必须保存生产序列化请求的预派发安全元数据（body/system/user/schema SHA 与字节数、schema 位置与包含状态、repair feedback、输出模式、max token），对所有实际发出的 attempt 一一闭合；允许明确记录准备后因期限未派发的 attempt。缺失、重复、错绑、schema 不在请求中、observer 持久化失败或源码漂移均令该轮无效，不能进入 quality。请求 metadata 不含业务原文、key、headers 或隐藏推理，也不单独证明服务端实际处理了相应 system/schema。

报告必须分别列出三套评分的通过、业务失败、不可评与原始分母，以及 HTTP/attempt、usage、截断、预算和证据闭合状态。`validRun=true` 只说明本轮记录完整可评；只要有任何业务失败或不可评，就不能称 48 例质量通过，更不能发布。即使当前 G9G 口径达到 36/36 与 12/12、全部可评，也只允许推进下一验收步骤，不等于整体目标完成。受控浏览器、真实浏览器与本轮模型复验各自记录，不互相代替。
