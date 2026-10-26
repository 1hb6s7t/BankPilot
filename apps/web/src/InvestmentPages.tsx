import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, CalendarClock, CheckCircle2, Clock3, Fingerprint, Landmark, RefreshCw, ShieldAlert, Wallet } from 'lucide-react';
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { FundsTimeline, InvestmentAction, InvestmentDashboard, InvestmentPosition, RedemptionInput } from '../../../packages/contracts/src';
import { api, getApiSessionSignal, unwrapPublicKeyOptions } from './api';
import { useCommandRecovery, CommandRecoveryNotice } from './commandRecovery';

type Props = { accountId?: string; planActions?: InvestmentAction[]; onRefresh?: () => Promise<void> };
const active = (status: InvestmentAction['status']) => ['AWAITING_VERIFICATION', 'AUTHORIZED', 'SUBMITTING', 'UNKNOWN', 'SETTLING'].includes(status);
function money(minor: string) { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(BigInt(minor || '0')) / 100); }
function dateTime(value?: string) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
function statusName(status: InvestmentAction['status']) {
  const values: Record<InvestmentAction['status'], string> = { AWAITING_CONFIRMATION: '待确认', AWAITING_VERIFICATION: '待 Passkey 强验证', AUTHORIZED: '已授权', SUBMITTING: '正在处理', UNKNOWN: '结果待查', SETTLING: '模拟结算中 · 未到账', SUCCEEDED: '已结算', FAILED: '失败', CANCELLED: '已取消', EXPIRED: '已过期' };
  return values[status];
}

