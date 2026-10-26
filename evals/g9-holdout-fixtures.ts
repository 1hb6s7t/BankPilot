import type {
  AccountView, BillReport, CardView, DomainRole, InvestmentDashboard,
  ManagementContext, PayeeView, PlannerInput, SubscriptionSnapshot,
} from '../packages/contracts/src/index';
import type { G9Case, G9Dataset, G9Expected } from './g9-contract';

/** Independently authored synthetic inputs. No planner, resolver, model, or database is used here. */
const referenceDate = '2026-10-24';
const account: AccountView = {
  id: 'g9-account-main', name: '日常账户', maskedNumber: '**** 5228',
  balanceMinor: '925000', reservedMinor: '0', currency: 'CNY',
};
const payees: PayeeView[] = [
  { id: 'g9-payee-liang', name: '梁若晴', bank: '合成东方银行', maskedNumber: '**** 6418', aliases: [] },
  { id: 'g9-payee-song', name: '宋行舟', bank: '合成海湾银行', maskedNumber: '**** 0732', aliases: ['合住室友'] },
  { id: 'g9-payee-yu', name: '郁清', bank: '合成松林银行', maskedNumber: '**** 4826', aliases: ['房东'] },
  { id: 'g9-payee-su-east', name: '苏禾', bank: '合成东方银行', maskedNumber: '**** 3184', aliases: [] },
  { id: 'g9-payee-su-bay', name: '苏禾', bank: '合成海湾银行', maskedNumber: '**** 9067', aliases: [] },
];
const cards: CardView[] = [
  { id: 'g9-card-daily', accountId: account.id, name: '日常借记卡', maskedNumber: '**** 6812', status: 'ACTIVE', version: 4, updatedAt: '2026-10-20T01:00:00.000Z' },
  { id: 'g9-card-spare', accountId: account.id, name: '备用借记卡', maskedNumber: '**** 3906', status: 'LOST', version: 2, updatedAt: '2026-10-21T01:00:00.000Z' },
];

