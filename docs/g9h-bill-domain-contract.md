# G9H 账单领域紧凑核对契约

2026-10-25，本文件记录新的产品候选；不改写 G9G 冻结源码、输入、标签、评分或真实结果。

G9G `g9-card-06` 的语义抽取与 G9E 逐字相同，卡片分支成功，账单分支两轮均以 HTTP 200、`finishReason=length`、4096 输出 token 截断，整例不可评。账单失败正文没有保存，不能断言它实际重复了哪些内容，也不能把截断归因为某一提示或隐藏推理。原接口要求模型输出 `summary/findings/evidence.detail`，随后又用服务器结果整体替换，仅将模型摘要追加为公开 `model-explanation:bills`，而 reviewer 会过滤该摘要。这些自由输出既不决定账单事实，又增加输出与错误事实文案的表面。新的契约移除这层自由重写，保留独立的领域判断。

账单 Agent 必须返回平铺、严格结构：

```ts
{
  role: 'bills';
  planVersion: number;
  queryAligned: boolean;
  assessment: 'consistent' | 'partial_data' | 'missing_data' | 'unsupported';
  evidenceSources: string[];
  concerns: Array<'period_mismatch' | 'filter_mismatch' | 'statistic_mismatch'
    | 'evidence_mismatch' | 'unresolved_query' | 'additional_review_required'>;
}
```

没有金额、商户自由文案、`summary/findings/evidence.detail`、`clarification` 或动作字段。未知字段直接拒绝，生产 provider、domain adapter、单次联合输出及显式脚本模式使用同一结构；旧账单自由提案不能成为成功回退。`assessment` 与证据引用复用现有 `validateBillReviewAssessment`：缺失和部分数据不能宣称完整，引用须来自当前 analysis、不得重复，现有证据非空时至少引用一条。引用最多64条，顾虑最多8条且不重复。模型选取的引用不会缩减服务器保存、展示的完整流水和证据。

领域模型核对已提供的完整账单子请求、所有期间、商户/类别字面条件、统计口径、最大值并列、展示要求及覆盖状态。生产存在唯一已校验账单 task 时，`data.originalRequest` 仅为其完整 `task.source.text`，并保留 `semanticRequest` 元数据；不将其他领域收款人、原文或目录放入账单上下文。`data.analysis` 保留确定性答案，`data.billFacts` 提供已接受的结构化事实和来源。semantic validator 原有同域约束仍拒绝多条 bills task；上下文构建另对异常 server handoff 的多条账单任务显式拒绝，不能静默 `.find` 丢项。legacy `semantic:false` 没有精确范围时省略原文字段，并说明只依据所给 analysis 核对事实，不能冒称独立核对了完整原问题。完整用户原文及跨域遗漏继续由总控与独立 reviewer 核对。

领域判断具有实际否决效果：`queryAligned=false` 或任何固定顾虑都会拒绝展示账单答案，不能由随后确定性渲染抹掉，也不能被 reviewer 的 `approved=true` 覆盖。否决本身是合法结构判断，保留后续独立 reviewer 调用；未知格式或篡改事实则仍作为领域契约失败处理。reviewer 使用自己的调用、原问题及确定性事实继续核对并保留拒绝权，同时接收领域判断作为可审计证据，不强制批准。领域通过也不能覆盖 reviewer 的否决。

完整/部分答案被任一账单核对门禁拒绝时，三种编排 `single/parallel/parallel-review` 都移除公开 `billAnalysis/billReport/billReports`、金额与流水证据，并以固定安全文案替换摘要及账单完成事件；缺失和不支持保留真实诊断，不能将未知当零。没有公开自由的 `model-explanation:bills`。独立审查另外实证：其他领域自由摘要仍可能在 `model-explanation:card` 等旁路包含被拒绝的账单细节。因此共同拒绝出口对所有领域统一剔除 `model-explanation:*`，完整保留其他服务器事实证据；该规则依据来源类型，不按商户、金额或敏感词匹配，也不限定某种编排。该共同门禁不会让其他领域的拒绝自动抹掉已经独立对齐的账单事实，也不会因账单通过而授权其他动作。

恢复状态持久化 `billDomainAssessment`、`billDomainApproved`、`billDomainBinding`。绑定包含当前范围、事实、版本及编排；恢复时重新校验 typed wire、通过布尔值及唯一服务器渲染的账单提案。账单 domain 使用 `g9h-bill-domain-v1`，包含账单的 joint 使用 `g9h-bill-joint-v1`，包含账单的 reviewer 使用 `g9h-bill-review-v1`，其绑定也包含领域判断。最终输出重复核对域与复核绑定，旧 stage cache 或旧 graph 缺少有效 attestation 均拒绝复用。API graph 版本由根代理同步升级；planner 内部门禁独立存在，不仅依赖 API 版本。

本改动不改变账单 parser、查询支持范围、partial/unknown 定义、provider 参数、每阶段尝试和结构修复次数、32768 总请求输出预算、60秒 provider 超时、180秒 case 截止或评分器。小结构降低可见输出要求，不能保证隐藏推理用量或真实模型必然不再截断；必须以新候选冻结后的独立真实运行验证，原 G9G 不可评记录继续保留。

纯测试由 `g9h-bill-domain-assessment.test.ts` 覆盖严格字段、身份/版本、引用、完整/部分/缺失/不支持、真实零、独立双方否决、上下文与旧结构拒绝；`g9h-bill-domain-integration.test.ts` 由另一代理独立覆盖多编排、受控 provider 与恢复。自动化与受控传输不是云模型或数据库业务验收，最终数量由验证证据单独记录。
