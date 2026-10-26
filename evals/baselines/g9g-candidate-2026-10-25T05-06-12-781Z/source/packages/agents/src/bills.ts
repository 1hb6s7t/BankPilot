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
const queryNounPhrase = (text: string) => text.trim()
  // Adverbs qualify the request verb, not the merchant. For example, removing
  // “准确告诉我” must not turn “准确书店” into a different merchant name.
  .replace(/^(?:(?:请|帮我|替我|让我|麻烦|先|只|仅|再|一下)\s*|(?:(?:准确|详细|清楚)(?:地)?\s*)?(?:(?:我)?(?:想|希望|需要|要)(?:知道|看到|查看|看看|核对|查询)|列出|列一下|查询|查看|看看|查一下|查|核对|统计|分析|报一下|告诉我|给我|找出|算一下)\s*)+/, '')
  .replace(/^(?:的\s*)?(?:账单(?:中|里|内|的)?\s*)?/, '').trim();

/** Period coordinates are absolute UTF-16 positions in the original message,
 * whereas this parser sees a task-local text. Never remove an arbitrary first
 * textual match: it may be part of a literal merchant name. */
function sourceWithoutBillPeriod(request: SemanticTask): string | undefined {
  const scope = request.source, period = request.slots.billPeriod?.source;
  const coordinates = (span: SemanticTask['source']) => {
    if (span.start === undefined && span.end === undefined) return 'absent';
    return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start! >= 0
      && span.end! > span.start! && span.end! - span.start! === span.text.length ? 'bound' : 'invalid';
  };
  const scopeCoordinates = coordinates(scope);
  if (scopeCoordinates === 'invalid') return undefined;
  if (!request.slots.billPeriod) return scope.text;
  if (!period?.text || coordinates(period) === 'invalid') return undefined;
  const outside: boolean[] = [];
  const closes: Record<string,string> = { '“':'”', '「':'」', '"':'"' };
  let close: string | undefined;
  // Index by code unit, matching SemanticSource coordinates even after emoji.
  for (let index = 0; index < scope.text.length; index++) {
    const char = scope.text[index]!;
    outside[index] = !close && !closes[char];
    if (close) { if (char === close) close = undefined; }
    else if (closes[char]) close = closes[char];
  }
  if (close) return undefined;
  const validOccurrence = (start: number,end: number) => start >= 0 && end <= scope.text.length && end > start
    && scope.text.slice(start,end) === period.text && outside.slice(start,end).every(Boolean)
    && !(/^\d/.test(period.text) && /\d/.test(scope.text[start - 1] ?? ''))
    && !/[\d年月日/-]/.test(scope.text[end] ?? '');
  let start: number, end: number;
  if (coordinates(period) === 'bound') {
    if (scopeCoordinates !== 'bound') return undefined;
    start = period.start! - scope.start!; end = period.end! - scope.start!;
    if (!validOccurrence(start,end)) return undefined;
  } else {
    const candidates: number[] = [];
    for (let found = scope.text.indexOf(period.text); found !== -1; found = scope.text.indexOf(period.text,found + 1)) {
      if (validOccurrence(found,found + period.text.length)) candidates.push(found);
      if (candidates.length > 1) return undefined;
    }
    if (candidates.length !== 1) return undefined;
    start = candidates[0]!; end = start + period.text.length;
  }
  // Consume the temporal preposition only at this verified period boundary.
  // A 在 inside a quoted merchant, or elsewhere in its name, remains untouched.
  const temporal = scope.text.slice(0,start).match(/(?:在|于)\s*$/);
  if (temporal && outside.slice(start - temporal[0].length,start).every(Boolean)) start -= temporal[0].length;
  return scope.text.slice(0,start) + ' ' + scope.text.slice(end);
}

