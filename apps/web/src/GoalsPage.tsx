import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, CalendarDays, CheckCircle2, Circle, Clock3, Fingerprint, Goal, RefreshCw, Route, ShieldAlert } from 'lucide-react';
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { AccountView, ActionView, GoalDraft, GoalNode, GoalView, InvestmentAction, PayeeView, CreateGoalInput, ReplanGoalInput } from '../../../packages/contracts/src';
import { api, getApiSessionSignal, unwrapPublicKeyOptions } from './api';
import { useCommandRecovery, CommandRecoveryNotice } from './commandRecovery';
import { InvestmentActionCard } from './InvestmentPages';
import { transferStatusLabel } from './actionStatus';
import { goalNodeStatusForAction, mergeGoalSnapshot, mergeGoalSnapshots } from './goalState';

type Props = { accountId?: string; accounts: AccountView[]; payees: PayeeView[]; suggestedGoal?: GoalView; requestedGoalId?: string; onRefresh?: () => Promise<void> };
function money(minor: string) { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(BigInt(minor || '0')) / 100); }
function formatTime(value?: string) { if (!value) return '待服务端计算'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date); }
function goalStatus(status: GoalView['status']) { return status === 'SUCCEEDED' ? '目标已完成' : status === 'NEEDS_REPLAN' ? '需要重新规划' : '进行中'; }
function nodeStatus(status: GoalNode['status']) { const labels: Record<GoalNode['status'], string> = { BLOCKED: '等待前置步骤', READY: '可准备下一步', AWAITING_AUTH: '等待此动作单独授权', IN_PROGRESS: '处理中', UNKNOWN: '结果待核对', SUCCEEDED: '已完成', FAILED: '失败 · 需重新规划' }; return labels[status]; }

