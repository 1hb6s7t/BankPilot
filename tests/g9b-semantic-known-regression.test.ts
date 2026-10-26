import { describe, expect, it } from 'vitest';
import { g9Dataset } from '../evals/g9-holdout-fixtures';
import { validateSemanticIntent, type SemanticIntentDraft } from '../packages/agents/src/semantic-intent';

// These inputs became known regressions after the frozen first run. This test
// validates hand-authored source extraction, never the original model or score.
type Task = SemanticIntentDraft['tasks'][number];
function fixture(id: string) { const value = g9Dataset.cases.find(item => item.id === id); if (!value) throw new Error('missing frozen regression'); return value.input; }
const scope = { source: 'whole_message' as const };
const e = (kind: 'payee' | 'position' | 'card' | 'subscription', id: string, text: string) => ({ kind, id, mention: { text } });
const payment = (id: string, text: string, amount: string, memo: string): Task => ({ operation: 'transfer', disposition: 'request', scope, entity: e('payee', id, text), amount: { text: amount }, memo: { text: memo } });
const goal = (id: string, payee: string, purpose: string, amount: string, date: string): Task => ({ operation: 'goal_create', disposition: 'request', scope, entity: e('payee', id, payee), amount: { text: amount }, date: { text: date }, purpose: { text: purpose } });
const samples: { id: string; tasks: Task[]; status?: string; issue?: string }[] = [
  { id: 'g9-transfer-01', tasks: [payment('g9-payee-liang', '梁若晴', '伍佰捌拾陆元柒角贰分', '周末拼车/已核对。')] },
  { id: 'g9-transfer-02', tasks: [payment('g9-payee-song', '宋行舟', '二百四十五块六毛五', '聚餐AA')] },
  { id: 'g9-bills-02', tasks: [{ operation: 'bills_query', disposition: 'query', scope, period: { text: '2026/10' } }] },
  { id: 'g9-bills-06', tasks: [{ operation: 'bills_query', disposition: 'query', scope, period: { text: '2026年8月和9月' } }] },
  { id: 'g9-investment-02', tasks: [{ operation: 'investment_redeem', disposition: 'request', scope, entity: e('position', 'g9-position-t0', '合成即时赎回产品T+0'), amount: { text: '肆佰贰拾伍元柒角伍分' } }] },
  { id: 'g9-investment-03', tasks: [{ operation: 'investment_redeem', disposition: 'request', scope, entity: e('position', 'g9-position-t2', 'T+2'), amount: { text: '两千一百元零五分' } }] },
  { id: 'g9-card-01', tasks: [{ operation: 'card_report_lost', disposition: 'request', scope, entity: e('card', 'g9-card-daily', '尾号6812') }] },
  { id: 'g9-card-03', tasks: [{ operation: 'card_query', disposition: 'query', scope }] },
  { id: 'g9-subscription-02', tasks: [{ operation: 'subscription_cancel', disposition: 'request', scope, entity: e('subscription', 'g9-sub-audio', '竹音听书') }] },
  { id: 'g9-subscription-03', tasks: [{ operation: 'subscription_block', disposition: 'request', scope, entity: e('subscription', 'g9-sub-yoga', '城市瑜伽') }] },
  { id: 'g9-goal-01', tasks: [goal('g9-payee-liang', '梁若晴', '春季书展摊位费', '680元', '2027年3月12日')] },
  { id: 'g9-goal-02', tasks: [goal('g9-payee-song', '宋行舟', '排练室租金', '一千零三十六块八毛', '2027-02-05')] },
  { id: 'g9-goal-03', tasks: [{ ...goal('g9-payee-yu', '郁清', '相机尾款', '875元', '2027年1月18日'), funding: { entity: e('position', 'g9-position-t0', 'T+0'), amount: { text: '1200元' } } }] },
  { id: 'g9-goal-04', tasks: [goal('g9-payee-liang', '梁若晴', '旧琴翻修', '920元', '11月30日')], status: 'clarification', issue: 'SEMANTIC_TARGET_DATE_YEAR_REQUIRED' },
  { id: 'g9-goal-06', tasks: [{ ...goal('g9-payee-liang', '梁若晴', '陶艺课程材料费', '468元3角5分', '2027/06/09'), funding: { entity: e('position', 'g9-position-t2', 'T+2'), amount: { text: '600元' } } }] },
];
describe('G9 original exposed source regressions, independent of original scoring', () => {
  it.each(samples)('$id supports its complete source extraction', sample => {
    const input = fixture(sample.id), result = validateSemanticIntent(input, { tasks: sample.tasks }, { referenceDate: input.referenceDate });
    expect({ status: result.status, findings: result.findings }).toEqual({ status: sample.status ?? 'ready', findings: sample.issue ? [sample.issue] : [] });
    if (result.status === 'ready') expect(result.tasks[0]?.source.text).toBe(input.message);
  });
  it.each(['transfer', 'bills', 'investment', 'card', 'subscription', 'goal'])('keeps all quoted/historical %s examples without any current task', domain => {
    const id = `g9-${domain}-05`, input = fixture(id);
    const result = validateSemanticIntent(input, { tasks: [{ operation: domain === 'goal' ? 'goal_create' : domain === 'bills' ? 'bills_query' : domain === 'investment' ? 'investment_redeem' : domain === 'card' ? 'card_report_lost' : domain === 'subscription' ? 'subscription_cancel' : 'transfer', disposition: 'historical', scope }] });
    expect({ status: result.status, findings: result.findings, tasks: result.tasks }).toEqual({ status: 'no_action', findings: [], tasks: [] });
  });
  it('retains both investment query and current-cash transfer while the redemption alone is negated', () => {
    const input = fixture('g9-investment-06');
    const result = validateSemanticIntent(input, { tasks: [
      { operation: 'investment_query', disposition: 'query', scope: { text: '先展示一下我的理财持仓，不要赎回' } },
      { ...payment('g9-payee-liang', '梁若晴', '68元5角', '材料垫付'), scope: { text: '另外给梁若晴转68元5角，备注“材料垫付”，从现有现金安排。' } },
    ] });
    expect({ status: result.status, findings: result.findings }).toEqual({ status: 'ready', findings: [] });
    expect(result.tasks.map(task => task.operation)).toEqual(['investment_query', 'transfer']);
  });
});