// Delimit clauses only outside literal merchant quotes. No clause may disappear
// unless it is empty context, a supported display requirement or read-only scope.
function queryClauses(text: string): string[] | undefined {
  const clauses: string[] = [];
  const closes: Record<string, string> = { '“': '”', '「': '」', '"': '"' };
  let clause = '', close: string | undefined;
  for (const char of text) {
    if (close) {
      clause += char;
      if (char === close) close = undefined;
    } else if (closes[char]) {
      close = closes[char]; clause += char;
    } else if (/[，,。；;？?！!：:]/.test(char)) {
      clauses.push(clause); clause = '';
    } else clause += char;
  }
  if (close) return undefined;
  clauses.push(clause);
  return clauses.map(clause => clause.trim()).filter(Boolean);
}
// Display grammar names outputs of the SAME query. It cannot mention another
// merchant/category, select a time/channel/amount range, negate a metric, or add
// a second calculation. Lists compose fields without a whole-sentence whitelist.
const displayField = /^(?:金额|合计(?:金额)?|总额|(?:那笔|这笔|对应的?|相应的?|相关的?|其|每笔|各笔|原始的?|原|支持(?:合计|判断)的|可核验的|已提供的|匹配的){0,3}(?:流水|交易)(?:的)?(?:编号|引用|明细|记录)?|账单证据)$/;
const displayHead = /^(?:(?:我)?(?:想|希望|需要|要)(?:看到|知道|查看|看)|给出|给我|列出|列一下|提供|展示|显示|附上|保留|告诉我|报一下)/;
const displayLead = /^(?:(?:请|麻烦|帮我|替我|也|并|同时|再|以及|还请|还|且|一并)(?:准确|详细|清楚)?(?:地)?)+/;
const noActionClause = /^(?:别|不要|不用)(?:据此)?(?:替我|帮我)?(?:修改|改|调整|取消|建立)(?:任何)?(?:订阅|设置|预算)$/;
const readOnlyClause = /^(?:这次|本次|现在)?(?:都)?(?:只|仅)(?:看|查询|查看)(?:信息|账单信息|结果)$/;
const expenseTail = '(?:(?:是|有|为)?(?:多少(?:钱)?|多大)|(?:总额|总金额|金额|总共|一共|合计|总计)(?:(?:是|有|为)?多少(?:钱)?)?)?';
function isDisplayRequirement(source: string): boolean {
  const text = source.replace(/\s/g, '').replace(displayLead, '').replace(/^(?:准确|详细|清楚)(?:地)?/, '');
  if (/^(?:按|按照|依据|根据)(?:当前|已提供的)?(?:合成)?账单(?:的)?(?:原始)?(?:证据|流水)?(?:给出|作答|回答|说明|展示)$/.test(text)
    || /^以(?:当前|已提供的)?(?:合成)?账单(?:证据|流水)?为(?:依据|准)(?:给出|作答|回答|说明)?$/.test(text)) return true;
  const objectFirst = text.match(/^(?:把)?(.+?)(?:也|都|一并)?(?:列出来|列出|给我|给出|提供|展示|附上|保留)$/);
  const fields = displayHead.test(text) ? text.replace(displayHead, '') : objectFirst?.[1];
  return !!fields && fields.split(/、|以及|与|和|及/).every(field => displayField.test(field));
}
function queryWithDisplaySuffix(source: string): string {
  // Only a fully recognized display suffix permits a split, and only outside
  // merchant quotes. Unknown suffixes remain attached for normal rejection.
  let close: string | undefined;
  const closes: Record<string,string> = { '“':'”', '「':'」', '"':'"' };
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (close) { if (char === close) close = undefined; continue; }
    if (closes[char]) { close = closes[char]; continue; }
    if (index > 0 && /并|且|再|也|及|同|还/.test(char) && isDisplayRequirement(source.slice(index))) return source.slice(0,index).trim();
  }
  return source;
}
function isSummaryQuestion(source: string): boolean {
  const text = source.replace(/\s/g, '').replace(/^(?:以及|还有|另外|并且|同时)/, '');
  if (/^(?:(?:收入|支出|消费)(?:分类|类别)|分类|类别|各类|月度汇总|汇总|概况|账单)$/.test(text)) return true;
  const metric = '(?:收入|支出|消费|净额|收支净额|收支(?:合计|汇总)?|开销|花费|进账|入账|钱?(?:进来|进了|入账|进账)(?:了)?|钱?(?:花出去|花了|花掉)(?:了)?(?:的钱)?)';
  const unit = new RegExp(`^${metric}${expenseTail}$`);
  const prefix = /^(?:(?:本期|当期|本月|全月|全部|所有|最后|最终|总共|一共|合计|总计|总)(?:的)?|我的?)/;
  const metricQuestion = (part: string) => {
    // A bounded deterministic scan avoids exponential ambiguity between 我的,
    // 我 + 的 and repeated optional prefixes on a long unknown request.
    for (let count = 0; count < 4; count++) {
      const token = part.match(prefix)?.[0];
      if (!token) break;
      part = part.slice(token.length);
    }
    return unit.test(part);
  };
  return !!text && text.split(/、|以及|与|和|及/).every(metricQuestion);
}

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
  const text = sourceWithoutBillPeriod(request);
  const unsupported = (kind: BillAnalysis['kind'] = 'summary'): Query => ({ kind, unsupported: '请指定支持的账单问题，并明确一个商户名称或消费类别；当前没有将未识别的筛选条件改成整月汇总。' });
  if (text === undefined) return unsupported();
  const clauses = queryClauses(text);
  if (!clauses) return unsupported();
  const questions: string[] = [];
  let billContext = false;
  for (const clause of clauses) {
    if (isDisplayRequirement(clause) || noActionClause.test(clause.replace(/^请/, '')) || readOnlyClause.test(clause.replace(/^请/, ''))) continue;
    // Scope-changing negation/limits remain substantive even when an earlier
    // polite prefix would otherwise leave a plausible merchant noun. Literal
    // quoted names are data, never a reason to erase an outside constraint.
    const constraintText = clause.replace(/“[^“”]*”|「[^「」]*」|"[^"]*"/g, '名称');
    if (/不含|不包括|排除|除去|除了|除外|以外|不计|不算|剔除|忽略|不要|不想|不能|不得|不许|不是|不(?:查|看|统计|计算|分析|列|报|算)|别(?=查|看|统计|计算|分析|列|报|算)|勿|仅限|只要|除[^，,。；;？?！!]{1,60}外的?(?:消费|支出)|非(?:餐饮|购物|交通|住房|订阅|收入|转账|其他)/.test(constraintText)) return unsupported();
    const phrase = queryNounPhrase(queryWithDisplaySuffix(clause));
    if (!phrase) { billContext ||= /账单/.test(clause); continue; }
    if (noActionClause.test(phrase) || readOnlyClause.test(phrase)) continue;
    questions.push(phrase);
  }
  // Complementary monthly metrics may be requested in separate clauses. A
  // merchant/category question or a maximum is a different substantive query.
  if ((questions.length > 0 && questions.every(isSummaryQuestion)) || (!questions.length && billContext)) return { kind: 'summary' };
  const summary = questions.join('、');
  const comparisonQuestion = /^(?:哪类|哪一类|哪个类别|分类|类别)(?:消费|支出)?(?:金额)?(?:涨得最多|增加最多|增多最多|增量最大|增加值最大)$/;
  if ((questions.length === 1 && /^(?:比较|对比)\s*/.test(summary) && comparisonQuestion.test(summary.replace(/^(?:比较|对比)\s*/, '')))
    || (questions.length === 2 && /^(?:把)?\s*(?:支出|消费)(?:金额)?按(?:类别|分类)(?:比较|对比)(?:一下)?$/.test(questions[0]!) && comparisonQuestion.test(questions[1]!))) return { kind: 'category_comparison' };
  // A second question or an unknown clause is a scope constraint, never a
  // disposable suffix. The supported single query cannot answer both safely.
  if (questions.length !== 1) return unsupported();
  const phrase = questions[0]!;
  const substantiveText = phrase.replace(/“[^“”]*”|「[^「」]*」|"[^"]*"/g, '名称');
  if (/不含|不包括|排除|除去|超过|小于|大于|至少|至多|前\s*[一二三四五六七八九十\d]+|平均|中位|占比|增幅|退款|收入最高|收入最大/.test(substantiveText)) return unsupported();
  if (/(?:金额|单笔)(?:最)?大|金额最高|最大(?:的)?(?:一笔|单笔)?(?:消费|支出)|最贵(?:的)?(?:一笔|消费)|(?:消费|支出).*(?:最高|最大)/.test(substantiveText)) {
    const fullMaximum = /^(?:(?:金额|单笔)(?:最)?大|金额最高|最大(?:的)?(?:一笔|单笔)?|最贵(?:的)?(?:一笔)?)(?:的)?(?:消费|支出)(?:是(?:哪笔|什么)|(?:金额)?(?:是|有|为)?多少(?:钱)?|及(?:其)?(?:原)?流水编号)?$/;
    if (!fullMaximum.test(phrase) && !/^(?:哪笔|哪一笔)(?:消费|支出)(?:金额)?(?:最高|最大)$/.test(phrase)) return unsupported('largest_expense');
    return { kind: 'largest_expense' };
  }
  if (/哪类|哪一类|哪个类别|哪家|哪笔|最多|最少|最小|最频繁|排名|按天|按周|小额|大额/.test(substantiveText)) return unsupported();
  // Fully consume a supported expense predicate; an unrecognized predicate or
  // remainder cannot fall back to a summary. Names are taken only from source.
  const noun = phrase.match(new RegExp(`^(.+?)(?:的)?(?:总)?(?:消费|支出)${expenseTail}$`))?.[1]?.trim()
    ?? phrase.match(/^(.+?)(?:一共|总共|合计|总计|共)?(?:扣了|扣|花了|花费了|消费了|支出了)(?:我)?(?:多少(?:钱)?|金额(?:是|为)?多少)$/)?.[1]?.trim();
  if (!noun) return unsupported();
  const quoted = /^(?:“[^“”]+”|「[^「」]+」|"[^"]+")$/.test(noun);
  if ((!quoted && /[“”「」"]/.test(noun)) || noun.length > 60 || (!quoted && (/[、与和及]|比较|对比|按|每|最大|最高|全部|收入|净额|账单|一共|总共|合计|总计|告诉我|查询|查看|查一下|看看|统计|分析|列出|找出|算一下|扣|花了|消费|支出|使用|信用卡|借记卡|银行卡|账户|尾号|周末|工作日|线上|线下|现金|刷卡|支付宝|微信|早上|晚上|上午|下午|日期|\d{4}[-/年]/.test(noun)
    || /^(?:(?:各|各个|所有)?(?:商户|商家|店铺)(?:名称)?$|我在|在|本周|上周|这周)/.test(noun)))) return unsupported('filtered_expense');
  let value = quoted ? noun.slice(1, -1) : noun.replace(/的$/, '');
  const categoryName = value.replace(/(?:类别|类)$/, '');
  if (!quoted && categories.includes(categoryName as BillCategory)) value = categoryName;
  const kind = !quoted && categories.includes(value as BillCategory) ? 'category' : 'merchant_contains';
  const terms = kind === 'merchant_contains' && !quoted ? merchantNameSynonyms.find(group => group.includes(value)) : undefined;
  return { kind: 'filtered_expense', filter: { kind, value, ...(terms ? { terms: [value, ...terms.filter(term => term !== value)] } : {}) } };
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
        // A finding may describe one charge or a group of matching charges.
        // Validate every member against the same key; neither grouping nor a
        // prior reference changes which current-month rows enter the totals.
        if (!row || !prior.length
          || [...current, ...prior].some(member => member.source !== 'SYNTHETIC_STATEMENT' || member.direction !== 'OUT' || member.accountId !== row.accountId || member.merchant !== row.merchant || member.amountMinor !== row.amountMinor)) return unsupported('周期费用发现与上月同账户、同商户、同金额的原流水不一致，当前无法确认该结论。');
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