export function GoalsPage({ accountId, accounts, payees, suggestedGoal, requestedGoalId, onRefresh }: Props) {
  const [goals, setGoals] = useState<GoalView[]>([]); const [selectedId, setSelectedId] = useState<string | undefined>(requestedGoalId);
  const [draft, setDraft] = useState<GoalDraft>({ title: '', accountId: accountId ?? '', payeeId: payees[0]?.id ?? '', amountMinor: '', targetDate: '' });
  const [amountInput, setAmountInput] = useState('');
  const [fundPositionId, setFundPositionId] = useState(''); const [fundAmount, setFundAmount] = useState(''); const [positions, setPositions] = useState<{ id: string; productName: string; availableMinor: string }[]>([]);
  const [loading, setLoading] = useState(false); const [busy, setBusy] = useState<string>(); const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>(); const [editing, setEditing] = useState(false);
  const mounted = useMounted(); const operationLock = useRef(false); const readVersion = useRef(0);
  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;
  const [verifiedGoalId, setVerifiedGoalId] = useState<string>();
  const [readRequiredGoal, setReadRequiredGoal] = useState<string>(); const readRequiredGoalRef = useRef<string | undefined>(undefined);
  const createRecovery = useCommandRecovery<CreateGoalInput, GoalView>({
    family: 'goal', slot: 'goal-create', send: api.createGoal, lookup: api.goalCommand,
    onResolved: (goal) => {
      if (!mounted.current) return;
      upsert(goal); setNotice('已读取原生活目标。目标本身不授权付款，请逐项核对与授权。');
      void onRefresh?.().catch(() => undefined);
    },
  });
  const replanRecovery = useCommandRecovery<ReplanGoalInput & { goalId: string }, GoalView>({
    family: 'goal', slot: 'goal-replan', send: ({ goalId, ...input }) => api.replanGoal(goalId, input), lookup: api.goalCommand,
    onResolved: (goal) => {
      if (!mounted.current) return;
      upsert(goal); setEditing(false); setNotice('已读取原目标重规划结果。请核对计划版本和变化；各动作仍需单独授权。');
      void onRefresh?.().catch(() => undefined);
    },
  });
  const commandBusy = createRecovery.busy || replanRecovery.busy;
  const refresh = useCallback(async () => {
    const current = ++readVersion.current; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) return;
    setLoading(true);
    try {
      const [result, portfolio] = await Promise.all([api.goals(), api.investments()]);
      if (!isCurrent() || current !== readVersion.current) return;
      let nextGoals = result.goals;
      if (suggestedGoal && !nextGoals.some((goal) => goal.id === suggestedGoal.id)) nextGoals = [suggestedGoal, ...nextGoals];
      setGoals((current) => mergeGoalSnapshots(current, nextGoals)); setPositions(portfolio.positions.map(({ id, productName, availableMinor }) => ({ id, productName, availableMinor })));
      // The merge retains current goals, including a command result absent from an older list read.
      // Selection therefore falls back only before any goal has been selected.
      setSelectedId((current) => current ?? nextGoals[0]?.id);
    } catch (reason) { if (isCurrent() && current === readVersion.current) setError(reason instanceof Error ? reason.message : '生活目标暂不可用。'); }
    finally { if (isCurrent() && current === readVersion.current) setLoading(false); }
  }, [suggestedGoal]);
  useEffect(() => { void refresh(); }, [refresh]);
  // An explicit inbox navigation selects its original goal once. Subsequent
  // lists, polling and manual selection must not continually reselect it.
  useEffect(() => { if (requestedGoalId) { setSelectedId(requestedGoalId); setEditing(false); } }, [requestedGoalId]);
  useEffect(() => { setDraft((current) => ({ ...current, accountId: current.accountId || accountId || '', payeeId: current.payeeId || payees[0]?.id || '' })); }, [accountId, payees]);
  useEffect(() => { if (suggestedGoal) setGoals((current) => mergeGoalSnapshots(current, [suggestedGoal])); }, [suggestedGoal]);
  const selected = useMemo(() => goals.find((goal) => goal.id === selectedId), [goals, selectedId]);
  useEffect(() => {
    if (!selected || selected.status === 'SUCCEEDED') return;
    setVerifiedGoalId(undefined); readRequiredGoalRef.current = selected.id; setReadRequiredGoal(selected.id);
    void readOriginalGoal(selected.id);
    // Selecting a goal first performs a read, including after navigating back.
  }, [selected?.id]);
  const selectedHasActiveWork = selected?.nodes.some((node) => ['IN_PROGRESS', 'UNKNOWN'].includes(node.status) || ['AUTHORIZED', 'SUBMITTING', 'UNKNOWN', 'SETTLING'].includes(node.investmentAction?.status ?? '') || ['AUTHORIZED', 'SUBMITTING', 'UNKNOWN'].includes(node.transferAction?.status ?? '')) ?? false;
  useEffect(() => {
    if (!selectedId || !selectedHasActiveWork) return;
    let active = true; let inFlight = false; const isCurrent = operationGuard(mounted);
    const timer = window.setInterval(() => {
      if (inFlight || !isCurrent()) return;
      inFlight = true;
      void api.goal(selectedId).then((goal) => { if (active && isCurrent()) setGoals((current) => mergeGoalSnapshots(current, [goal])); }).catch(() => undefined).finally(() => { inFlight = false; });
    }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedId, selectedHasActiveWork]);

  function draftValue<K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) { setDraft((current) => ({ ...current, [key]: value })); }
  function buildDraft(): GoalDraft | undefined {
    const amountMinor = toMinor(amountInput);
    if (!draft.title.trim() || !draft.accountId || !draft.payeeId || !amountMinor || !draft.targetDate) { setError('请填写目标名称、账户、收款人、正数金额和目标日期。'); return undefined; }
    const fundingMinor = fundPositionId ? toMinor(fundAmount) : undefined;
    if (fundPositionId && !fundingMinor) { setError('已选择合成持仓，请填写有效的赎回金额。'); return undefined; }
    return { title: draft.title.trim(), accountId: draft.accountId, payeeId: draft.payeeId, amountMinor, targetDate: draft.targetDate, ...(fundPositionId && fundingMinor ? { funding: { positionId: fundPositionId, redemptionAmountMinor: fundingMinor } } : {}) };
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (operationLock.current || commandBusy) return;
    const input = buildDraft(); if (!input) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    setBusy('create'); setError(undefined); setNotice(undefined);
    try {
      const goal = await createRecovery.execute(input);
      if (!isCurrent() || !goal) return;
      setDraft({ title: '', accountId: accountId ?? '', payeeId: payees[0]?.id ?? '', amountMinor: '', targetDate: '' }); setAmountInput(''); setFundPositionId(''); setFundAmount('');
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : '生活目标保存失败。'); }
    finally { operationLock.current = false; if (isCurrent()) setBusy(undefined); }
  }
  async function advance(goal: GoalView) {
    if (operationLock.current || commandBusy || verifiedGoalId !== goal.id || readRequiredGoalRef.current === goal.id) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) { operationLock.current = false; return; }
    setBusy(goal.id); setError(undefined); setNotice(undefined);
    try {
      const next = await api.advanceGoal(goal.id);
      if (!isCurrent()) return;
      upsert(next); setNotice('服务端已检查依赖，并准备了可进入下一步的动作；请逐项核对与授权。');
      void onRefresh?.().catch(() => undefined);
    } catch (reason) {
      if (!isCurrent()) return;
      setVerifiedGoalId(undefined); readRequiredGoalRef.current = goal.id; setReadRequiredGoal(goal.id);
      setError(reason instanceof Error ? reason.message : '目标进度检查失败。');
      try {
        const next = await api.goal(goal.id);
        if (!isCurrent()) return;
        setVerifiedGoalId(goal.id); readRequiredGoalRef.current = undefined; setReadRequiredGoal(undefined);
        upsert(next); setNotice('已只读核对原目标与依赖状态；未自动再次推进、生成动作或授权付款。请核对下方最新计划。');
        void onRefresh?.().catch(() => undefined);
      } catch (recoveryError) { if (isCurrent()) setNotice(`原目标暂未核对成功：${recoveryError instanceof Error ? recoveryError.message : '读取失败'}。请先刷新目标状态。`); }
    } finally { operationLock.current = false; if (isCurrent()) setBusy(undefined); }
  }
  async function readOriginalGoal(targetId?: string) {
    const id = targetId ?? readRequiredGoalRef.current;
    if (!id || operationLock.current) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) { operationLock.current = false; return; }
    setBusy(id);
    try {
      const goal = await api.goal(id);
      if (!isCurrent()) return;
      setGoals((current) => mergeGoalSnapshots(current, [goal]));
      if (selectedIdRef.current !== id) return;
      setVerifiedGoalId(id); readRequiredGoalRef.current = undefined; setReadRequiredGoal(undefined);
      setNotice('已只读核对原目标与依赖状态。请复核计划后选择后续操作。');
    } catch (reason) { if (isCurrent()) setNotice(`原目标仍未核对成功：${reason instanceof Error ? reason.message : '读取失败'}。已暂停推进和重规划，请再次查询。`); }
    finally { operationLock.current = false; if (isCurrent()) setBusy(undefined); }
  }
  function upsert(goal: GoalView) { setGoals((current) => mergeGoalSnapshots(current, [goal])); setSelectedId(goal.id); }
  async function replan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || operationLock.current || commandBusy || verifiedGoalId !== selected.id || readRequiredGoalRef.current === selected.id) return;
    const input = buildDraft(); if (!input) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    setBusy(selected.id); setError(undefined); setNotice(undefined);
    try { await replanRecovery.execute({ goalId: selected.id, ...input, expectedPlanVersion: selected.planVersion }); }
    catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : '目标重规划失败。'); }
    finally { operationLock.current = false; if (isCurrent()) setBusy(undefined); }
  }
  function beginEdit(goal: GoalView) { setDraft({ title: goal.title, accountId: goal.accountId, payeeId: goal.payeeId, amountMinor: goal.amountMinor, targetDate: goal.targetDate, ...(goal.funding ? { funding: goal.funding } : {}) }); setAmountInput(minorToInput(goal.amountMinor)); setFundPositionId(goal.funding?.positionId ?? ''); setFundAmount(goal.funding ? minorToInput(goal.funding.redemptionAmountMinor) : ''); setEditing(true); }
  function updateNodeAction(goalId: string, nodeId: string, action: InvestmentAction | ActionView) {
    setGoals((current) => current.map((goal) => goal.id !== goalId ? goal : mergeGoalSnapshot(goal, { ...goal, nodes: goal.nodes.map((node) => node.id !== nodeId ? node : { ...node, status: goalNodeStatusForAction(action), ...(actionHasTransferShape(action) ? { transferAction: action } : { investmentAction: action }) }) })));
    void onRefresh?.().catch(() => undefined);
  }

  return <section className="business-page goals-page">
    <header className="business-page-heading"><div><span className="section-kicker">生活目标 · 本人逐项授权</span><h1>生活目标计划</h1><p>按目标日期安排资金准备、合成赎回等待和转账动作。目标本身不授权任何付款，预期到账也不等于当前现金。</p></div><button className="button button-outline" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新目标</button></header>
    <CommandRecoveryNotice recovery={createRecovery} /><CommandRecoveryNotice recovery={replanRecovery} />
    {notice && <div className="notice notice-info" role="status">{notice}</div>}{error && <div className="business-error" role="alert">{error}<button className="button button-outline" onClick={() => void refresh()}>重试读取</button></div>}
    {readRequiredGoal && <div className="notice notice-info" role="status">原目标结果仍待核对，已暂停此目标的推进和重规划。<button type="button" className="button button-outline" disabled={Boolean(busy)} onClick={() => void readOriginalGoal()}>只读查询原目标</button></div>}
    <div className="goals-layout"><section className="goals-primary">
      {selected ? <GoalDetail goal={selected} busy={Boolean(busy) || commandBusy} readBlocked={verifiedGoalId !== selected.id || readRequiredGoal === selected.id} editing={editing} draft={draft} amountInput={amountInput} accounts={accounts} payees={payees} positions={positions} fundPositionId={fundPositionId} fundAmount={fundAmount} onAdvance={() => void advance(selected)} onReplan={replan} onEdit={() => beginEdit(selected)} onCancelEdit={() => setEditing(false)} onDraft={draftValue} onAmountInput={setAmountInput} onFunding={(id) => { setFundPositionId(id); if (!id) setFundAmount(''); }} onFundAmount={setFundAmount} onNodeAction={(nodeId, action) => updateNodeAction(selected.id, nodeId, action)} onRefresh={onRefresh} /> : <section className="panel goals-empty"><span className="goals-empty-icon"><Goal size={21} /></span><h2>建立第一个生活目标</h2><p>保存后，系统会显示资金准备步骤和日期依赖。</p>{loading && <span className="business-loading"><span className="loader loader-small" />正在读取目标…</span>}</section>}
    </section><aside className="goals-sidebar"><section className="panel goal-create-panel"><div className="business-panel-heading"><div><span className="section-kicker">新目标</span><h2>设定生活目标</h2></div><CalendarDays size={17} /></div><form className="management-form" onSubmit={(event) => void create(event)}><GoalFields draft={draft} amountInput={amountInput} accounts={accounts} payees={payees} positions={positions} fundPositionId={fundPositionId} fundAmount={fundAmount} onDraft={draftValue} onAmountInput={setAmountInput} onFunding={(id) => { setFundPositionId(id); if (!id) setFundAmount(''); }} onFundAmount={setFundAmount} /><button className="button button-primary" type="submit" disabled={Boolean(busy) || commandBusy || !accounts.length || !payees.length}>{busy === 'create' ? '保存中…' : '保存并查看计划'}</button><p className="management-form-note">保存目标不代表授权赎回或转账。每个步骤对应的动作都需要单独确认。</p></form></section><section className="panel goals-list-panel"><div className="business-panel-heading"><div><span className="section-kicker">目标列表</span><h2>进行中与历史</h2></div><span className="count-badge">{goals.length}</span></div>{goals.length ? <div className="goal-selector-list">{goals.map((goal) => <button className={`goal-selector ${selectedId === goal.id ? 'goal-selector-active' : ''}`} key={goal.id} disabled={Boolean(busy) || commandBusy} onClick={() => { setSelectedId(goal.id); setEditing(false); }}><span><strong>{goal.title}</strong><small>{goal.targetDate} · {goalStatus(goal.status)}</small></span><b>{money(goal.amountMinor)}</b></button>)}</div> : <p className="management-empty">暂时没有生活目标。</p>}</section></aside></div>
  </section>;
}