export function InvestmentPages({ accountId, planActions = [], onRefresh }: Props) {
  const [dashboard, setDashboard] = useState<InvestmentDashboard>();
  const [timeline, setTimeline] = useState<FundsTimeline>();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<InvestmentAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [revision, setRevision] = useState(0);
  const mounted = useMounted();
  const readVersion = useRef(0);
  const operationLock = useRef(false);
  const recovery = useCommandRecovery<RedemptionInput, InvestmentAction>({
    family: 'investment', slot: 'investment-redemption', send: api.prepareRedemption, lookup: api.investmentCommand,
    onResolved: (action) => {
      if (!mounted.current) return;
      setActions((current) => mergeInvestmentActions(current, [action]));
      setNotice(`已读取 ${action.productName} 原赎回请求。请以本单的最新状态和回执为准；需要授权的操作仍须逐笔完成 Passkey 强验证。`);
      void refresh(); void onRefresh?.().catch(() => undefined);
    },
  });

  const refresh = useCallback(async () => {
    const current = ++readVersion.current; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) return;
    setLoading(true);
    try {
      const [nextDashboard, nextTimeline] = await Promise.all([api.investments(), api.investmentTimeline(accountId, 30)]);
      if (!isCurrent() || current !== readVersion.current) return;
      setDashboard(nextDashboard); setTimeline(nextTimeline);
      setActions((current) => mergeInvestmentActions(current, nextDashboard.actions));
    } catch (reason) { if (isCurrent() && current === readVersion.current) setError(reason instanceof Error ? reason.message : '理财数据暂不可用。'); }
    finally { if (isCurrent() && current === readVersion.current) setLoading(false); }
  }, [accountId]);

  useEffect(() => { void refresh(); }, [refresh, revision]);
  useEffect(() => { setActions((current) => mergeInvestmentActions(current, planActions)); }, [planActions]);
  const allActions = useMemo(() => mergeInvestmentActions(actions, dashboard?.actions, planActions), [actions, dashboard?.actions, planActions]);
  const polling = allActions.some((action) => active(action.status));
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(timer);
  }, [polling, refresh]);

  async function prepare(position: InvestmentPosition) {
    if (operationLock.current || recovery.busy) return;
    const amountMinor = toMinor(amounts[position.id] ?? '');
    if (!amountMinor) { setError('请输入有效的正数赎回金额，最多两位小数。'); return; }
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    setBusy(position.id); setError(undefined); setNotice(undefined);
    try { await recovery.execute({ positionId: position.id, amountMinor, expectedVersion: position.version }); }
    catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : '赎回候选生成失败。'); }
    finally { operationLock.current = false; if (isCurrent()) setBusy(undefined); }
  }

  return <section className="business-page investment-page">
    <header className="business-page-heading"><div><span className="section-kicker">合成理财产品 · T+0 / T+2</span><h1>持仓与赎回</h1><p>仅展示本地合成产品。赎回逐笔经过 Passkey 强验证；“模拟结算中”不计入现金余额。</p></div><button className="button button-outline" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新理财状态</button></header>
    <CommandRecoveryNotice recovery={recovery} />
    {notice && <div className="notice notice-info" role="status">{notice}</div>}{error && <div className="business-error" role="alert">{error}<button className="button button-outline" onClick={() => setRevision((v) => v + 1)}>重试</button></div>}
    {loading && !dashboard && <div className="business-loading"><span className="loader loader-small" />正在读取合成持仓…</div>}
    {dashboard && <>
      <div className="investment-summary"><article className="panel investment-summary-card"><span>合成账户</span><strong>{accountId ? '当前演示账户' : '—'}</strong><small>产品日历 {dashboard.calendar} · 业务日 {dashboard.businessDate}</small></article><article className="panel investment-summary-card"><span>持仓产品</span><strong>{dashboard.positions.length} 项</strong><small>不接真实行情，不承诺收益</small></article><article className="panel investment-summary-card"><span>待结算赎回</span><strong>{allActions.filter((a) => a.status === 'SETTLING' || a.status === 'UNKNOWN' || a.status === 'SUBMITTING').length} 笔</strong><small>未结算金额不作为现金</small></article></div>
      <section className="investment-section"><div className="business-panel-heading"><div><span className="section-kicker">我的持仓</span><h2>合成产品份额</h2></div><span className="synthetic-tag"><i />模拟数据</span></div>
        <div className="investment-position-grid">{dashboard.positions.map((position) => <PositionCard key={position.id} position={position} amount={amounts[position.id] ?? ''} busy={busy === position.id || recovery.busy} onAmount={(value) => setAmounts((v) => ({ ...v, [position.id]: value }))} onPrepare={() => void prepare(position)} />)}{dashboard.positions.length === 0 && <div className="panel management-empty">当前账户没有合成持仓。</div>}</div>
      </section>
      {allActions.length > 0 && <section className="investment-section"><div className="business-panel-heading"><div><span className="section-kicker">赎回授权与状态</span><h2>确认卡与到账时间线</h2></div><span className="count-badge">{allActions.length}</span></div><div className="investment-action-list">{allActions.map((action) => <InvestmentActionCard key={action.id} action={action} onRefresh={onRefresh} onUpdated={(next) => { setActions((current) => mergeInvestmentActions(current, [next])); setRevision((v) => v + 1); void onRefresh?.().catch(() => undefined); }} />)}</div></section>}
    </>}
    {timeline && <FundsTimelinePanel timeline={timeline} />}
  </section>;
}

