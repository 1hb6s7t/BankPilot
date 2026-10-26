import type { BillAnalysis, BillCategory, BillReport, BillTransaction, SemanticTask } from '../../contracts/src/index.js';

type Period = NonNullable<SemanticTask['slots']['billPeriod']>;
const validMonth = (value: string) => /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const money = (value: string | bigint) => {
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
};
const periodLabel = (period: string) => `${period}（${period.slice(0, 4)}年${Number(period.slice(5))}月）`;
const transactionPeriod = (row: BillTransaction) => {
  const timestamp = new Date(row.bookedAt).valueOf();
  return Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 7) : undefined;
};
const previousPeriod = (period: string) => {
  const year = Number(period.slice(0, 4)), month = Number(period.slice(5));
  return month === 1 ? `${String(year - 1).padStart(4, '0')}-12` : `${period.slice(0, 4)}-${String(month - 1).padStart(2, '0')}`;
};
const sameTransaction = (left: BillTransaction, right: BillTransaction) =>
  (['id', 'accountId', 'bookedAt', 'merchant', 'amountMinor', 'direction', 'category', 'source'] as const).every(key => left[key] === right[key]);
// Only standalone generic words expand. Named or quoted merchants keep their
// literal name. Every expansion is exposed in the result, not a category guess.
const merchantNameSynonyms: ReadonlyArray<readonly string[]> = [['书店', '书局']];

/** Bounded, deterministic retrieval. A selection never fills intervening months. */
export function billPeriods(period?: Period): string[] | undefined {
  if (!period) return undefined;
  if (!validMonth(period.startPeriod) || !validMonth(period.endPeriod)) return [];
  if (period.kind === 'month') return period.startPeriod === period.endPeriod ? [period.startPeriod] : [];
  if (period.kind === 'selection') {
    const selected = period.periods;
    if (!selected?.length || selected.length > 12 || selected.some(value => !validMonth(value))) return [];
    const sorted = [...new Set(selected)].sort();
    return sorted[0] === period.startPeriod && sorted.at(-1) === period.endPeriod ? sorted : [];
  }
  if (period.startPeriod > period.endPeriod) return [];
  const values: string[] = [];
  let current = period.startPeriod;
  while (current <= period.endPeriod && values.length <= 12) {
    values.push(current);
    const year = Number(current.slice(0, 4)), month = Number(current.slice(5));
    current = month === 12 ? `${year + 1}-01` : `${current.slice(0, 4)}-${String(month + 1).padStart(2, '0')}`;
  }
  return values.length <= 12 ? values : [];
}