function GoalDetail({ goal, busy, readBlocked, editing, draft, amountInput, accounts, payees, positions, fundPositionId, fundAmount, onAdvance, onReplan, onEdit, onCancelEdit, onDraft, onAmountInput, onFunding, onFundAmount, onNodeAction, onRefresh }: {
  goal: GoalView; busy: boolean; readBlocked: boolean; editing: boolean; draft: GoalDraft; amountInput: string; accounts: AccountView[]; payees: PayeeView[]; positions: { id: string; productName: string; availableMinor: string }[]; fundPositionId: string; fundAmount: string; onAdvance: () => void; onReplan: (event: React.FormEvent<HTMLFormElement>) => void; onEdit: () => void; onCancelEdit: () => void; onDraft: <K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) => void; onAmountInput: (value: string) => void; onFunding: (id: string) => void; onFundAmount: (value: string) => void; onNodeAction: (nodeId: string, action: InvestmentAction | ActionView) => void; onRefresh?: () => Promise<void>;
}) {
  const readiness = goal.status === 'ACTIVE' && !goal.reasons.length;
  return <section className="panel goal-detail-panel"><div className="goal-title-row"><div><span className="section-kicker">目标版本 {goal.planVersion}</span><h2>{goal.title}</h2></div><span className={`goal-status goal-status-${goal.status.toLowerCase()}`}>{goalStatus(goal.status)}</span></div><div className="goal-metrics"><article><span>目标金额</span><b>{money(goal.amountMinor)}</b></article><article><span>目标日期</span><b>{goal.targetDate}</b></article><article><span>预期模拟赎回到账</span><b>{formatTime(goal.expectedSettlementAt)}</b></article></div>
    {goal.fundsPreview && <div className={`goal-funds-preview ${goal.fundsPreview.allowed ? '' : 'goal-funds-denied'}`}><div><strong>资金约束预演</strong><span>版本 {goal.fundsPreview.policyVersion} · 最低保留与 30 日义务已纳入</span></div><div><span>支出前可用 {money(goal.fundsPreview.availableBeforeMinor)}</span><span>保护金额 {money(goal.fundsPreview.protectedMinor)}</span><span>模拟缺口 {money(goal.fundsPreview.shortfallMinor)}</span></div>{!goal.fundsPreview.allowed && <p>{goal.fundsPreview.reasons.join('；') || '当前方案不满足资金保护约束。'}</p>}</div>}
    {goal.reasons.length > 0 && <div className="goal-reasons"><strong>需要关注</strong><ul>{goal.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul></div>}
    {goal.revisionDiff.length > 0 && <div className="goal-revision-diff"><strong>本次重规划变化</strong><ul>{goal.revisionDiff.map((diff, index) => <li key={`${index}-${diff}`}>{diff}</li>)}</ul></div>}
    <div className="goal-dag-heading"><div><span className="section-kicker">资金准备进度</span><h3>目标准备路线</h3></div><span>各步骤分别确认</span></div>
    {goal.nodes.length ? <ol className="goal-dag">{goal.nodes.map((node, index) => <li key={node.id} className={`goal-node goal-node-${node.status.toLowerCase()}`}><div className="goal-node-track"><span className="goal-node-dot">{node.status === 'SUCCEEDED' ? <CheckCircle2 size={15} /> : index + 1}</span><i /></div><div className="goal-node-body"><div className="goal-node-heading"><div><span className="section-kicker">{node.kind === 'REDEEM' ? '合成赎回' : node.kind === 'WAIT_SETTLEMENT' ? '模拟到账等待' : '生活目标转账'}</span><strong>{nodeStatus(node.status)}</strong></div></div>{node.reason && <p>{node.reason}</p>}{node.dependsOn.length > 0 && <small>前置步骤：{node.dependsOn.length} 项</small>}{node.evidenceRefs.length > 0 && <small>参考依据：{node.evidenceRefs.length} 项</small>}{node.investmentAction && <InvestmentActionCard key={node.investmentAction.id} action={node.investmentAction} onRefresh={onRefresh} onUpdated={(action) => onNodeAction(node.id, action)} />}{node.transferAction && <GoalTransferActionCard key={node.transferAction.id} action={node.transferAction} onRefresh={onRefresh} onUpdated={(action) => onNodeAction(node.id, action)} />}</div></li>)}</ol> : <div className="goal-no-nodes"><Route size={17} /><span>服务端尚未返回准备步骤，请检查进度。</span></div>}
    <div className="goal-actions"><button className="button button-primary" onClick={onAdvance} disabled={busy || readBlocked || goal.status === 'SUCCEEDED'}><RefreshCw size={15} className={busy ? 'spin' : ''} />检查进度并准备下一步</button><button className="button button-outline" onClick={onEdit} disabled={busy || readBlocked || goal.status === 'SUCCEEDED'}>修改目标并重新规划</button></div>
    {editing && <form className="goal-replan-form" onSubmit={onReplan}><div className="business-panel-heading"><div><span className="section-kicker">修改目标</span><h3>复核计划变化</h3></div></div><GoalFields draft={draft} amountInput={amountInput} accounts={accounts} payees={payees} positions={positions} fundPositionId={fundPositionId} fundAmount={fundAmount} onDraft={onDraft} onAmountInput={onAmountInput} onFunding={onFunding} onFundAmount={onFundAmount} /><div className="goal-actions"><button className="button button-primary" type="submit" disabled={busy || readBlocked}>{busy ? '重规划中…' : '确认修改并重规划'}</button><button className="button button-outline" type="button" onClick={onCancelEdit}>取消编辑</button></div><p className="management-form-note">保存后已完成步骤及回执会保留，并显示计划变化。已有动作不会自动重新授权。</p></form>}
  </section>;
}

function GoalFields({ draft, amountInput, accounts, payees, positions, fundPositionId, fundAmount, onDraft, onAmountInput, onFunding, onFundAmount }: { draft: GoalDraft; amountInput: string; accounts: AccountView[]; payees: PayeeView[]; positions: { id: string; productName: string; availableMinor: string }[]; fundPositionId: string; fundAmount: string; onDraft: <K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) => void; onAmountInput: (value: string) => void; onFunding: (id: string) => void; onFundAmount: (value: string) => void }) {
  return <><label><span>目标名称</span><input value={draft.title} onChange={(event) => onDraft('title', event.target.value)} maxLength={80} placeholder="例如：下月学费" required /></label><label><span>目标金额（元）</span><input inputMode="decimal" value={amountInput} onChange={(event) => onAmountInput(event.target.value)} placeholder="例如 5000.00" required /></label><label><span>目标完成日期</span><input type="date" value={draft.targetDate} onChange={(event) => onDraft('targetDate', event.target.value)} required /></label><label><span>账户</span><select value={draft.accountId} onChange={(event) => onDraft('accountId', event.target.value)} required><option value="">选择账户</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.maskedNumber}</option>)}</select></label><label><span>收款人</span><select aria-label="收款人" value={draft.payeeId} onChange={(event) => onDraft('payeeId', event.target.value)} required><option value="">选择合成收款人</option>{payees.map((payee) => <option key={payee.id} value={payee.id}>{payee.name} · {payee.bank} {payee.maskedNumber}</option>)}</select></label><label><span>计划资金来源（可选）</span><select aria-label="计划资金来源（可选）" value={fundPositionId} onChange={(event) => onFunding(event.target.value)}><option value="">暂不绑定合成持仓</option>{positions.map((position) => <option key={position.id} value={position.id}>{position.productName} · 可赎回 {money(position.availableMinor)}</option>)}</select></label>{fundPositionId && <label><span>预计赎回金额（元）</span><input inputMode="decimal" value={fundAmount} onChange={(event) => onFundAmount(event.target.value)} placeholder="例如 2000.00" required /></label>}</>;
}