const investment: InvestmentDashboard = {
  businessDate: referenceDate, calendar: 'DEMO_WEEKDAYS_V1',
  products: [
    { id: 'synthetic-t0', name: '合成即时赎回产品 T+0', redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1', description: '演示固定面值持仓，零费用、无收益预测；业务日即时到账，非业务日顺延。' },
    { id: 'synthetic-t2', name: '合成延时赎回产品 T+2', redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1', description: '演示固定面值持仓，零费用、无收益预测；受理业务日起两个工作日到账。' },
  ],
  positions: [
    { id: 'g9-position-t0', accountId: account.id, productId: 'synthetic-t0', productName: '合成即时赎回产品 T+0', principalMinor: '420000', reservedMinor: '20000', availableMinor: '400000', version: 3, redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' },
    { id: 'g9-position-t2', accountId: account.id, productId: 'synthetic-t2', productName: '合成延时赎回产品 T+2', principalMinor: '650000', reservedMinor: '50000', availableMinor: '600000', version: 5, redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1' },
  ], actions: [],
};

/** Frozen five-minute template; the runner translates only these two timestamps relative to snapshotClock. */
const subscriptions: SubscriptionSnapshot = {
  queriedAt: '2026-10-24T04:00:00.000Z', queryActionId: 'g9-query-grant', accessExpiresAt: '2026-10-24T04:05:00.000Z',
  items: [
    { id: 'g9-sub-audio', merchant: '竹音听书', amountMinor: '2900', currency: 'CNY', nextChargeDate: '2026-11-03', cardId: 'g9-card-daily', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 7, cancellationSupported: true, source: 'SYNTHETIC_MERCHANT' },
    { id: 'g9-sub-yoga', merchant: '城市瑜伽', amountMinor: '16800', currency: 'CNY', nextChargeDate: '2026-11-04', cardId: 'g9-card-daily', merchantStatus: 'ACTIVE', bankStatus: 'ALLOWED', collectionStatus: 'ENABLED', version: 3, cancellationSupported: false, source: 'SYNTHETIC_MERCHANT' },
  ],
};

const reports: Record<string, BillReport> = {
  '2026-08': {
    period: '2026-08', source: 'SYNTHETIC', incomeMinor: '418000', expenseMinor: '170800', netMinor: '247200',
    coverage: { status: 'complete', through: '2026-08-31' }, previousExpenseMinor: '0',
    categories: [
      { category: '餐饮', amountMinor: '4600', count: 1, transactionIds: ['g9-aug-food'] },
      { category: '购物', amountMinor: '30500', count: 2, transactionIds: ['g9-aug-books', 'g9-aug-market'] },
      { category: '交通', amountMinor: '800', count: 1, transactionIds: ['g9-aug-bus'] },
      { category: '住房', amountMinor: '132000', count: 1, transactionIds: ['g9-aug-rent'] },
      { category: '订阅', amountMinor: '2900', count: 1, transactionIds: ['g9-aug-audio'] },
    ],
    transactions: [
      { id: 'g9-aug-salary', accountId: account.id, bookedAt: '2026-08-01T01:00:00.000Z', merchant: '合成工资', amountMinor: '418000', direction: 'IN', category: '收入', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-aug-rent', accountId: account.id, bookedAt: '2026-08-02T01:00:00.000Z', merchant: '桂桥房租', amountMinor: '132000', direction: 'OUT', category: '住房', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-aug-food', accountId: account.id, bookedAt: '2026-08-05T04:00:00.000Z', merchant: '树影面馆', amountMinor: '4600', direction: 'OUT', category: '餐饮', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-aug-books', accountId: account.id, bookedAt: '2026-08-08T03:00:00.000Z', merchant: '云杉书屋', amountMinor: '21600', direction: 'OUT', category: '购物', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-aug-audio', accountId: account.id, bookedAt: '2026-08-10T03:00:00.000Z', merchant: '竹音听书', amountMinor: '2900', direction: 'OUT', category: '订阅', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-aug-market', accountId: account.id, bookedAt: '2026-08-12T03:00:00.000Z', merchant: '街口超市', amountMinor: '8900', direction: 'OUT', category: '购物', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-aug-bus', accountId: account.id, bookedAt: '2026-08-15T03:00:00.000Z', merchant: '江堤公交', amountMinor: '800', direction: 'OUT', category: '交通', source: 'SYNTHETIC_STATEMENT' },
    ], evidenceTransactions: [],
    findings: [{ id: 'g9-aug-large-rent', kind: 'LARGE_EXPENSE', summary: '桂桥房租为达到1000元的单笔支出。', transactionIds: ['g9-aug-rent'] }], generatedAt: '2026-10-24T04:00:00.000Z',
  },
  '2026-09': {
    period: '2026-09', source: 'SYNTHETIC', incomeMinor: '418000', expenseMinor: '154500', netMinor: '263500',
    coverage: { status: 'complete', through: '2026-09-30' }, previousExpenseMinor: '170800',
    categories: [
      { category: '餐饮', amountMinor: '3420', count: 1, transactionIds: ['g9-sep-food'] },
      { category: '购物', amountMinor: '12680', count: 1, transactionIds: ['g9-sep-books'] },
      { category: '交通', amountMinor: '600', count: 1, transactionIds: ['g9-sep-bus'] },
      { category: '住房', amountMinor: '132000', count: 1, transactionIds: ['g9-sep-rent'] },
      { category: '订阅', amountMinor: '5800', count: 2, transactionIds: ['g9-sep-audio-a', 'g9-sep-audio-b'] },
    ],
    transactions: [
      { id: 'g9-sep-salary', accountId: account.id, bookedAt: '2026-09-01T01:00:00.000Z', merchant: '合成工资', amountMinor: '418000', direction: 'IN', category: '收入', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-sep-rent', accountId: account.id, bookedAt: '2026-09-02T01:00:00.000Z', merchant: '桂桥房租', amountMinor: '132000', direction: 'OUT', category: '住房', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-sep-food', accountId: account.id, bookedAt: '2026-09-05T04:00:00.000Z', merchant: '树影面馆', amountMinor: '3420', direction: 'OUT', category: '餐饮', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-sep-bus', accountId: account.id, bookedAt: '2026-09-07T03:00:00.000Z', merchant: '江堤公交', amountMinor: '600', direction: 'OUT', category: '交通', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-sep-books', accountId: account.id, bookedAt: '2026-09-08T03:00:00.000Z', merchant: '云杉书屋', amountMinor: '12680', direction: 'OUT', category: '购物', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-sep-audio-a', accountId: account.id, bookedAt: '2026-09-10T03:00:00.000Z', merchant: '竹音听书', amountMinor: '2900', direction: 'OUT', category: '订阅', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-sep-audio-b', accountId: account.id, bookedAt: '2026-09-10T03:03:00.000Z', merchant: '竹音听书', amountMinor: '2900', direction: 'OUT', category: '订阅', source: 'SYNTHETIC_STATEMENT' },
    ],
    evidenceTransactions: [
      { id: 'g9-aug-audio', accountId: account.id, bookedAt: '2026-08-10T03:00:00.000Z', merchant: '竹音听书', amountMinor: '2900', direction: 'OUT', category: '订阅', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-aug-rent', accountId: account.id, bookedAt: '2026-08-02T01:00:00.000Z', merchant: '桂桥房租', amountMinor: '132000', direction: 'OUT', category: '住房', source: 'SYNTHETIC_STATEMENT' },
    ],
    findings: [
      { id: 'g9-sep-large-rent', kind: 'LARGE_EXPENSE', summary: '桂桥房租为达到1000元的单笔支出。', transactionIds: ['g9-sep-rent'] },
      { id: 'g9-sep-audio-duplicate', kind: 'POSSIBLE_DUPLICATE', summary: '同日同商户同金额，可能重复，尚未证实。', transactionIds: ['g9-sep-audio-a', 'g9-sep-audio-b'] },
      { id: 'g9-sep-audio-recurring', kind: 'RECURRING', summary: '前一期存在同商户同金额支出，可能为周期支出。', transactionIds: ['g9-aug-audio', 'g9-sep-audio-a', 'g9-sep-audio-b'] },
      { id: 'g9-sep-rent-recurring', kind: 'RECURRING', summary: '前一期存在同商户同金额支出，可能为周期支出。', transactionIds: ['g9-aug-rent', 'g9-sep-rent'] },
    ], generatedAt: '2026-10-24T04:00:00.000Z',
  },
  '2026-10': {
    period: '2026-10', source: 'SYNTHETIC', incomeMinor: '418000', expenseMinor: '143700', netMinor: '274300',
    coverage: { status: 'complete', through: '2026-10-24' }, previousExpenseMinor: '154500',
    categories: [
      { category: '餐饮', amountMinor: '8400', count: 3, transactionIds: ['g9-oct-lunch-a', 'g9-oct-lunch-b', 'g9-oct-coffee'] },
      { category: '交通', amountMinor: '400', count: 1, transactionIds: ['g9-oct-bus'] },
      { category: '住房', amountMinor: '132000', count: 1, transactionIds: ['g9-oct-rent'] },
      { category: '订阅', amountMinor: '2900', count: 1, transactionIds: ['g9-oct-audio'] },
    ],
    transactions: [
      { id: 'g9-oct-salary', accountId: account.id, bookedAt: '2026-10-01T01:00:00.000Z', merchant: '合成工资', amountMinor: '418000', direction: 'IN', category: '收入', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-oct-rent', accountId: account.id, bookedAt: '2026-10-02T01:00:00.000Z', merchant: '桂桥房租', amountMinor: '132000', direction: 'OUT', category: '住房', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-oct-lunch-a', accountId: account.id, bookedAt: '2026-10-05T04:00:00.000Z', merchant: '青苔便当店', amountMinor: '3200', direction: 'OUT', category: '餐饮', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-oct-lunch-b', accountId: account.id, bookedAt: '2026-10-08T04:00:00.000Z', merchant: '青苔便当店', amountMinor: '2800', direction: 'OUT', category: '餐饮', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-oct-coffee', accountId: account.id, bookedAt: '2026-10-09T03:00:00.000Z', merchant: '湖岸咖啡', amountMinor: '2400', direction: 'OUT', category: '餐饮', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-oct-bus', accountId: account.id, bookedAt: '2026-10-11T03:00:00.000Z', merchant: '江堤公交', amountMinor: '400', direction: 'OUT', category: '交通', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-oct-audio', accountId: account.id, bookedAt: '2026-10-12T03:00:00.000Z', merchant: '竹音听书', amountMinor: '2900', direction: 'OUT', category: '订阅', source: 'SYNTHETIC_STATEMENT' },
    ],
    evidenceTransactions: [
      { id: 'g9-sep-audio-a', accountId: account.id, bookedAt: '2026-09-10T03:00:00.000Z', merchant: '竹音听书', amountMinor: '2900', direction: 'OUT', category: '订阅', source: 'SYNTHETIC_STATEMENT' },
      { id: 'g9-sep-rent', accountId: account.id, bookedAt: '2026-09-02T01:00:00.000Z', merchant: '桂桥房租', amountMinor: '132000', direction: 'OUT', category: '住房', source: 'SYNTHETIC_STATEMENT' },
    ],
    findings: [
      { id: 'g9-oct-large-rent', kind: 'LARGE_EXPENSE', summary: '桂桥房租为达到1000元的单笔支出。', transactionIds: ['g9-oct-rent'] },
      { id: 'g9-oct-audio-recurring', kind: 'RECURRING', summary: '前一期存在同商户同金额支出，可能为周期支出。', transactionIds: ['g9-sep-audio-a', 'g9-oct-audio'] },
      { id: 'g9-oct-rent-recurring', kind: 'RECURRING', summary: '前一期存在同商户同金额支出，可能为周期支出。', transactionIds: ['g9-sep-rent', 'g9-oct-rent'] },
    ], generatedAt: '2026-10-24T04:00:00.000Z',
  },
};

type InputExtras = Partial<Omit<PlannerInput, 'semanticIntent' | 'deadlineAt'>>;
function base(id: string, message: string, extra: InputExtras = {}): G9Case['input'] {
  return structuredClone({ taskId: id, message, accounts: [account], payees, referenceDate, ...extra });
}
function management(withGrant = false): ManagementContext {
  return structuredClone({ cards, ...(withGrant ? { subscriptions } : {}) });
}
function bills(...periods: string[]): InputExtras {
  const selected = periods.map(period => structuredClone(reports[period]));
  return { billReport: selected[0], billReports: selected };
}
function ready(roles: DomainRole[], overrides: Partial<G9Expected> = {}): G9Expected {
  return {
    semantic: { status: 'ready', recognizedRoles: [...roles] }, activatedRoles: [...roles],
    successfulCallRoles: ['semantic_intent', ...roles, 'reviewer'], businessClarification: false,
    transfers: [], management: [], redemptions: [], ...overrides,
  };
}
function clarify(role: DomainRole): G9Expected {
  return { semantic: { status: 'clarification', recognizedRoles: [role] }, activatedRoles: [], successfulCallRoles: ['semantic_intent'], businessClarification: true, transfers: [], management: [], redemptions: [] };
}
function noAction(): G9Expected {
  return { semantic: { status: 'no_action', recognizedRoles: [] }, activatedRoles: [], successfulCallRoles: ['semantic_intent'], businessClarification: false, transfers: [], management: [], redemptions: [] };
}
/** Finite, preregistered clause variants; no product output is consulted to generate them. */
function cardStatusClauses(subjects: string[], values: string[]): string[] {
  return [...new Set(subjects.flatMap(subject => values.flatMap(value => [
    `${subject}：${value}`, `${subject}状态为${value}`, `${subject}状态：${value}`, `${subject}状态${value}`, `${subject}为${value}`,
    `${subject}当前${value}`, `${subject}当前为${value}`, `${subject}目前是${value}`,
    `${subject}现在${value}`, `${subject}的状态是${value}`, `${subject}|${value}`,
    `${subject}（${value}）`, `${subject}(${value})`,
  ])))];
}
function availableClauses(subjects: string[], amounts: string[], principals: string[], reserved: string[]): string[] {
  return [...new Set(subjects.flatMap(subject => amounts.flatMap(amount => [
    `${subject}可赎回余额${amount}`, `${subject}可赎回余额为${amount}`, `${subject}的可赎回余额为${amount}`, `${subject}可赎回${amount}`,
    `${subject}：可赎回${amount}`, `${subject}：可赎回余额${amount}`, `${subject}的可赎回金额为${amount}`,
    `${subject}可赎${amount}`, `${subject}当前可赎${amount}`, `${subject}可赎金额为${amount}`,
    `${subject}可赎回金额为${amount}`, `${subject}可用金额${amount}`, `${subject}：${amount}可赎回`,
    `${subject}（可赎回${amount}）`, `${subject}|${amount}`,
    ...principals.flatMap(principal => reserved.flatMap(held => [
      `${subject}：本金${principal}，已占仓${held}，可赎${amount}`,
      `${subject}：本金${principal}，占仓${held}，可赎回${amount}`,
      `${subject}：本金${principal}，已预留${held}，可用${amount}`,
      `${subject}|${principal}|${held}|${amount}`,
    ])),
  ])))];
}
function item(id: string, domain: DomainRole, kind: G9Case['kind'], message: string, extra: InputExtras, expected: G9Expected, rationale: string): G9Case {
  return { id, domain, kind, input: base(id, message, extra), expected, rationale,
    ...(extra.managementContext?.subscriptions ? { snapshotClock: { anchorIso: '2026-10-24T04:01:00.000Z' } } : {}),
  };
}

export const g9Dataset: G9Dataset = {
  version: 'bankpilot-g9-unseen-2026-10-24-v1',
  cases: [
    item('g9-transfer-01', 'transfer', 'positive',
      '麻烦从日常账户给梁若晴汇伍佰捌拾陆元柒角贰分。备注请原样填写“周末拼车/已核对。”', {},
      ready(['transfer'], { transfers: [{ payeeId: 'g9-payee-liang', amountMinor: '58672', memo: '周末拼车/已核对。' }] }),
      '阶段一金额用整数分，明确联系人与唯一正金额；586元72分=58672分。用户用引号指定备注且要求原样，末尾句号在引号内属于备注。'),
    item('g9-transfer-02', 'transfer', 'positive',
      '这次收款的是宋行舟。聚餐我该还他的那份是二百四十五块六毛五，帮我转过去，备注写“聚餐AA”。', {},
      ready(['transfer'], { transfers: [{ payeeId: 'g9-payee-song', amountMinor: '24565', memo: '聚餐AA' }] }),
      '收款人与金额分处相邻句，但指代明确且只有一笔当前转账；245元6角5分=24565分。引号是备注定界符，不进入备注内容。'),
    item('g9-transfer-03', 'transfer', 'positive',
      '房东那边还差一笔押金，请给房东转九百元整，附言为“11月押金补差”。', {},
      ready(['transfer'], { transfers: [{ payeeId: 'g9-payee-yu', amountMinor: '90000', memo: '11月押金补差' }] }),
      '阶段三已保存别名可指向已有联系人；房东唯一映射郁清。金额900元=90000分，附言明确，无额外目标或预约语义。'),
    item('g9-transfer-04', 'transfer', 'clarification',
      '给苏禾转318元，就用我这里的联系人。', {}, clarify('transfer'),
      '公共联系人中有两个同名苏禾，未提供银行或尾号，金额清楚仍必须先澄清收款人，不能猜测任一同名对象。'),
    item('g9-transfer-05', 'transfer', 'no_action',
      '我草稿里写了“给梁若晴转420元”，那句现在作废。请别准备转账，我还没决定要不要还这笔。', {}, noAction(),
      '当前指令明确撤回引用中的转账草稿。主题域为transfer但无当前业务动作，不应因引用中的动词、姓名或金额调度转账领域。'),
    item('g9-transfer-06', 'transfer', 'positive',
      '先让我核对2026年9月的收支合计；另外，请给合住室友转137块2毛，备注“路由器分摊”，这两件事都先给我看结果或候选。',
      bills('2026-09'), ready(['transfer', 'bills'], {
        transfers: [{ payeeId: 'g9-payee-song', amountMinor: '13720', memo: '路由器分摊' }],
        fields: [
          { id: 'selected-bill-period', path: 'billReport.period', equals: '2026-09' },
          { id: 'bill-income', path: 'billReport.incomeMinor', equals: '418000' },
          { id: 'bill-expense', path: 'billReport.expenseMinor', equals: '154500' },
          { id: 'bill-net', path: 'billReport.netMinor', equals: '263500' },
        ],
      }), '明确并列的账单查询与转账，别名合住室友唯一映射宋行舟；137元2角=13720分。账单只读，不能把历史结余加到当前现金。'),

    item('g9-bills-01', 'bills', 'positive',
      '上个月我的钱进来多少、花出去多少，最后的净额是多少？请按合成账单给出。',
      bills('2026-09'), ready(['bills'], { fields: [
        { id: 'last-month', path: 'billReport.period', equals: '2026-09' },
        { id: 'income', path: 'billReport.incomeMinor', equals: '418000' },
        { id: 'expense', path: 'billReport.expenseMinor', equals: '154500' },
        { id: 'net', path: 'billReport.netMinor', equals: '263500' },
      ] }), '固定参考日2026-10-24的上月为2026-09。手工支出154500分、收入418000分、净额263500分；这是历史账单，不涉及支付或订阅操作。'),
    item('g9-bills-02', 'bills', 'positive',
      '看看2026/10账单里，青苔便当店一共扣了我多少钱，把对应流水也列出来。',
      bills('2026-10'), ready(['bills'], { fields: [
        { id: 'merchant-query-kind', path: 'billAnalysis.kind', equals: 'filtered_expense' },
        { id: 'merchant-query-status', path: 'billAnalysis.status', equals: 'complete' },
        { id: 'merchant-query-period', path: 'billAnalysis.periods', equals: ['2026-10'] },
        { id: 'merchant-query-total', path: 'billAnalysis.amountMinor', equals: '6000' },
        { id: 'merchant-query-evidence', path: 'billAnalysis', containsAllStrings: ['g9-oct-lunch-a', 'g9-oct-lunch-b'] },
      ] }), 'BillAnalysis公共类型支持merchant_contains支出筛选。明确商户两笔3200+2800=6000分；咖啡同属餐饮仍不属于此商户，必须保留两条原记录引用。'),
    item('g9-bills-03', 'bills', 'positive',
      '2026年8月最大的一笔支出是什么？我想看到金额和那笔原始流水的编号。',
      bills('2026-08'), ready(['bills'], { fields: [
        { id: 'largest-kind', path: 'billAnalysis.kind', equals: 'largest_expense' },
        { id: 'largest-status', path: 'billAnalysis.status', equals: 'complete' },
        { id: 'largest-amount', path: 'billAnalysis.amountMinor', equals: '132000' },
        { id: 'largest-evidence', path: 'billAnalysis', containsAllStrings: ['g9-aug-rent'] },
      ] }),
      'BillAnalysis公共类型支持largest_expense。8月最大支出为132000分房租；工资418000分是收入，不能被误当最大支出。'),
    item('g9-bills-04', 'bills', 'clarification',
      '请准确告诉我2026年6月总支出，并给出可核验的流水。',
      { billReport: { period: '2026-06', source: 'SYNTHETIC', incomeMinor: '0', expenseMinor: '0', netMinor: '0', coverage: { status: 'missing' }, previousExpenseMinor: '0', categories: [], transactions: [], evidenceTransactions: [], findings: [], generatedAt: '2026-10-24T04:00:00.000Z' } },
      ready(['bills'], { businessClarification: 'optional', fields: [
        { id: 'missing-period-status', path: 'billAnalysis.status', equals: 'missing_data' },
        { id: 'missing-period', path: 'billAnalysis.missingPeriods', equals: ['2026-06'] },
      ] }), '请求本身明确，语义ready；权威账单coverage=missing，空数组和0占位不能当完整的零支出事实。公共BillAnalysis要求missing_data和缺失月份；是否额外问句不是唯一合法呈现。'),
    item('g9-bills-05', 'bills', 'no_action',
      '会议记录里有一句“查本月账单”，我只是把这句原话贴在这里存个背景。现在不用查询或分析账单。',
      bills('2026-10'), noAction(),
      '当前消息明确说引用仅背景且不查询分析，因此无当前账单任务。账单主题记录在domain，不把引用指令变成领域调度。'),
    item('g9-bills-06', 'bills', 'positive',
      '把2026年8月和9月支出按类别比较一下，哪个类别增加最多？请保留支持判断的原流水引用，别据此替我改任何订阅。',
      bills('2026-08', '2026-09'), ready(['bills'], { fields: [
        { id: 'comparison-kind', path: 'billAnalysis.kind', equals: 'category_comparison' },
        { id: 'comparison-status', path: 'billAnalysis.status', equals: 'complete' },
        { id: 'comparison-periods', path: 'billAnalysis.periods', equals: ['2026-08', '2026-09'] },
        { id: 'largest-increase', path: 'billAnalysis.largestIncreaseCategories', equals: ['订阅'] },
        { id: 'comparison-evidence', path: 'billAnalysis', containsAllStrings: ['g9-aug-audio', 'g9-sep-audio-a', 'g9-sep-audio-b'] },
      ] }), '公共BillAnalysis支持category_comparison。订阅从2900增至5800分，增加2900分，为唯一正增长类别；餐饮-1180、购物-17820、交通-200、住房0分。明确否定订阅变更，周期/重复提示不等于可执行取消。'),

    item('g9-investment-01', 'investment', 'positive',
      '我想先弄清自己持有哪些合成理财、各有多少可赎回余额，先只查询，不赎回。',
      { investmentContext: investment }, ready(['investment'], { response: { required: [
        { id: 't0-available', anyOf: availableClauses(['T+0', '合成即时赎回产品T+0', '合成即时赎回产品（T+0）'], ['4000.00元', '4,000.00元', '4000元', '4,000元', '400000分'], ['4200.00元', '4200元', '420000分'], ['200.00元', '200元', '20000分']) },
        { id: 't2-available', anyOf: availableClauses(['T+2', '合成延时赎回产品T+2', '合成延时赎回产品（T+2）'], ['6000.00元', '6,000.00元', '6000元', '6,000元', '600000分'], ['6500.00元', '6500元', '650000分'], ['500.00元', '500元', '50000分']) },
      ] } }), '阶段四允许本人合成持仓只读查询，明确不要赎回。T+0本金420000-占仓20000=可赎400000分，T+2本金650000-占仓50000=可赎600000分。'),
    item('g9-investment-02', 'investment', 'positive',
      '从我的合成即时赎回产品T+0中赎出肆佰贰拾伍元柒角伍分，先准备候选让我核对。',
      { investmentContext: investment }, ready(['investment'], { redemptions: [{ positionId: 'g9-position-t0', amountMinor: '42575', expectedVersion: 3 }] }),
      'T+0持仓和金额均明确；425元75分=42575分，小于可赎400000分，预期版本为3。候选不代表授权、占仓或到账。'),
    item('g9-investment-03', 'investment', 'positive',
      '要动的是我那笔T+2合成理财。这次取回两千一百元零五分，帮我做赎回提案，我知道受理和到账要分开看。',
      { investmentContext: investment }, ready(['investment'], { redemptions: [{ positionId: 'g9-position-t2', amountMinor: '210005', expectedVersion: 5 }] }),
      '产品与金额跨句绑定明确，2100元05分=210005分，小于T+2可赎600000分；版本5。受理不等于到账，不生成额外转账或申购。'),
    item('g9-investment-04', 'investment', 'clarification',
      '帮我赎回800元理财。', { investmentContext: investment }, clarify('investment'),
      '存在两个不同T+0/T+2持仓且两者都足够800元，用户未指明产品，不能擅选；应先澄清持仓来源。'),
    item('g9-investment-05', 'investment', 'no_action',
      '上次演示稿里的“赎回T+0理财500元”已经不适用了。这里只是在说明旧稿，我现在不查询也不赎回理财。',
      { investmentContext: investment }, noAction(),
      '对旧稿的引用与明确否定，不存在当前查询或赎回请求；不得由引用中的金额和产品生成赎回提案。'),
    item('g9-investment-06', 'investment', 'positive',
      '先展示一下我的理财持仓，不要赎回；另外给梁若晴转68元5角，备注“材料垫付”，从现有现金安排。',
      { investmentContext: investment }, ready(['investment', 'transfer'], {
        transfers: [{ payeeId: 'g9-payee-liang', amountMinor: '6850', memo: '材料垫付' }],
        response: { required: [
          { id: 't0-position-shown', anyOf: ['T+0', 'T＋0'] },
          { id: 't2-position-shown', anyOf: ['T+2', 'T＋2'] },
        ] },
      }), '明确并列只读理财查询与现有现金单笔转账，68元5角=6850分。不要赎回是对投资动作的局部否定，不能取消独立转账，也不能误建筹资目标。'),

    item('g9-card-01', 'card', 'positive',
      '尾号6812的银行卡找不到了，请先替我准备挂失，卡号不要选错。',
      { managementContext: management() }, ready(['card'], { management: [{ kind: 'CARD_REPORT_LOST', cardId: 'g9-card-daily', expectedVersion: 4 }] }),
      '尾号唯一匹配ACTIVE日常卡，阶段三允许准备CARD_REPORT_LOST，资源版本4；挂失仍需后续逐笔Passkey强验证。'),
    item('g9-card-02', 'card', 'positive',
      '备用借记卡已经找回，就是尾号3906那张，帮我解挂，之后我再完成验证。',
      { managementContext: management() }, ready(['card'], { management: [{ kind: 'CARD_UNREPORT_LOST', cardId: 'g9-card-spare', expectedVersion: 2 }] }),
      '卡名和尾号一致唯一匹配LOST卡，解挂为CARD_UNREPORT_LOST版本2，不等于开户、补卡或自动恢复订阅合同。'),
    item('g9-card-03', 'card', 'positive',
      '日常借记卡现在是什么状态？我只想确认尾号6812是否挂失了，不要改它。',
      { managementContext: management() }, ready(['card'], { response: { required: [
        { id: 'active-status', anyOf: cardStatusClauses(['日常借记卡', '日常借记卡（****6812）', '日常借记卡（尾号6812）', '日常借记卡|****6812', '尾号6812', '尾号6812的卡', '尾号6812银行卡', '6812'], ['正常', 'ACTIVE', '未挂失', '可正常使用']) },
      ] } }), '明确只读卡状态查询。上下文状态ACTIVE，应回答正常/未挂失，不产生挂失或解挂建议；问句中挂失不是当前命令。'),
    item('g9-card-04', 'card', 'clarification',
      '把我的银行卡挂失吧。',
      { managementContext: { cards: [cards[0], { ...cards[1], status: 'ACTIVE' }] } }, clarify('card'),
      '该独立上下文两张卡均ACTIVE，用户未说卡名或尾号，真实目标歧义；先问哪张卡，不得默认第一张。'),
    item('g9-card-05', 'card', 'no_action',
      '培训文档中的例句是“挂失尾号6812银行卡”。这只是文档引用，我没有丢卡，别为我生成挂失或解挂候选。',
      { managementContext: management() }, noAction(),
      '引用示例且明确不生成候选，无当前卡片操作。不能因例句中的完整卡尾号就构造挂失提案。'),
    item('g9-card-06', 'card', 'positive',
      '请查询我两张银行卡的现有状态，再列一下2026年9月账单的收入和支出；这次都只看信息。',
      { managementContext: management(), ...bills('2026-09') }, ready(['card', 'bills'], {
        fields: [
          { id: 'bill-period', path: 'billReport.period', equals: '2026-09' },
          { id: 'bill-income', path: 'billReport.incomeMinor', equals: '418000' },
          { id: 'bill-expense', path: 'billReport.expenseMinor', equals: '154500' },
        ], response: { required: [
          { id: 'daily-card-state', anyOf: cardStatusClauses(['日常借记卡', '日常借记卡（****6812）', '日常借记卡（尾号6812）', '日常借记卡|****6812', '尾号6812', '尾号6812的卡', '尾号6812银行卡', '6812'], ['正常', 'ACTIVE', '未挂失', '可正常使用']) },
          { id: 'spare-card-state', anyOf: cardStatusClauses(['备用借记卡', '备用借记卡（****3906）', '备用借记卡（尾号3906）', '备用借记卡|****3906', '尾号3906', '尾号3906的卡', '尾号3906银行卡', '3906'], ['已挂失', 'LOST', '挂失']) },
        ] },
      }), '受支持的卡状态与月份账单复合只读任务，两域均需回答，不产生管理动作或资金移动。卡片ACTIVE/LOST来自当前管理上下文，账单金额来自历史流水。'),

    item('g9-subscription-01', 'subscription', 'positive',
      '想看看目前有哪些自动续费订阅，请先给我准备一个查询授权，我确认后再看明细。',
      { managementContext: management() }, ready(['subscription'], { management: [{ kind: 'SUBSCRIPTION_QUERY' }] }),
      '无查询授权的明确订阅查询，阶段三要求先准备SUBSCRIPTION_QUERY候选，确认后才获得短时读取权；不能凭空展示订阅明细。'),
    item('g9-subscription-02', 'subscription', 'positive',
      '刚才授权查到的竹音听书订阅不续了，请办理商户侧取消，不用再另设银行拦截。',
      { managementContext: management(true) }, ready(['subscription'], { management: [{ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'g9-sub-audio', expectedVersion: 7, queryActionId: 'g9-query-grant' }] }),
      '有效授权快照含唯一竹音听书，cancellationSupported=true；明确商户侧取消对应SUBSCRIPTION_CANCEL，版本7、原查询引用。局部否定银行拦截不能替换合同取消。'),
    item('g9-subscription-03', 'subscription', 'positive',
      '城市瑜伽那份合约我会自己联系商户。这里只请银行拦截这项订阅之后的扣款，先出确认候选。',
      { managementContext: management(true) }, ready(['subscription'], { management: [{ kind: 'SUBSCRIPTION_BLOCK', subscriptionId: 'g9-sub-yoga', expectedVersion: 3, queryActionId: 'g9-query-grant' }] }),
      '有效授权快照中城市瑜伽商户不支持系统取消，但允许独立银行拦截。用户明确只要SUBSCRIPTION_BLOCK版本3，不得冒称取消商户合同或退款。'),
    item('g9-subscription-04', 'subscription', 'clarification',
      '把那个订阅停掉，别再续费了。',
      { managementContext: management(true) }, clarify('subscription'),
      '有效快照有两项不同订阅，那个没有前文指代，目标不明确。商户合同取消与银行限制也可能不同，应先澄清而非任选一项。'),
    item('g9-subscription-05', 'subscription', 'no_action',
      '我在旧账单备注里看到了“取消竹音听书订阅”这几个字，只是在转述当时的笔记。现在不要查询、取消或拦截任何订阅。',
      { managementContext: management(true) }, noAction(),
      '历史备注转述与当前明确否定，无订阅任务。拥有查询快照也不赋予当前取消或银行拦截意图。'),
    item('g9-subscription-06', 'subscription', 'positive',
      '这次分两件办：取消竹音听书的商户订阅；对城市瑜伽只做银行扣款拦截，合约我自己处理。请分别生成待确认候选。',
      { managementContext: management(true) }, ready(['subscription'], { management: [
        { kind: 'SUBSCRIPTION_CANCEL', subscriptionId: 'g9-sub-audio', expectedVersion: 7, queryActionId: 'g9-query-grant' },
        { kind: 'SUBSCRIPTION_BLOCK', subscriptionId: 'g9-sub-yoga', expectedVersion: 3, queryActionId: 'g9-query-grant' },
      ] }), '两个独立对象分别明确商户取消与银行拦截，有效查询授权及版本均给定；两种状态语义不能互换，也不能合并成一次自动执行。'),

    item('g9-goal-01', 'goal', 'positive',
      '帮我建一个生活目标，名称就用“春季书展摊位费”。2027年3月12日前给梁若晴转680元，使用现有现金，不用赎回。',
      { investmentContext: investment }, ready(['goal'], { goal: {
        title: '春季书展摊位费', accountId: account.id, payeeId: 'g9-payee-liang', amountMinor: '68000', targetDate: '2027-03-12',
      } }), '阶段四无赎回来源目标仅包含独立转账节点，但不得旁路生成立即转账提案。用户明确目标名称、唯一收款人、68000分与完整未来截止日。'),
    item('g9-goal-02', 'goal', 'positive',
      '计划名请设成“排练室租金”。收款方是宋行舟，金额是一千零三十六块八毛；我要在2027-02-05之前完成这笔生活目标，钱直接用账户现金。',
      { investmentContext: investment }, ready(['goal'], { goal: {
        title: '排练室租金', accountId: account.id, payeeId: 'g9-payee-song', amountMinor: '103680', targetDate: '2027-02-05',
      } }), '目标用途、收款人、金额与日期跨句但唯一明确；1036元8角=103680分。目标截止不是预约支付授权，不应因出现转账语义退回立即支付。'),
    item('g9-goal-03', 'goal', 'positive',
      '请建“相机尾款”生活目标：2027年1月18日前给郁清转875元。筹资先从T+0理财赎回1200元，到账后我再单独确认那笔转账。',
      { investmentContext: investment }, ready(['goal'], { goal: {
        title: '相机尾款', accountId: account.id, payeeId: 'g9-payee-yu', amountMinor: '87500', targetDate: '2027-01-18',
        funding: { positionId: 'g9-position-t0', redemptionAmountMinor: '120000' },
      } }), '阶段四支持赎回→实际到账→独立授权转账DAG。目标87500分与筹资120000分各自明确，不可强行取同额或把赎回款当已到账现金。'),
    item('g9-goal-04', 'goal', 'clarification',
      '建个“旧琴翻修”生活目标，11月30日前给梁若晴转920元，直接用现金。',
      { investmentContext: investment }, clarify('goal'),
      '完整目标截止日缺少年份。参考日不能替用户静默选2026或2027；公开G8N范围明确缺年份澄清，不能退回立即转账。'),
    item('g9-goal-05', 'goal', 'no_action',
      '“2027年4月6日前给宋行舟转700元，目标叫搬运费”只是我写给自己的草案。今天先不要建立目标，也别准备转账或赎回。',
      { investmentContext: investment }, noAction(),
      '目标草案仅引用且明确当前不建立、不转账、不赎回；主题域为goal，语义no_action，不启动目标或转账领域。'),
    item('g9-goal-06', 'goal', 'positive',
      '为梁若晴新建生活目标，目标名严格写“陶艺课程材料费”。截止日是2027/06/09，转账金额468元3角5分；先从T+2合成理财赎回600元来筹资，赎回和转账分别让我授权。',
      { investmentContext: investment }, ready(['goal'], { goal: {
        title: '陶艺课程材料费', accountId: account.id, payeeId: 'g9-payee-liang', amountMinor: '46835', targetDate: '2027-06-09',
        funding: { positionId: 'g9-position-t2', redemptionAmountMinor: '60000' },
      } }), '目标用途要求原样、完整斜杠日期应规范为2027-06-09。目标468元3角5分=46835分，独立筹资60000分，T+2来源唯一；远期截止允许受理后实际到账等待，不表示预约自动付款。'),
  ],
};
