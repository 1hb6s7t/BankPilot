# BankPilot 提交材料目录

此目录保存比赛提交候选材料。项目简介、技术文档、安全自评为Markdown；10页答辩PPTX与资金流程MP4已生成。PPT计划讲述530秒，尚待现场计时；视频结尾已更新并核验最终时长135.43秒。所有材料仍待最终核对，不能称为已正式提交。

## 材料清单

1. [项目简介](overview.md)：限200字，包含项目理念与AI技术。
2. [技术设计](technical-design.md)：架构图、核心算法、资金授权与数据安全边界。
3. [答辩PPT大纲](slides-outline.md)与[已生成PPTX](BankPilot-答辩稿-20261026.pptx)：10页，计划讲述时长530秒（8分50秒），待现场计时。
4. [视频脚本与实际四段时间线](video-script.md)及[已生成MP4](BankPilot-资金流程演示-20261026.mp4)：元数据时长135.43秒（2分15.43秒）。
5. [安全自评](security-self-assessment.md)：权限分级、源码依据、已知风险与尚未完成验证。

## 当前可供审阅的源码与证据

- 当前候选源码与测试包：`BankPilot-G9V-source-with-tests-20261026.zip`，逐文件清单为`submission-manifest.json`，SHA256由同名sidecar提供。独立源码副本已完成134文件、3420项测试、类型检查、构建和清理。
- 源码与测试接收方复验说明：[G9V源码测试交接](../../docs/g9v-source-test-handoff.md)。
- 项目入口与本机运行说明：[项目README](../../README.md)
- 源码候选验证：[G9Q报告](../../docs/g9q-lazy-chat-validation.md)
- 当前指定模型较早单场景证据：[G9U报告](../../docs/g9u-provider-validation.md)。
- 当前指定模型已知代表回归：[G9W结果](../../docs/evidence/g9w-live-2026-10-26T08-17-17-847Z-35671b23-ee10-48a3-8752-2cb233e8a97d/final.json)：固定已知8例8/8通过，20次真实请求全成功、零重试，usage输入48222/输出14556 tokens，无缺失。这不是盲测、长期稳定性验证或完整云到资金执行验收。G9V旧Key下8次HTTP403为历史记录，保留且不覆盖。
- 当前候选资金scripted证据：[G9V提交验收记录](../../docs/g9v-submission-validation.md)。资金流程与云模型回归是两类独立证据，不能合并称为云生成资金链通过。
- 既有资金与恢复证据：[G9N报告](../../docs/g9n-delivery-validation.md)、[G9L报告](../../docs/g9l-validation.md)。这些报告对应旧候选，不能当作当前G9Q同版通过证明。

## GitHub 与复现

用户已授权创建公开比赛仓库：[1hb6s7t/BankPilot](https://github.com/1hb6s7t/BankPilot)。源码发布版本与本地候选清单需核对一致；没有凭据被加入本目录。

项目README当前记载本机所需 Node.js、pnpm 与 Docker，以及初始化和启动步骤；其示例运行依赖本地合成数据库。G9Q报告记载同一开发工作机上的新副本安装、构建和浏览器检查。提交方仅凭最终交付材料进行的独立复现尚无记录，文档应在复现完成后补入实际系统版本、执行命令、结果与限制。

## 状态

- 文稿：已形成可审阅初稿，内容仍需项目负责人审核。
- 当前候选的G9V scripted资金流程：修正脚本后2/2通过，首次工具查询错误保留；不是首轮通过。虚拟WebAuthn，不代表实体Passkey。
- G9V旧Key下8次语义请求HTTP403、0项业务可评为历史记录，保留原样；不再代表当前Key结果。
- G9W当前Key验证：已知代表样本8/8，20次真实请求全成功、0重试，报告usage输入48222/输出14556，无缺失；不是盲测、长期验证或完整云到资金执行验收。
- PPTX、MP4：已生成；PPT结构和渲染检查、视频解码和画面抽查已完成；现场讲述与最终人工观看仍需复核，赛事材料尚未提交。
- GitHub地址：[1hb6s7t/BankPilot](https://github.com/1hb6s7t/BankPilot)，用户授权创建的公开比赛仓库。
- 最终源码与测试ZIP：按清单归档并提供SHA256；可从仓库获得源码和提交材料。
- 赛事门户提交：未见提交结果或回执；当前仅为提交候选材料。
- 截止日期：用户提供为2026-11-02。