export function mergeInvestmentActions(...groups: (InvestmentAction[] | undefined)[]) {
  const map = new Map<string, InvestmentAction>();
  const rank: Record<InvestmentAction['status'], number> = { AWAITING_CONFIRMATION: 1, AWAITING_VERIFICATION: 2, AUTHORIZED: 3, SUBMITTING: 4, UNKNOWN: 5, SETTLING: 6, CANCELLED: 7, EXPIRED: 8, FAILED: 9, SUCCEEDED: 10 };
  for (const group of groups) for (const action of group ?? []) {
    const current = map.get(action.id);
    if (!current || action.updatedAt > current.updatedAt || (action.updatedAt === current.updatedAt && rank[action.status] > rank[current.status])) map.set(action.id, action);
  }
  return [...map.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function PositionCard({ position, amount, busy, onAmount, onPrepare }: { position: InvestmentPosition; amount: string; busy: boolean; onAmount: (value: string) => void; onPrepare: () => void }) {
  const percentage = Math.max(0, Math.min(100, Number(BigInt(position.availableMinor) * 100n / (BigInt(position.principalMinor) || 1n))));
  return <article className="panel investment-position-card"><div className="investment-product-heading"><span className="management-icon"><Landmark size={17} /></span><div><strong>{position.productName}</strong><span>合成持仓 · 版本 {position.version}</span></div></div><div className="investment-holding"><span>持有本金</span><strong>{money(position.principalMinor)}</strong></div><div className="investment-holding-row"><span>可赎回</span><b>{money(position.availableMinor)}</b><span>处理中占用</span><b>{money(position.reservedMinor)}</b></div><div className="investment-progress"><i style={{ width: `${percentage}%` }} /></div><small>合成结算规则 {position.redemptionBusinessDays === 0 ? 'T+0' : `T+${position.redemptionBusinessDays}`} · {position.calendar}</small><div className="investment-redeem-form"><label><span>赎回金额（元）</span><input aria-label={`${position.productName}赎回金额（元）`} inputMode="decimal" value={amount} onChange={(event) => onAmount(event.target.value)} placeholder="例如 1000.00" /></label><button className="button button-primary" onClick={onPrepare} disabled={busy || !amount.trim()}>{busy ? '生成候选中…' : <><ArrowDownToLine size={15} />预览并准备赎回</>}</button></div></article>;
}

export function InvestmentActionCard({ action, onUpdated, onRefresh }: { action: InvestmentAction; onUpdated: (action: InvestmentAction) => void; onRefresh?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [registering, setRegistering] = useState(false); const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>();
  const canAuthenticate = action.status === 'AWAITING_VERIFICATION';
  const canCancel = ['AWAITING_VERIFICATION', 'AWAITING_CONFIRMATION'].includes(action.status);
  const canReconcile = action.status === 'UNKNOWN';
  const needsInitialRead = ['AWAITING_CONFIRMATION', 'AWAITING_VERIFICATION', 'UNKNOWN'].includes(action.status);
  const [readRequired, setReadRequired] = useState(needsInitialRead); const readRequiredRef = useRef(needsInitialRead);
  const mounted = useMounted(); const operationLock = useRef(false);
  async function run(kind: 'authorize' | 'register' | 'cancel' | 'reconcile') {
    if (operationLock.current || readRequiredRef.current) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) { operationLock.current = false; return; }
    setBusy(true); setRegistering(kind === 'register'); setError(undefined); setNotice(undefined);
    try {
      let next: InvestmentAction | undefined;
      if (kind === 'authorize') {
        const options = await api.investmentAuthenticationOptions(action.id);
        if (!isCurrent()) return;
        const response = await startAuthentication({ optionsJSON: unwrapPublicKeyOptions(options) as unknown as PublicKeyCredentialRequestOptionsJSON });
        if (!isCurrent()) return;
        next = await api.investmentAuthenticationVerify(action.id, response);
      } else if (kind === 'register') {
        const options = await api.registerOptions();
        if (!isCurrent()) return;
        const response = await startRegistration({ optionsJSON: unwrapPublicKeyOptions(options) as unknown as PublicKeyCredentialCreationOptionsJSON });
        if (!isCurrent()) return;
        await api.registerVerify(response);
      } else next = await (kind === 'cancel' ? api.cancelInvestment(action.id) : api.reconcileInvestment(action.id));
      if (!isCurrent()) return;
      if (next) onUpdated(next);
      setNotice(kind === 'register' ? 'Passkey 已登记，请返回本动作完成强验证。' : '已提交本次操作。请查看本单的最新状态和回执。');
      void onRefresh?.().catch(() => undefined);
    } catch (reason) {
      if (!isCurrent()) return;
      readRequiredRef.current = true; setReadRequired(true);
      const original = reason instanceof Error ? reason.message : '赎回动作请求失败。';
      setError(original);
      try {
        const next = await api.investmentAction(action.id);
        if (!isCurrent()) return;
        readRequiredRef.current = false; setReadRequired(false);
        onUpdated(next);
        setNotice(`已只读核对原赎回单。请以本单的最新状态和回执为准。${kind === 'register' ? '此查单不证明 Passkey 已登记；请刷新账户核对。' : '未自动重新授权、取消或提交查单。'}`);
        void onRefresh?.().catch(() => undefined);
      } catch (recoveryError) {
        if (isCurrent()) setNotice(`原赎回单暂未核对成功：${recoveryError instanceof Error ? recoveryError.message : '读取失败'}。请先刷新原单，避免重复操作。`);
      }
    } finally { operationLock.current = false; if (isCurrent()) { setBusy(false); setRegistering(false); } }
  }
  async function readOriginal() {
    if (operationLock.current) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) { operationLock.current = false; return; }
    setBusy(true);
    try {
      const next = await api.investmentAction(action.id);
      if (!isCurrent()) return;
      readRequiredRef.current = false; setReadRequired(false); onUpdated(next);
      setNotice('已只读核对原赎回单。请核对本单的最新状态和回执后选择后续操作。');
    } catch (reason) { if (isCurrent()) setNotice(`原赎回单仍未核对成功：${reason instanceof Error ? reason.message : '读取失败'}。已暂停后续操作，请再次查询原单。`); }
    finally { operationLock.current = false; if (isCurrent()) setBusy(false); }
  }
  useEffect(() => {
    if (needsInitialRead) void readOriginal();
    // A replacement action has a new key; only GET is permitted on mount.
  }, [action.id]);
  const strongAuth = () => run('authorize');
  const register = () => run('register');
  const cancel = () => run('cancel');
  const reconcile = () => run('reconcile');
  return <article className={`panel investment-action-card ${action.status === 'FAILED' ? 'investment-action-failed' : ''}`}>
    <div className="investment-action-heading"><div><span className="management-action-kind"><ShieldAlert size={13} />红档 · Passkey 强验证</span><h3>{action.productName}赎回</h3></div><span className={`management-action-status ${action.status === 'SUCCEEDED' ? 'status-success' : action.status === 'FAILED' || action.status === 'EXPIRED' ? 'status-danger' : active(action.status) ? 'status-warning' : 'status-pending'}`}>{statusName(action.status)}</span></div>
    <div className="investment-action-facts"><span>赎回金额 <b>{money(action.amountMinor)}</b></span><span>手续费 <b>{money(action.feeMinor)}</b></span><span>预计净额 <b>{money(action.netAmountMinor)}</b></span><span>预计模拟到账 <b>{dateTime(action.expectedSettlementAt)}</b></span></div>
    {action.status === 'SETTLING' && <p className="investment-settling-note"><Clock3 size={14} />正在等待合成结算日；此金额仍未入账，不计入可用现金。</p>}
    {action.receipt && <div className="management-receipt"><CheckCircle2 size={14} /><div><strong>模拟结算已完成</strong><span>到账 {money(action.receipt.amountMinor)} · {dateTime(action.receipt.settledAt)}</span><small>模拟流水 {action.receipt.providerTransactionId}</small></div></div>}
    {action.failureReason && <p className="management-error" role="alert">{action.failureReason}</p>}{error && <p className="management-error" role="alert">{error}</p>}{notice && <p className="management-success" role="status">{notice}</p>}
    <div className="investment-action-controls">{readRequired && <button type="button" className="button button-outline" disabled={busy} onClick={() => void readOriginal()}>只读查询原赎回单</button>}{canAuthenticate && <><button className="button button-dark" onClick={() => void strongAuth()} disabled={busy || readRequired}><Fingerprint size={15} />{busy ? '验证中…' : 'Passkey 强验证并确认赎回'}</button><button className="button button-outline" onClick={() => void register()} disabled={busy || registering || readRequired}>{registering ? '注册中…' : '还没有 Passkey？先注册'}</button></>}{canCancel && <button className="button button-outline" onClick={() => void cancel()} disabled={busy || readRequired}>取消赎回候选</button>}{canReconcile && <button className="button button-warning" onClick={() => void reconcile()} disabled={busy || readRequired}><RefreshCw size={14} />{busy ? '查询中…' : '查询原赎回单'}</button>}</div>
    <small className="management-action-expiry">版本 {action.actionVersion} · 摘要 {action.actionHash.slice(0, 14)}… · 动作有效至 {dateTime(action.expiresAt)}</small>
  </article>;
}

function FundsTimelinePanel({ timeline }: { timeline: FundsTimeline }) {
  const eventDates = new Set(timeline.days.filter((day) => day.events.length).map((day) => day.date));
  const today = timeline.days[0]?.date ?? timeline.asOf;
  return <section className="investment-section funds-timeline-section"><div className="business-panel-heading"><div><span className="section-kicker">账户现金时间线 · {timeline.timezone}</span><h2>未来 30 日资金预演</h2></div><span className="synthetic-tag"><i />合成日历</span></div><div className="funds-timeline-summary"><article><span>当前余额</span><b>{money(timeline.balanceMinor)}</b></article><article><span>转账占额</span><b>{money(timeline.reservedTransferMinor)}</b></article><article><span>当前可安排</span><b>{money(timeline.spendableNowMinor)}</b></article><article><span>生活保留底线</span><b>{money(timeline.minimumBalanceMinor)}</b></article></div>{timeline.warnings.length > 0 && <ul className="funds-timeline-warnings">{timeline.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}<div className="funds-timeline-list">{timeline.days.filter((day) => eventDates.has(day.date) || day.date === today).map((day) => <article className="funds-timeline-row" key={day.date}><time>{day.date}</time><div className="funds-timeline-events">{day.date === today && <span className="timeline-event timeline-event-balance"><Wallet size={13} />当前基准 · {money(timeline.balanceMinor)}</span>}{day.events.map((event) => <span key={event.id} className={`timeline-event ${event.certainty === 'UNCERTAIN' ? 'timeline-event-uncertain' : event.kind === 'OBLIGATION' ? 'timeline-event-obligation' : ''}`}><CalendarClock size={13} />{event.title} · {event.kind === 'OBLIGATION' ? `-${money(event.amountMinor)}` : `+${money(event.amountMinor)}`} {event.certainty === 'UNCERTAIN' ? '· 不确定' : event.kind === 'REDEMPTION_EXPECTED' ? '· 预计，未到账' : ''}</span>)}</div><strong className={day.conservativeCashMinor === '0' ? 'timeline-cash-low' : ''}>{money(day.projectedCashMinor)}</strong><small>预计现金</small><span className="timeline-secondary-cash">保守现金 {money(day.conservativeCashMinor)} · 预计保留后余量 {money(day.protectedHeadroomMinor)}</span></article>)}{timeline.days.every((day) => day.events.length === 0) && <p className="no-report-data">未来 30 日没有已安排的现金事件。</p>}</div><p className="funds-timeline-footnote">预计赎回只显示为未来现金事件。到达合成结算终态前，保守现金与当前可用余额不包含该笔金额。</p></section>;
}

function toMinor(value: string): string | undefined {
  const normalized = value.trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const [yuan, fraction = ''] = normalized.split('.'); const minor = BigInt(yuan || '0') * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return minor > 0n ? minor.toString() : undefined;
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}
function operationGuard(mounted: { current: boolean }) {
  const signal = getApiSessionSignal();
  return () => mounted.current && !signal?.aborted && signal === getApiSessionSignal();
}