function GoalTransferActionCard({ action, onUpdated, onRefresh }: { action: ActionView; onUpdated: (action: ActionView) => void; onRefresh?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [registering, setRegistering] = useState(false); const [error, setError] = useState<string>(); const [notice, setNotice] = useState<string>();
  const pending = ['AWAITING_CONFIRMATION', 'AWAITING_VERIFICATION'].includes(action.status);
  const needsInitialRead = ['AWAITING_CONFIRMATION', 'AWAITING_VERIFICATION', 'UNKNOWN'].includes(action.status);
  const [readRequired, setReadRequired] = useState(needsInitialRead); const readRequiredRef = useRef(needsInitialRead);
  const mounted = useMounted(); const operationLock = useRef(false);
  async function run(kind: 'authorize' | 'register' | 'cancel' | 'reconcile') {
    if (operationLock.current || readRequiredRef.current) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) { operationLock.current = false; return; }
    setBusy(true); setRegistering(kind === 'register'); setError(undefined); setNotice(undefined);
    try {
      let next: ActionView | undefined;
      if (kind === 'authorize') {
        if (action.tier === 'RED' || action.status === 'AWAITING_VERIFICATION') {
          const options = await api.authenticationOptions(action.id);
          if (!isCurrent()) return;
          const response = await startAuthentication({ optionsJSON: unwrapPublicKeyOptions(options) as unknown as PublicKeyCredentialRequestOptionsJSON });
          if (!isCurrent()) return;
          next = await api.authenticationVerify(action.id, response);
        } else next = await api.confirm(action.id, action.actionHash);
      } else if (kind === 'register') {
        const options = await api.registerOptions();
        if (!isCurrent()) return;
        const response = await startRegistration({ optionsJSON: unwrapPublicKeyOptions(options) as unknown as PublicKeyCredentialCreationOptionsJSON });
        if (!isCurrent()) return;
        await api.registerVerify(response);
      } else next = await (kind === 'cancel' ? api.cancel(action.id) : api.reconcile(action.id));
      if (!isCurrent()) return;
      if (next) onUpdated(next);
      setNotice(kind === 'register' ? 'Passkey 已注册，请再对本笔转账完成强验证。' : '已提交本次操作。请查看本单的最新状态和回执。');
      void onRefresh?.().catch(() => undefined);
    } catch (reason) {
      if (!isCurrent()) return;
      readRequiredRef.current = true; setReadRequired(true);
      setError(reason instanceof Error ? reason.message : '该转账动作请求失败。');
      try {
        const next = await api.action(action.id);
        if (!isCurrent()) return;
        readRequiredRef.current = false; setReadRequired(false);
        onUpdated(next);
        setNotice(`已只读核对原转账单。请以本单的最新状态和回执为准。${kind === 'register' ? '此查单不证明 Passkey 已登记；请刷新账户核对。' : '未自动重新授权、取消或提交查单。'}`);
        void onRefresh?.().catch(() => undefined);
      } catch (recoveryError) { if (isCurrent()) setNotice(`原转账单暂未核对成功：${recoveryError instanceof Error ? recoveryError.message : '读取失败'}。请先刷新原单，避免重复操作。`); }
    } finally { operationLock.current = false; if (isCurrent()) { setBusy(false); setRegistering(false); } }
  }
  async function readOriginal() {
    if (operationLock.current) return;
    operationLock.current = true; const isCurrent = operationGuard(mounted);
    if (!isCurrent()) { operationLock.current = false; return; }
    setBusy(true);
    try {
      const next = await api.action(action.id);
      if (!isCurrent()) return;
      readRequiredRef.current = false; setReadRequired(false); onUpdated(next);
      setNotice('已只读核对原转账单。请核对本单的最新状态和回执后选择后续操作。');
    } catch (reason) { if (isCurrent()) setNotice(`原转账单仍未核对成功：${reason instanceof Error ? reason.message : '读取失败'}。已暂停后续操作，请再次查询原单。`); }
    finally { operationLock.current = false; if (isCurrent()) setBusy(false); }
  }
  useEffect(() => {
    if (needsInitialRead) void readOriginal();
    // A replacement action has a new key; only GET is permitted on mount.
  }, [action.id]);
  const authorize = () => run('authorize'); const cancel = () => run('cancel');
  const reconcile = () => run('reconcile'); const register = () => run('register');
  return <article className="goal-transfer-action"><div><strong>给 {action.payeeName} · {money(action.amountMinor)}</strong><span>转账 {action.tier === 'RED' ? '红档 Passkey' : '黄档本人确认'} · {transferStatusLabel(action.status)}</span></div>{action.failureReason && <p className="management-error">{action.failureReason}</p>}{error && <p className="management-error">{error}</p>}{notice && <p className="management-success" role="status">{notice}</p>}<div className="goal-actions">{readRequired && <button type="button" className="button button-outline" disabled={busy} onClick={() => void readOriginal()}>只读查询原转账单</button>}{pending && <><button className={`button ${action.tier === 'RED' || action.status === 'AWAITING_VERIFICATION' ? 'button-dark' : 'button-primary'}`} onClick={() => void authorize()} disabled={busy || readRequired}>{action.tier === 'RED' || action.status === 'AWAITING_VERIFICATION' ? <><Fingerprint size={14} />Passkey 强验证</> : '确认此转账'}</button>{(action.tier === 'RED' || action.status === 'AWAITING_VERIFICATION') && <button className="button button-outline" onClick={() => void register()} disabled={busy || registering || readRequired}>{registering ? '注册中…' : '还没有 Passkey？先注册'}</button>}<button className="button button-outline" onClick={() => void cancel()} disabled={busy || readRequired}>取消候选</button></>}{action.status === 'UNKNOWN' && <button className="button button-warning" onClick={() => void reconcile()} disabled={busy || readRequired}><RefreshCw size={14} />手动查单</button>}</div>{action.receipt && <small>成功回执 · {action.receipt.providerTransactionId} · {formatTime(action.receipt.settledAt)}</small>}</article>;
}

function toMinor(value: string): string | undefined { const text = value.trim().replace(/,/g, ''); if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return undefined; const [yuan, fraction = ''] = text.split('.'); const minor = BigInt(yuan || '0') * 100n + BigInt(fraction.padEnd(2, '0') || '0'); return minor > 0n ? minor.toString() : undefined; }
function minorToInput(minor: string) { return `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, '0')}`; }
function actionHasTransferShape(action: InvestmentAction | ActionView): action is ActionView { return 'payeeName' in action; }

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}
function operationGuard(mounted: { current: boolean }) {
  const signal = getApiSessionSignal();
  return () => mounted.current && !signal?.aborted && signal === getApiSessionSignal();
}
