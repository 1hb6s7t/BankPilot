# G9N 当前副本的现金目标、管理授权和重启恢复

2026-10-25。上一轮G9M新GLM服务单请求HTTP502，当前不追加云调用。继续完整项目目标中的本地交付复现：复用G9L已安装、已验证的运行源码副本，创建全新隔离数据库与服务实例。不是再一次空机器安装，不覆盖G9L完整INITIAL失败，也不改变旧冻结清单。

## 登记范围与分工

流程Agent（GPT-6.1-sol/high）编写独立G9N浏览器验收；独立审查Agent（GPT-6.1-sol/xhigh）检查授权、金额、实际到账日期与恢复身份；交付Agent（GPT-6-sol/high）检查现有导出副本与运行工具复用条件。根负责隔离环境、真实浏览器、重启与最终证据。产品仍是总控、六领域与独立复核架构；本次运行明确为scripted模式，真实云调用为0。

复用`.local/g9l-installed-copy`，运行源manifest SHA256为`5a0515d2626686f26846d97a331d36427252ff670b3a02fc36bbd3368a0423f7`。G9N使用独立`.local/g9n-delivery-state`和新容器/卷，随机端口；原演示5178/8787及55432业务库不启动或迁移。根已取得[原库前置只读摘要](evidence/2026-10-25-g9n-runtime-before.json)，49表97命令相对G9M保持。

## 验收契约

1. 现金目标600.75元：准备不扣款；独立确认后真实合成提供方成功、回执和双边分录各自闭合，8000元余额减少到7399.25元；原授权和目标身份可恢复。
2. 卡片挂失与解挂分别强验证；订阅查询、商户取消和银行拦截分别确认。检查五个独立管理授权及最终业务状态，区分商户取消与银行拦截。
3. 另一个不同金额的筹资目标通过独立强验证赎回1000元。按真实acceptedAt/dueAt判断：尚未到期必须保留SETTLING与持仓占额，不产生到账回执或后继付款；实际已到期只认可提供方真实成功和分录，不强制结算、不改时钟。
4. 真正停止并启动API、Worker、Web及PostgreSQL后，检查原现金付款、原筹资动作、提供方标识、授权与余额。允许跨越真实到期后的合法单次结算，但不得重复提交或自动确认筹资目标付款。
5. 浏览器刷新、重登和窄屏显示与数据库事实一致；保留失败、源码与环境绑定，完成后清理本实例并比对原库。

现金完整付款与筹资等待分别报告。G8I原“赎回到账后另授权付款”完整链没有因此通过，接收方机器、云模型质量与正式比赛交付仍欠证据。

## 执行结果

首次[INITIAL](evidence/g9n-delivery-initial/report.json)为0/1：600.75元现金付款和Passkey注册实际成功，但测试的全局`getByRole('status')`同时匹配连接提示和管理注册提示，触发严格选择器错误。初版spec另存`.local/g9n-clean-delivery.initial-spec.ts`，绑定SHA `310463fd3895a7628b2d4566ba3f423762a7c27e045ec686473db48b23e05587`；失败和截图保留。仅将选择器限定到`.management-success[role="status"]`，没有改产品或业务断言。初实例销毁后，创建全新R2实例从零复验。

[R2 INITIAL](evidence/g9n-delivery-initial-r2/report.json)1/1通过，测试5051ms；实际现金余额739925分，唯一60075分转账、两条提供方分录和一个CONFIRMATION proof；五个管理动作各有独立proof，卡片最终ACTIVE、商户取消与银行拦截分开保持。另一个30025分目标的100000分赎回已强验证，实际分支为`PENDING_REAL_SETTLEMENT`：SETTLING、持仓占额100000分，预计`2026-10-26T09:20:58.937Z`到账，无赎回分录或后继付款。周日到周一的日期与合成日历一致。

随后真正停止API/Worker/Web及PostgreSQL，保留R2数据卷，再启动同一实例。[停止状态](evidence/2026-10-25-g9n-r2-stopped-state.json)和启动日志保留。首次[RESTORED R2](evidence/g9n-delivery-restored-r2/report.json)0/1发生在数据库与原回执恢复断言已通过之后：切到390宽窄屏后，测试仍直接点击视口外的侧栏导航，遗漏“打开导航菜单”。只在`selectGoal`增加正常菜单操作，未force点击、放宽断言或修改银行状态；旧R2 spec保留为`.local/g9n-clean-delivery.r2-spec.ts`。

对同一原实例、原marker和原单执行只读[RESTORED R3](evidence/g9n-delivery-restored-r3/report.json)，1/1通过，测试1796ms。启动器/API/Worker/Web PID及PG启动时间实际改变，原现金action/receipt/provider key、分录、proof与五个管理动作保持；赎回仍是同一SETTLING原单、同一到账日期与占额，余额仍739925分。没有重建目标或重新授权；第一次恢复失败并未被覆盖或合并成无失败的单轮。

根实际查看两张390宽恢复截图：现金目标显示600.75元完成和原回执，筹资目标显示1000元未到账、10/26 17:20预计到账以及等待中的后继步骤，无付款确认按钮。窄屏无横向溢出。此次仅观察pending分支，工作日立即结算和跨真实due到期分支的代码断言未实测，不称已验证。

## 新发现的显示缺口

根查看首次现金完成截图时发现：完成状态与成功回执正确，但卡片notice仍保留“原转账单当前状态：已授权，等待执行。”独审确认`GoalsPage.tsx`把确认接口即时返回状态保存为本地字符串，后续同action.id的状态轮询更新props却未更新该字符串；重新挂载后旧提示消失。这是当前包的实际显示缺口，尚未修复；未发现它改变执行状态或造成重复扣款。后续应修正状态提示随原动作变化，不能以此次资金及恢复验收通过代替体验修复。

## 清理与证据边界

首实例及R2实例均已destroy，[首实例清理](evidence/2026-10-25-g9n-initial-final-state.json)与[R2清理](evidence/2026-10-25-g9n-r2-final-state.json)均记录子进程退出、容器和卷移除、errors为空。原库[最终只读核对](evidence/2026-10-25-g9n-runtime-final.json)49表97命令与前置摘要一致。原GLM配置未变，本阶段没有云调用。

[最终独立审查](evidence/2026-10-25-g9n-independent-review.json)核对两份通过与两份失败报告、附件原action/receipt/proof/ledger、pending原单及清理记录；原现金成功以API动作附件与实际UI/API断言为依据，不将数据库goal.state中的准备快照当成最终状态。[根实际看图记录](evidence/2026-10-25-g9n-root-visual-review.json)保留初始旧notice与恢复两图的观察。[完整性检查](evidence/2026-10-25-g9n-final-integrity.json)确认316源无漂移、当时49个输出文件对配置Key无匹配，原演示及两实例共10个端口均未监听；最终审查文件随后独立封存，未读取.env。

只改新增G9N验收脚本、报告及本地计划说明；产品和旧316文件冻结清单未改。首次verify命令误用参数返回错误，改用工具实际支持的`--directory ... --installed`后源码校验通过；它是命令调用修正，不算业务测试。测试修正后的结果各自记录，仍不是完整G8I筹资付款链、外部接收方、真实硬件Passkey、模型质量或正式发布验收。