type Query = { kind: BillAnalysis['kind']; filter?: BillAnalysis['filter']; unsupported?: string };
const categories: BillCategory[] = ['餐饮', '购物', '交通', '住房', '订阅', '收入', '转账', '其他'];
/** Interpret only supported read-only questions; never turn an unknown filter into a total. */
function queryFromSource(request?: SemanticTask): Query {
  if (!request) return { kind: 'summary' };
  let text = request.source.text;
  const periodText = request.slots.billPeriod?.source.text;
  if (periodText) text = text.replace(periodText, ' ');
  if (/不含|不包括|排除|除去|超过|小于|大于|至少|至多|前\s*[一二三四五六七八九十\d]+|平均|中位|占比|增幅|退款|收入最高|收入最大/.test(text)) {
    return { kind: 'summary', unsupported: '这类筛选或比例计算尚未支持。请指定月度汇总、单笔最大消费、商户消费或两个完整月份的类别支出增量。' };
  }
  if (/比较|对比/.test(text) && /哪类|哪一类|哪个类别|分类|类别/.test(text) && /涨|增|多/.test(text)) return { kind: 'category_comparison' };
  if (/(?:金额|单笔)(?:最)?大|金额最高|最大(?:的)?(?:一笔|单笔)?(?:消费|支出)|最贵(?:的)?(?:一笔|消费)|(?:消费|支出).*(?:最高|最大)/.test(text)) {
    const phrase = text.split(/[，,。；;？?！!]/)[0]!.trim()
      .replace(/^(?:(?:请|帮我|替我|麻烦|先|只|仅|再|一下|列出|查询|查看|看看|查一下|查|统计|分析|报一下|告诉我|给我|找出)\s*)+/, '')
      .replace(/^(?:的\s*)?(?:账单(?:中|里|内|的)?\s*)?/, '').trim();
    const fullMaximum = /^(?:(?:金额|单笔)(?:最)?大|金额最高|最大(?:的)?(?:一笔|单笔)?|最贵(?:的)?(?:一笔)?)(?:的)?(?:消费|支出)(?:是(?:哪笔|什么)|及(?:其)?(?:原)?流水编号)?$/;
    if (!fullMaximum.test(phrase) && !/^(?:哪笔|哪一笔)(?:消费|支出)(?:金额)?(?:最高|最大)$/.test(phrase)) return { kind: 'largest_expense', unsupported: '带额外筛选的最大消费问题尚未支持。请明确查询全月最大单笔消费，或单独查询一个商户的消费总额。' };
    return { kind: 'largest_expense' };
  }
  if (/哪类|哪一类|哪个类别|哪家|哪笔|最多|最少|最小|最频繁|排名|按天|按周|小额|大额/.test(text)) return { kind: 'summary', unsupported: '这类排名或限定条件尚未支持，当前没有将问题改成整月汇总。' };
  // Isolate a single noun phrase directly modifying 消费/支出. Merchant filters
  // are transparent name-contains filters, not invented merchant categories.
  const first = text.split(/[，,。；;？?！!]/)[0]!.trim()
    .replace(/^(?:(?:请|帮我|替我|麻烦|先|只|仅|再|一下|列出|查询|查看|看看|查一下|查|统计|分析|报一下|告诉我|给我|算一下)\s*)+/, '')
    .replace(/^(?:的\s*)?(?:账单(?:中|里|内|的)?\s*)?/, '');
  const noun = first.match(/^(.+?)(?:的)?(?:消费|支出)(?:是|有|总|合计|多少|为|金额|[\s?？]|$)/)?.[1]?.replace(/的$/, '').trim();
  if (noun && !/^(?:收入[、与和及]?|总|全部|所有|各类|分类|本期|当期|本月)$/.test(noun)) {
    if (noun.length > 60 || /[、与和及]|比较|对比|按|每|最大|最高|全部|收入|净额|账单/.test(noun)
      || /^(?:各|各个|所有)?(?:商户|商家|店铺)(?:名称)?$/.test(noun)) return { kind: 'filtered_expense', unsupported: '请明确一个商户名称或一个消费类别；当前没有应用不确定的筛选条件。' };
    let value = noun.replace(/^[“「"]|[”」"]$/g, '');
    const categoryName = value.replace(/(?:类别|类)$/, '');
    if (categories.includes(categoryName as BillCategory)) value = categoryName;
    const kind = categories.includes(value as BillCategory) ? 'category' : 'merchant_contains';
    const terms = kind === 'merchant_contains' && !/^[“「"].+[”」"]$/.test(noun) ? merchantNameSynonyms.find(group => group.includes(value)) : undefined;
    return { kind: 'filtered_expense', filter: { kind, value, ...(terms ? { terms: [value, ...terms.filter(term => term !== value)] } : {}) } };
  }
  if (/比较|对比|排名|哪些商户|每笔|每天|每周/.test(text)) return { kind: 'summary', unsupported: '请指定支持的账单问题；当前没有将这个问题改成整月汇总。' };
  return { kind: 'summary' };
}

