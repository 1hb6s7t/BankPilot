# G9Q 聊天界面按需加载与恢复验证

2026-10-25。基于G9P实际首屏227027字节gzip主JS基线，将ConversationsPanel静态导入改为模块级React.lazy，局部Suspense复用现有加载样式；原owner/session key、props、认证/授权/恢复逻辑保持，加载失败沿用全局ErrorBoundary与用户刷新。仅App.tsx变更，不增加运行依赖。

## 运行前协议

先新导出86运行源、新安装副本离线安装，实际build。生产预览与隔离API使用合法相同Web Origin；测试wrapper复用原delivery生命周期，只替换web子进程为production preview，不改变产品delivery工具、源码manifest或认证可信Origin。全新scripted数据库，不读原演示库运行服务，不调用云。

首屏复用G9P同一测量脚本，另外target与证据目录；5个新context、同样viewport/禁缓存，无CPU网络限速。比较实际初始响应体字节与原G9P，5次本机时延只报告样本，不把两个时点/hostname条件的差异作为因果提速证据。

浏览器验收使用实际登录/API/生产chunk：匿名不加载聊天chunk、登录后加载；一次安全查询生成原聊天，切换会话与重登恢复原消息，发送POST不得重复；新context阻断chunk后全局错误可见，解除后用户刷新恢复且无业务重发；慢chunk期间退出后释放不得挂载旧会话。截图由根实际查看。失败原样保留，不改历史结果。

实现Agent只改App.tsx；工具Agent只写浏览器用例；独立审查Agent检查会话/失败边界与验收断言；根负责源码对比、安装构建、实际运行与证据整合。初始构建已由单787529字节主JS拆成约408.61kB入口和380.94kB聊天chunk，没有单chunk超过500kB警告；实际浏览器字节及恢复结果见下文。

## 首屏实测与定向检查

全仓类型检查通过；现有聊天状态、历史、分页、dashboard协调与恢复纯测5文件102/102通过。新安装副本production build通过，入口408612字节，独立聊天模块380947字节，无500kB单块警告。仅App.tsx相对G9O改变，运行manifest为63258314b0e77b5f557ff8c9477fa7198dd14f6e7f205e99f477dc18b02411dd。

复用未修改G9P首屏采集器，在新生产服务5次全新context全部有效，匿名只请求index-CXYXAbec.js，不请求ConversationsPanel-CFsVZwYk.js。主JS实际gzip响应体118328字节，比旧227027减少108699字节（47.88%）；解码后408612，比旧787529减少378917字节（48.11%）。这是未登录初始JS下载量改善，完整登录后的总代码不因此减少，代码拆分存在少量总量开销。

登录DOM就绪原值88.5/49.7/48.6/43.4/48.3ms，中位48.6ms、范围43.4–88.5ms；原G9P中位59.6ms。两轮均本机5样本，服务端口/hostname与运行时点不同，不据此宣称稳定延迟改善百分比。实际gzip响应体与构建gzip估算119.20kB分别保留。浏览器恢复与异常流程已按下列固定协议完成。

## 真实浏览器结果

唯一首轮1/1通过，用例3939ms、套件4399ms，0重试。真实production预览+隔离API/Worker/PG，全程scripted，不mock API。匿名无chat chunk；登录后chunk200、聊天可用；一次“查询余额”返回scripted资金预演，无动作建议；新建另一聊天后回到原聊天、退出重登，原消息仅一条。慢chunk期间局部加载提示可见，退出后等待该请求finished/failed和两个渲染帧，登录页仍在、聊天未重新挂载；再次登录找回原消息。独立新context中阻断一次chunk，实际ErrorBoundary出现；用户点击刷新后chunk200、原消息恢复。

全部浏览器请求限制在隔离同源，外部请求0；只有一次实际messages POST，刷新与恢复阶段无message/retry/确认等所检查业务POST。后端独立READ ONLY核查只有一条complete命令。账户余额/占额及动作数前后相同，32业务表仅daily_usage从0行初始化为当日used_minor0，其余31表摘要相同；不称数据库严格无写入。原演示49表97命令前后摘要保持。

**保留统计字段缺陷：**原网络附件的messagePosts=11错误地按messages路径计数，包含10条历史GET。实际验收断言使用method=POST，原始239条网络事件重算为1次POST。原附件与运行脚本哈希保留，没有通过重跑掩盖问题；[单独纠正说明](evidence/2026-10-25-g9q-network-counter-correction.json)记明原字段与正确口径。本轮不把该附件字段作为提交次数证据。

根实际查看局部加载、全页错误与刷新恢复三张截图，文字与脚本模式标识正常。测试仅桌面同用户session换代；未新增跨用户或移动端验收，也没有证明支付/云模型全流程。当前失败处理是全局错误页+显式刷新，不描述为局部自动重试。

隔离实例9091472943f0a8e5已destroy，childrenStopped/containersRemoved/volumeRemoved全部true，主会话exit0。产品源相对G9O仅App.tsx变更；模型仍为用户指定GLM-5.3-Flash，云调用0，最近G9M的502缺口仍保留。

## 证据与后续边界

- [首屏原始数据](evidence/g9q-first-load-browser/samples.json)、[浏览器报告](evidence/g9q-lazy-chat-browser/report.json)、[原始网络附件](evidence/2026-10-25-g9q-browser-network.json)。
- [102项定向状态测试](evidence/2026-10-25-g9q-state-tests.log)、[类型检查](evidence/2026-10-25-g9q-typecheck.log)、[生产构建](evidence/2026-10-25-g9q-build.log)。
- [源码及当前清单](evidence/2026-10-25-g9q-source-verification.json)、[静态独审](evidence/2026-10-25-g9q-static-independent-review.json)、[实际看图](evidence/2026-10-25-g9q-root-visual-review.json)。
- [业务观察](evidence/2026-10-25-g9q-business-observation.json)、[业务摘要](evidence/2026-10-25-g9q-business-after.json)、[原库保护](evidence/2026-10-25-g9q-runtime-after.json)、[销毁状态](evidence/2026-10-25-g9q-destroy-state.json)。

当前采纳此代码拆分，收益是匿名初始JS下载量下降，而非完整应用代码量下降或稳定速度承诺。新候选源码包包含此修改和先前G9O提示修复，导出/安装/测试均在同一台工作机，不替代接收方机器、完整跨日到账付款、同版云恢复/未见质量、多用户持续负载或比赛提交。完整目标继续active。

测试脚本实际执行SHA为dcc2b36448f34b0a945e1e279c4dcf1d15e34b284d98c395a6f046c1b13cedbd。运行后曾提出仅调整失败断言输出的7532fa草稿，已另存且未执行；原脚本恢复执行版哈希，不把草稿视为本轮验证对象。
