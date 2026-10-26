# G9 时延观察（2026-10-24）

本报告只统计既有G8N证据。attempt journal的独立记录作为模型调用计数与时延主来源；`PlanResult.modelRuns`可能在planner抛错时漏记，不能替代attempt journal。三套评测与两组浏览器报告分别报告，targeted supplemental不并入v4的24例分母。

## 评测调用与等待时间

| 证据集 | 案例结果 | journal attempts | HTTP/结果 | semantic_intent | reviewer | 领域角色中位数 | 缺失usage |
|---|---:|---:|---|---|---|---|---|
| v2 full | 24；median 18.6s / p95 34.7s | 61 | HTTP 200: 61 | 24次；中位 4.2s，p95 22.7s | 18次；中位 5.4s，p95 27.2s | bills 9.4s (n=5), card 4.1s (n=3), goal 13.5s (n=2), investment 8.6s (n=3), subscription 6.6s (n=4), transfer 5.2s (n=2) | 无 |
| v4 full | 24；median 27.5s / p95 95.1s | 63 | HTTP 200: 59, HTTP 502: 4 | 25次；中位 9.4s，p95 34.3s | 17次；中位 14.1s，p95 50.3s | bills 10.6s (n=6), card 20.9s (n=3), goal 23.1s (n=3), investment 11.9s (n=3), subscription 23.9s (n=4), transfer 4.7s (n=2) | input usage 4次, output usage 4次 |
| targeted supplemental | 2；median 20.1s / p95 23.1s | 6 | HTTP 200: 6 | 2次；中位 3.8s，p95 4.5s | 2次；中位 5.4s，p95 6.1s | bills 12.4s (n=1), investment 9.1s (n=1) | 无 |

v4相对v2的观察值中，24例case duration中位数由18.6s变为27.5s，p95由34.7s变为95.1s。case按journal结果的`records[].startedAt`顺序看，首6例中位数分别为17.6s和16.7s，末6例为25.2s和65.4s；v4后段变慢是时间序列上的观测，不足以证明并发或provider是原因。v4有4次HTTP 502失败，input/output usage各缺4条；这四条计时仍在attempt journal中。

角色等待时间使用attempt `startedAtUtc`至`endedAtUtc`的记录`durationMs`，代表一次模型请求的端到端等待（包含客户端/网络/服务端，不是纯服务端计算时长）。v2 semantic中位4.2s、reviewer 5.4s；v4分别9.4s、14.1s。领域中位数在v4中card 20.9s、goal 23.1s、subscription 23.9s较高，但每角色样本量仅2–6次且受不同案例组合影响，不能归因于角色定义或提示词。

同一case中领域attempt可能并行。领域耗时不按各角色简单求和：JSON记录按`caseSequence`对领域attempt的start/end intervals取union；v2总union为144.8s（每案例union中位8.4s），v4为288.6s（中位13.4s），targeted为21.5s（中位10.7s）。这是领域调用覆盖的跨case合计，不等同于单一用户请求的关键路径；case elapsed仍以result `durationMs`单独给出。

## 浏览器证据与并发时间关系

| 单独的浏览器证据 | Playwright结果 | scope cloudCalls | call等待耗时 / HTTP |
|---|---:|---:|---|
| browser-attempt-2 | 通过 1，失败 2 | 8 calls；15.5s/HTTP 200, 11.3s/HTTP 200, 10.9s/HTTP 200, 17.5s/HTTP 200, 7.9s/HTTP 502, 1.9s/HTTP 502, 1.1s/HTTP 502, 0.7s/HTTP 502 |
| http-recovery-retest | 通过 2，失败 0 | 4 calls；3.8s/HTTP 200, 3.1s/HTTP 200, 8.5s/HTTP 200, 7.1s/HTTP 200 |

03:36:49–03:52:06Z进行v4评测；03:38:19–03:39:29Z的browser attempt-2与其时间重叠。依据browser `scope.json`的cloudCalls窗口与v4 attempt journal区间，存在15对重叠调用区间（overlap逐对相加66.4s）；其中四个评测HTTP 502区间与browser HTTP 502区间同时出现。这仅说明时间相关性，不能证明彼此造成错误、延迟或恢复。v2与targeted supplemental没有和所列两组browser调用时间重叠。

浏览器分母单独保留：attempt-2是3个测试（1通过、2失败）；http-recovery-retest是另一次2/2通过。retest是独立补验，不与原3例合并重算通过率。scope `cloudCalls`提供请求级耗时及HTTP状态；Playwright `startTime`/`duration`是测试级耗时。

## 数据边界与可验证实验

- attempt起点取journal `attempt_start.startedAtUtc`（dispatch pending只表示记录了发送意图，不代表远端已收到）；结束时间取`attempt_end.endedAtUtc`，并以同条`durationMs`做统计。三份journal均无缺start/end的attempt；v2 61/61、v4 63/63、supplemental 6/6闭合。未观察到的纯provider server time无法从现有日志拆出。
- case耗时取评测JSON `records[].durationMs`，趋势顺序取同条`sequence`、`startedAt`；result级latency摘要也保留在产物JSON。浏览器scope的计时来自Playwright report内`scope.json`附件。
- v4因4条usage缺失，已报告的输入token 99,121与输出token 50,596只是可见usage小计；完整token总数未知，不能估算计费。v2/supplemental也只称reported usage sum，不推算费用。
- 可以复测的优化实验：固定输入、代码版本和质量验收契约，先跑外部调用并发=1 baseline，再改变并发或角色排队策略；单独记录semantic/domain/reviewer的请求量、attempt等待、case关键路径及业务质量。另可在保持质量验收不变的条件下，分开试prompt/token预算和不同角色等待策略。每次只改一个因素并重复多轮；这些是实验建议，不是根因结论。

## 产物与primary evidence

- 机器可读汇总与安全字段白名单：[g9-latency-audit.json](evidence/2026-10-24-g9-latency-audit.json)
- 可复跑的只读统计脚本：[g9-latency-audit.py](../scripts/analyze-g9-latency.py)
- v2 primary: `evals/results/g8n-known24-final-2026-10-24/2026-10-24T03-13-40-478Z-g7-semantic-live-all-production.attempts.jsonl` 与同名前缀`.json`
- v4 primary: `evals/results/g8n-known24-v4-2026-10-24/2026-10-24T03-36-49-383Z-g7-semantic-live-all-production.attempts.jsonl` 与同名前缀`.json`
- supplemental primary: `evals/results/g8n-http-supplemental-2026-10-24/2026-10-24T03-53-55-831Z-targeted-http-supplemental.attempts.jsonl` 与同名前缀`.json`
- browser scope primary: `docs/evidence/g8n-live-browser-2026-10-24/attempt-2/report.json`、`docs/evidence/g8n-live-browser-2026-10-24/http-recovery-retest/report.json`

浏览器计时附件仅导出sequence、startedAt、durationMs、outcome、HTTP status和wallStart存在性标志；评测汇总仅导出角色、时间、状态、usage计数等统计字段。未复制密钥、URL、headers、prompt、completion或用户标识。