export function analyzeBills(input: { request?: SemanticTask; report?: BillReport; reports?: BillReport[] }): BillAnalysis {
  const query = queryFromSource(input.request);
  const supplied = input.reports ?? (input.report ? [input.report] : []);
  const requested = billPeriods(input.request?.slots.billPeriod);
  const periods = requested ?? [...new Set(supplied.map(report => report.period))].sort();
  const base: BillAnalysis = { status: 'complete', kind: query.kind, periods, missingPeriods: [], transactionIds: [], summary: '', findings: [], evidence: [], ...(query.filter ? { filter: query.filter } : {}) };
  const unsupported = (message: string) => ({ ...base, status: 'unsupported' as const, summary: message, clarification: message, findings: ['BILL_QUERY_UNSUPPORTED'] });
  if (!requested && !supplied.length) return { ...base, status: 'missing_data', summary: '当前未提供历史账单，无法生成消费分类或异常结论。', ...(input.request ? { clarification: '请提供对应月份的账单。' } : {}), findings: ['BILL_SCOPE_DATA_MISSING', '账单数据缺失；未将账户余额当作账单。'], evidence: [{ source: 'data-availability', detail: '没有账单明细。' }] };
  if (!periods.length) return unsupported('请提供有效账单月份；一次最多分析 12 个月，月份集合按明确列出的月份读取。');
  if (query.unsupported) return unsupported(query.unsupported);
  const selected = supplied.filter(report => periods.includes(report.period));
  if (new Set(selected.map(report => report.period)).size !== selected.length) return unsupported('同一个月份存在多份账单，当前无法确定应使用哪份证据。');
  const reports = periods.map(period => supplied.find(report => report.period === period));
  const missing = periods.filter((_, index) => !reports[index] || reports[index]!.coverage?.status === 'missing');
  const partial = periods.filter((_, index) => reports[index]?.coverage?.status === 'partial');
  if (query.kind === 'category_comparison') for (const period of partial) if (!missing.includes(period)) missing.push(period);
  const available = reports.filter((report): report is BillReport => !!report && report.coverage?.status !== 'missing');
  // Reports are server objects. Still refuse duplicate IDs, invalid amounts and
  // mismatched periods rather than calculating a plausible but false answer.
  const evidenceRows = new Map<string, BillTransaction>();
  const coverageById = new Map<string, string>();
  for (const report of available) for (const transaction of report.transactions) {
    if (!transaction.id.trim() || transactionPeriod(transaction) !== report.period
      || !/^[1-9]\d*$/.test(transaction.amountMinor) || evidenceRows.has(transaction.id)) return unsupported('账单流水证据存在重复或期间/金额不一致，当前无法给出可靠统计。');
    evidenceRows.set(transaction.id, transaction);
    coverageById.set(transaction.id, report.coverage?.status ?? 'supplied-report');
  }
  for (const report of available) {
    const ownIds = new Set(report.transactions.map(transaction => transaction.id));
    const priorIds = new Set<string>();
    for (const row of report.evidenceTransactions ?? []) {
      const existing = evidenceRows.get(row.id);
      if (!row.id.trim() || !/^[1-9]\d*$/.test(row.amountMinor) || transactionPeriod(row) !== previousPeriod(report.period)
        || priorIds.has(row.id) || (existing && !sameTransaction(existing, row))) return unsupported('账单的跨月引用存在重复或期间/金额不一致，当前无法确认有效证据。');
      priorIds.add(row.id);
      evidenceRows.set(row.id, row);
      if (!coverageById.has(row.id)) coverageById.set(row.id, 'recurring-reference-only');
    }
    for (const finding of report.findings) {
      const refs = finding.transactionIds;
      if (!refs.length || new Set(refs).size !== refs.length || refs.some(id => !ownIds.has(id) && !priorIds.has(id))) return unsupported('账单发现引用了未提供的流水，当前无法确认有效证据。');
      const current = refs.filter(id => ownIds.has(id)).map(id => evidenceRows.get(id)!);
      const prior = refs.filter(id => priorIds.has(id)).map(id => evidenceRows.get(id)!);
      if (finding.kind === 'RECURRING') {
        const row = current[0];
        if (current.length !== 1 || !row || !prior.length || row.direction !== 'OUT' || row.source !== 'SYNTHETIC_STATEMENT'
          || prior.some(previous => previous.source !== 'SYNTHETIC_STATEMENT' || previous.direction !== 'OUT' || previous.accountId !== row.accountId || previous.merchant !== row.merchant || previous.amountMinor !== row.amountMinor)) return unsupported('周期费用发现与上月同账户、同商户、同金额的原流水不一致，当前无法确认该结论。');
      } else if (prior.length) return unsupported('非周期性账单发现不能借用其他月份流水，当前无法确认有效证据。');
    }
  }
  const transactions = available.flatMap(report => report.transactions);
  const expenses = transactions.filter(transaction => transaction.direction === 'OUT');
  base.evidence = available.map(report => ({ source: `bill-report:${report.period}:${report.source}`, detail: `incomeMinor=${report.incomeMinor};expenseMinor=${report.expenseMinor};netMinor=${report.netMinor};coverage=${report.coverage?.status ?? 'supplied-report'}` }));
  const supportingEvidence = (rows: BillTransaction[]) => {
    const citedIds = new Set(rows.map(row => row.id));
    const findings = available.flatMap(report => report.findings.filter(finding => finding.transactionIds.some(id => citedIds.has(id))));
    const cited = new Map(rows.map(row => [row.id, row]));
    for (const finding of findings) for (const id of finding.transactionIds) cited.set(id, evidenceRows.get(id)!);
    return [
      ...[...cited.values()].map(row => ({ source: `bill-transaction:${row.id}`, detail: `${row.bookedAt};${row.merchant};${row.direction};${row.category};amountMinor=${row.amountMinor};coverage=${coverageById.get(row.id)}${citedIds.has(row.id) ? '' : ';purpose=finding-support-only;excluded-from-query-total'}` })),
      ...findings.map(finding => ({ source: `bill-finding:${finding.id}`, detail: finding.transactionIds.join(',') })),
    ];
  };
  const references = (rows: BillTransaction[]) => rows.slice(0, 10).map(row => `[${row.id}]`).join('、') + (rows.length > 10 ? `（共${rows.length}笔，完整编号见证据）` : '');
  if (missing.length) {
    const wanted = missing.map(periodLabel).join('、');
    const provided = available.length ? ` 已保留${available.map(report => `${periodLabel(report.period)}${report.coverage?.status === 'partial' ? '（不完整，仅局部流水）' : '（已提供账单）'}`).join('、')}及${transactions.length}笔流水证据${transactions.length ? `：${references(transactions)}` : ''}；这些数据不足以完成本次${query.kind === 'category_comparison' ? '比较' : '查询'}。` : '';
    return { ...base, status: 'missing_data', missingPeriods: missing, transactionIds: transactions.map(row => row.id), summary: `${wanted}账单数据未完整提供，无法完成本次${query.kind === 'category_comparison' ? '比较' : '查询'}。${provided} 未将缺失月份视为零支出。`, clarification: `请提供${wanted}的完整账单，或选择已有完整数据的月份。`, findings: ['BILL_SCOPE_DATA_MISSING', ...available.flatMap(report => report.findings.map(finding => `${finding.summary} [${finding.transactionIds.join(',')}]`))], evidence: [...base.evidence, ...supportingEvidence(transactions), { source: 'data-availability', detail: `${wanted}缺少完整报表；未将缺失月份视为零支出。` }] };
  }
  base.status = partial.length ? 'partial' : 'complete';
  const prefix = periods.join('、');
  const coverageNote = partial.length ? ' 以下仅统计当前已提供流水，相关月份尚不完整。' : '';
  if (partial.length) base.findings.push('BILL_DATA_PARTIAL');
  if (query.kind === 'largest_expense') {
    const maximum = expenses.reduce((current, row) => BigInt(row.amountMinor) > current ? BigInt(row.amountMinor) : current, 0n);
    const matching = expenses.filter(row => BigInt(row.amountMinor) === maximum).sort((a, b) => a.id.localeCompare(b.id));
    base.amountMinor = maximum.toString(); base.transactionIds = matching.map(row => row.id);
    base.summary = matching.length ? `${prefix}已提供流水中最大单笔消费为${money(maximum)}元${matching.length > 1 ? `，并列${matching.length}笔` : ''}：${matching.slice(0, 10).map(row => `${row.merchant} [${row.id}]`).join('；')}。${coverageNote}` : `${prefix}提供的账单中没有支出流水。${coverageNote}`;
  } else if (query.kind === 'filtered_expense') {
    const matching = expenses.filter(row => query.filter!.kind === 'category' ? row.category === query.filter!.value : (query.filter!.terms ?? [query.filter!.value]).some(term => row.merchant.includes(term)));
    const amount = matching.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
    base.amountMinor = amount.toString(); base.transactionIds = matching.map(row => row.id);
    const filter = query.filter!.kind === 'category' ? `「${query.filter!.value}」类别` : `商户名称含「${query.filter!.value}」${query.filter!.terms ? `或其名称别称${query.filter!.terms.filter(term => term !== query.filter!.value).map(term => `「${term}」`).join('、')}（仅按名称匹配）` : ''}`;
    base.summary = `${prefix}${filter}的已提供支出共${money(amount)}元，共${matching.length}笔${matching.length ? `：${references(matching)}` : ''}。${coverageNote}`;
  } else if (query.kind === 'category_comparison') {
    if (periods.length !== 2) return unsupported('类别支出增量比较需要明确两个完整月份。');
    const before = available[0]!.transactions.filter(row => row.direction === 'OUT'), after = available[1]!.transactions.filter(row => row.direction === 'OUT');
    base.categoryChanges = categories.filter(category => [...before, ...after].some(row => row.category === category)).map(category => {
      const previous = before.filter(row => row.category === category), current = after.filter(row => row.category === category);
      const beforeMinor = previous.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n), afterMinor = current.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n);
      return { category, beforeMinor: beforeMinor.toString(), afterMinor: afterMinor.toString(), changeMinor: (afterMinor - beforeMinor).toString(), transactionIds: [...previous, ...current].map(row => row.id) };
    });
    const largest = base.categoryChanges.reduce((maximum, row) => BigInt(row.changeMinor) > maximum ? BigInt(row.changeMinor) : maximum, 0n);
    const winners = largest > 0n ? base.categoryChanges.filter(row => BigInt(row.changeMinor) === largest) : [];
    base.largestIncreaseCategories = winners.map(row => row.category);
    base.transactionIds = expenses.map(row => row.id);
    base.summary = `${periods[1]}相对${periods[0]}，按类别支出金额增加值比较，${winners.length ? `${winners.map(row => row.category).join('、')}增加最多，增加${money(largest)}元。${winners.map(row => `${row.category}：${money(row.beforeMinor)}→${money(row.afterMinor)}元 [${row.transactionIds.join(',')}]`).join('；')}` : '没有类别支出上升。'}`;
  } else {
    base.transactionIds = transactions.map(row => row.id);
    base.summary = available.map(report => `${report.period}合成账单：收入${money(report.incomeMinor)}元，支出${money(report.expenseMinor)}元，净额${money(report.netMinor)}元。${input.request && /分类|类别|各类/.test(input.request.source.text) ? ` 分类：${report.categories.map(category => `${category.category}${money(category.amountMinor)}元 [${category.transactionIds.join(',')}]`).join('；')}。` : ''}`).join(' ') + coverageNote;
    base.findings.push(...available.flatMap(report => report.findings.map(finding => `${finding.summary} [${finding.transactionIds.join(',')}]`)));
  }
  const citedIds = new Set(base.transactionIds);
  base.evidence.push(...supportingEvidence(transactions.filter(transaction => citedIds.has(transaction.id))));
  return base;
}
