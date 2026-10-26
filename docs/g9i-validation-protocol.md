# G9I 默认参数评测预登记

2026-10-25，在冻结及业务云端派发前登记。样本为已经暴露的 G9 已知 36 例和开发知情补充 12 例；本轮不是盲测。G9H 的首次报告、冻结副本、manifest 与三套评分保持历史原样，不回填 G9I。

## 候选与固定项

G9I 产品候选修复银行卡完整卡名与尾号的同位表达原文绑定，并以独立受控浏览器断言核对实际完成的查询卡片与当前命令一致、账单复核拒绝后的隐藏行为。产品改动与浏览器证据见 `docs/g9i-validation.md`。固定原 G9/G9E/G9G 三套评分器和标签、36 与 12 的输入及顺序、默认 provider 指纹（`reasoningEffort=omitted`）以及 `G9_LIMITS`：单例总时限 180 秒、provider 单次 60 秒、最多 2 attempts、最多 1 次结构修复、温度 0、语义阶段上限 4096、整例输出预算 32768；下游阶段继续由 `createStageOutputPlan` 动态分配，不能将所有调用称为 4096。不得因 G9H 账单质量全不可评而临时扩大预算或更改 schema/评分器。

`scripts/evaluate-g9i.ts` 使用受信 G9I profile 调用同一执行内核，独立 `evals/g9i-manifest.json`、`evals/baselines/g9i-*/source-manifest.json` 和 `evals/results/g9i/`。冻结 manifest 绑定源文件、协议、评测器、provider、两组 fixture 与三套标签。冻结后无运行中编辑；文件漂移或 provider 指纹变化使结果无效。G9I 不能使用 G9H 报告作为自己的已知组前置证据。

## 派发与证据门禁

唯一顺序是默认配置已知 36 例完整首次运行，再以同一 manifest 和源副本运行默认配置补充 12 例完整首次运行。每阶段先占用持久 first marker，逐例顺序执行；域阶段仍依生产并行。无自动整轮重试，不把截断、HTTP 成功或模型不可评当业务通过。质量组须独立复核 G9I 已知组 report、cases/attempts JSONL、semantic 和 bills 可见输出 sidecar、三套分数及来源绑定。

每个语义与账单结构输出 attempt 均须有绑定同一 attemptId、role、状态、长度和摘要的 sidecar 记录。G9I 另记录生产序列化请求的安全元数据：每 attempt 的 body/system/user/schema 长度和 SHA、schema 实际位置与包含情况、repair feedback 是否出现、max token、输出模式；不保存业务原文、key、headers 或隐藏推理。元数据必须在网络派发前可靠落盘，并与 attempt journal 一一闭合；缺失、重复、错配或持久化失败令该轮无效，不能据此进入质量组。`requestStarted` 的 attempt end 才表示已开始 HTTP 传输；只有预派发元数据不证明发出或服务端收到。若观察到 schema 未包含，应单列报告并判为请求契约异常，不能称结构约束合格。该观察接口不改变请求体、参数或重试预算。

报告分别列出原 G9、G9E、G9G 的可评分母、通过、不可评和失败原因，以及调用、账单截断、模型使用量和预算异常。原始业务分数不得用新协议分数覆盖。受控浏览器、G9I 正式评测和小样本 provider 诊断分别陈列；此前 2 次合成诊断均通过且未触发 repair，仅说明那两个请求的可见结果，不能证明上游稳定、不能代替 48 例业务评测或产品发布验收。G9H 与 G9I 是非同期运行，供应商状态和随机性可能变化；单次顺序比较不支持单因果结论。
