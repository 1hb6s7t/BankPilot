import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, BadgeCheck, Check, CheckCircle2, CreditCard, Fingerprint, Landmark, LockKeyhole, Plus, RefreshCw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { startAuthentication, startRegistration, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { ActionStatus, PayeeView as CorePayeeView } from '../../../packages/contracts/src';
import type { CardView, ManagementAction, ManagementDashboard, ManagementInput, ManagementSpec, SubscriptionSnapshot, SubscriptionView } from '../../../packages/contracts/src/management';
import { api, ApiError, getApiSessionSignal, unwrapPublicKeyOptions } from './api';
import { useCommandRecovery, CommandRecoveryNotice } from './commandRecovery';

type ManagementPageName = '联系人' | '卡片' | '订阅';
type Refresh = () => Promise<void>;

function money(minor: string): string {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(Number(BigInt(minor || '0')) / 100);
}

function shortTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function statusLabel(status: ActionStatus): string {
  const labels: Record<ActionStatus, string> = {
    AWAITING_CONFIRMATION: '待本人确认', AWAITING_VERIFICATION: '待 Passkey', AUTHORIZED: '已授权 · 执行中',
    SUBMITTING: '正在执行', UNKNOWN: '结果待查', SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消', EXPIRED: '已过期',
  };
  return labels[status];
}

function statusTone(status: ActionStatus): string {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED' || status === 'EXPIRED') return 'danger';
  if (status === 'UNKNOWN' || status === 'SUBMITTING' || status === 'AUTHORIZED') return 'warning';
  return status === 'CANCELLED' ? 'muted' : 'pending';
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const session = useRef(getApiSessionSignal());
  return useMemo(() => ({ get current() { return mounted.current && !session.current?.aborted && session.current === getApiSessionSignal(); } }), []);
}

/** Display-only projection: disclosure expiry is independent of business updatedAt. */
export function projectManagementAction(action: ManagementAction, contexts: (ManagementAction | undefined)[] = [], now = Date.now()): ManagementAction {
  const sensitive = action.spec.kind === 'SUBSCRIPTION_CANCEL' || action.spec.kind === 'SUBSCRIPTION_BLOCK';
  if (!sensitive) return action;
  const observations = [action, ...contexts.filter((item): item is ManagementAction => item?.id === action.id)];
  const hidden = observations.some((item) => item.detailsRedacted || !item.detailsAccessExpiresAt || !Number.isFinite(Date.parse(item.detailsAccessExpiresAt)) || Date.parse(item.detailsAccessExpiresAt) <= now);
  if (!hidden) return action;
  const receipt = action.receipt ? { ...action.receipt, summary: '本地合成操作已完成；订阅明细需在有效查询授权内查看。' } : undefined;
  if (receipt) { delete receipt.subscription; delete receipt.subscriptions; }
  return {
    ...action, title: action.spec.kind === 'SUBSCRIPTION_CANCEL' ? '取消商户订阅' : '限制银行扣款',
    details: ['订阅明细需在有效的查询授权内查看；此为本地合成商户操作。'],
    ...(receipt ? { receipt } : {}),
    ...(action.failureReason ? { failureReason: '管理动作未完成；订阅明细需在有效查询授权内查看。' } : {}),
    detailsRedacted: true,
  };
}

export function mergeManagementActions(...groups: (ManagementAction[] | undefined)[]): ManagementAction[] {
  const byId = new Map<string, ManagementAction>();
  for (const group of groups) for (const action of group ?? []) {
    const previous = byId.get(action.id);
    const latest = !previous || action.updatedAt >= previous.updatedAt ? action : previous;
    byId.set(action.id, projectManagementAction(latest, previous ? [previous, action] : [action]));
  }
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function ManagementActionsPanel({ actions, onRefresh }: { actions: ManagementAction[]; onRefresh: Refresh }) {
  if (!actions.length) return null;
  return <section className="management-plan-actions"><div className="management-plan-heading"><span className="section-kicker">计划管理动作</span><span>{actions.length} 项</span></div>{actions.map((action) => <ManagementActionCard action={action} onRefresh={onRefresh} key={action.id} />)}</section>;
}

export function ManagementPages({ page, payees, dashboard, onRefresh }: { page: ManagementPageName; payees: CorePayeeView[]; dashboard?: ManagementDashboard; onRefresh: Refresh }) {
  if (page === '联系人') return <ContactsPage payees={payees} actions={dashboard?.actions ?? []} onRefresh={onRefresh} />;
  if (page === '卡片') return <CardsPage cards={dashboard?.cards ?? []} actions={dashboard?.actions ?? []} onRefresh={onRefresh} />;
  return <SubscriptionsPage dashboard={dashboard} actions={dashboard?.actions ?? []} onRefresh={onRefresh} />;
}

function PageHeader({ title, eyebrow, description }: { title: string; eyebrow: string; description: string }) {
  return <header className="business-page-heading"><div><span className="section-kicker">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div><span className="synthetic-tag"><i />合成数据</span></header>;
}

function ContactsPage({ payees, actions, onRefresh }: { payees: CorePayeeView[]; actions: ManagementAction[]; onRefresh: Refresh }) {
  const [payeeId, setPayeeId] = useState(payees[0]?.id ?? '');
  const [alias, setAlias] = useState('');
  const mounted = useMounted();
  const [localAction, setLocalAction] = useState<ManagementAction>();
  const [error, setError] = useState<string>();
  const selected = payees.find((payee) => payee.id === payeeId);
  const aliasActions = useMemo(() => mergeManagementActions(localAction ? [localAction] : [], actions.filter((action) => action.spec.kind === 'CONTACT_ALIAS_SAVE')), [actions, localAction]);

  const recovery = useCommandRecovery<ManagementInput, ManagementAction>({
    family: 'management', slot: 'management-contacts', send: api.prepareManagement, lookup: api.managementCommand,
    onResolved: (action) => {
      if (!mounted.current) return;
      setLocalAction(action);
      void onRefresh().catch((reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : '联系人列表刷新失败。'); });
    },
  });

  async function prepareAlias(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mounted.current || !selected || !alias.trim()) return;
    setError(undefined);
    try {
      await recovery.execute({ spec: { kind: 'CONTACT_ALIAS_SAVE', payeeId: selected.id, alias: alias.trim() } });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '别名候选生成失败。'); }
  }

  return <section className="management-page business-page">
    <PageHeader title="联系人" eyebrow="收款人别名" description="为合成收款人添加你常用的称呼。只有确认管理动作后，别名才会保存并供转账规划识别。" />
    <div className="management-two-column"><section className="panel management-editor"><div className="business-panel-heading"><div><span className="section-kicker">别名候选</span><h2>选择收款人并添加称呼</h2></div><span className="management-icon"><Landmark size={16} /></span></div>
      {!payees.length ? <p className="management-empty">暂无可用的合成收款人。</p> : <form onSubmit={(event) => void prepareAlias(event)} className="management-form"><label><span>收款人</span><select aria-label="收款人" value={payeeId} onChange={(event) => setPayeeId(event.target.value)}>{payees.map((payee) => <option key={payee.id} value={payee.id}>{payee.name} · {payee.bank} {payee.maskedNumber}</option>)}</select></label><label><span>新增称呼</span><input value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={40} placeholder="例如：晓晓、房东" /></label>{selected && <div className="management-selected-payee"><div className="payee-avatar">{selected.name.slice(0, 1)}</div><div><strong>{selected.name}</strong><span>{selected.bank} · {selected.maskedNumber}</span><div className="management-alias-list">{selected.aliases.length ? selected.aliases.map((item) => <em key={item}>{item}</em>) : <small>还没有保存的别名</small>}</div></div></div>}{error && <p className="management-error" role="alert">{error}</p>}<CommandRecoveryNotice recovery={recovery} /><button className="button button-primary" type="submit" disabled={recovery.busy || Boolean(recovery.pending) || !selected || !alias.trim()}>{recovery.busy ? '正在生成候选…' : <><Plus size={15} />生成别名保存候选</>}</button><p className="management-form-note">候选动作会显示具体收款人和别名，确认后才写入。保存后会刷新联系人列表。</p></form>}
    </section><section className="panel management-context"><div className="business-panel-heading"><div><span className="section-kicker">使用说明</span><h2>别名如何生效</h2></div><BadgeCheck size={17} /></div><ol className="management-steps"><li><b>1</b><span>选中列表中的合成收款人。</span></li><li><b>2</b><span>输入你希望使用的别名并生成候选。</span></li><li><b>3</b><span>核对并确认管理动作，服务端保存后会刷新联系人。</span></li><li><b>4</b><span>之后自然语言转账规划可按这个别名解析。</span></li></ol></section></div>
    {aliasActions.length > 0 && <section className="management-action-list"><div className="business-panel-heading"><div><span className="section-kicker">别名变更</span><h2>候选与操作记录</h2></div></div>{aliasActions.map((action) => <ManagementActionCard key={action.id} action={action} onRefresh={onRefresh} />)}</section>}
  </section>;
}

function CardsPage({ cards, actions, onRefresh }: { cards: CardView[]; actions: ManagementAction[]; onRefresh: Refresh }) {
  const [localActions, setLocalActions] = useState<ManagementAction[]>([]);
  const mounted = useMounted();
  const [error, setError] = useState<string>();
  const cardActions = useMemo(() => mergeManagementActions(localActions, actions.filter((action) => action.spec.kind === 'CARD_REPORT_LOST' || action.spec.kind === 'CARD_UNREPORT_LOST')), [actions, localActions]);

  const recovery = useCommandRecovery<ManagementInput, ManagementAction>({
    family: 'management', slot: 'management-cards', send: api.prepareManagement, lookup: api.managementCommand,
    onResolved: (action) => {
      if (!mounted.current) return;
      setLocalActions((current) => mergeManagementActions(current, [action]));
      void onRefresh().catch((reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : '卡片列表刷新失败。'); });
    },
  });

  async function prepare(card: CardView) {
    if (!mounted.current) return;
    const kind = card.status === 'ACTIVE' ? 'CARD_REPORT_LOST' : 'CARD_UNREPORT_LOST';
    setError(undefined);
    try {
      await recovery.execute({ spec: { kind, cardId: card.id, expectedVersion: card.version } });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '卡片管理候选生成失败。'); }
  }

  return <section className="management-page business-page">
    <PageHeader title="卡片" eyebrow="卡片状态管理" description="挂失或解挂会先生成细节卡，再由本人授权。操作只影响合成卡片扣款能力，不会自动取消订阅。" />
    {error && <p className="management-error" role="alert">{error}</p>}
    <CommandRecoveryNotice recovery={recovery} />
    <div className="management-card-grid">{cards.map((card) => <article className="panel synthetic-card" key={card.id}><div className="synthetic-card-top"><div className="management-icon"><CreditCard size={17} /></div><span className={`card-state ${card.status === 'ACTIVE' ? 'card-state-active' : 'card-state-lost'}`}>{card.status === 'ACTIVE' ? '正常' : '已挂失'}</span></div><strong>{card.name}</strong><span className="synthetic-card-number">{card.maskedNumber}</span><span className="synthetic-card-updated">更新于 {shortTime(card.updatedAt)} · 版本 {card.version}</span><button className={`button ${card.status === 'ACTIVE' ? 'button-warning' : 'button-outline'}`} onClick={() => void prepare(card)} disabled={recovery.busy || Boolean(recovery.pending) || card.status === 'ACTIVE' && Boolean(cardActions.some((action) => action.spec.kind === 'CARD_REPORT_LOST' && action.spec.cardId === card.id && ['AWAITING_CONFIRMATION', 'AWAITING_VERIFICATION', 'AUTHORIZED', 'SUBMITTING'].includes(action.status)))}>{recovery.busy ? '正在准备…' : card.status === 'ACTIVE' ? '准备挂失' : '准备解挂'}</button></article>)}{cards.length === 0 && <div className="panel management-empty">暂无可用的合成卡片。</div>}</div>
    <div className="management-caveat"><ShieldCheck size={16} /><span>挂失只影响卡片扣款能力，不会取消商户订阅。解挂或挂失都需要先确认动作详情；红档操作只接受 Passkey 强验证。</span></div>
    {cardActions.length > 0 && <section className="management-action-list"><div className="business-panel-heading"><div><span className="section-kicker">卡片状态操作</span><h2>待确认与近期记录</h2></div></div>{cardActions.map((action) => <ManagementActionCard key={action.id} action={action} onRefresh={onRefresh} />)}</section>}
  </section>;
}

function SubscriptionsPage({ dashboard, actions, onRefresh }: { dashboard?: ManagementDashboard; actions: ManagementAction[]; onRefresh: Refresh }) {
  const [queryRequested, setQueryRequested] = useState(false);
  const [queryActionIdExpected, setQueryActionIdExpected] = useState<string>();
  const [snapshot, setSnapshot] = useState<SubscriptionSnapshot>();
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string>();
  const [snapshotExpired, setSnapshotExpired] = useState(false);
  const [localActions, setLocalActions] = useState<ManagementAction[]>([]);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [error, setError] = useState<string>();
  const mounted = useMounted();
  const snapshotRequest = useRef(0);
  const allActions = useMemo(() => mergeManagementActions(localActions, actions.filter((action) => action.spec.kind === 'SUBSCRIPTION_QUERY' || action.spec.kind === 'SUBSCRIPTION_CANCEL' || action.spec.kind === 'SUBSCRIPTION_BLOCK')), [actions, localActions]);
  const authorizedQuery = dashboard?.actions.find((action) => action.id === dashboard.subscriptionQueryActionId && action.spec.kind === 'SUBSCRIPTION_QUERY' && action.status === 'SUCCEEDED');
  const successfulQuery = allActions.find((action) => action.id === queryActionIdExpected && action.spec.kind === 'SUBSCRIPTION_QUERY' && action.status === 'SUCCEEDED');
  const grantId = successfulQuery ? (dashboard?.subscriptionQueryActionId === successfulQuery.id ? dashboard.subscriptionQueryActionId : successfulQuery.receipt?.subscriptions?.queryActionId ?? successfulQuery.id) : undefined;

  const recovery = useCommandRecovery<ManagementInput, ManagementAction>({
    family: 'management', slot: 'management-subscriptions', send: api.prepareManagement, lookup: api.managementCommand,
    onResolved: (action) => {
      if (!mounted.current) return;
      setLocalActions((current) => mergeManagementActions(current, [action]));
      if (action.spec.kind === 'SUBSCRIPTION_QUERY') {
        setQueryActionIdExpected(action.id);
        setQueryRequested(true);
      }
      void onRefresh().catch((reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : '订阅授权记录刷新失败。'); });
    },
  });

  useEffect(() => {
    if (!mounted.current || !queryRequested || !successfulQuery || !grantId) {
      setSnapshot(undefined);
      setSnapshotLoading(false);
      return;
    }
    let active = true;
    const request = ++snapshotRequest.current;
    setSnapshot(undefined); setSnapshotLoading(true); setSnapshotError(undefined);
    api.subscriptions(grantId)
      .then((value) => {
        if (!mounted.current || !active || request !== snapshotRequest.current) return;
        if (value.queryActionId !== grantId) {
          setSnapshot(undefined);
          setSnapshotError('订阅快照与本次查询授权不匹配，请重新读取。');
          return;
        }
        const expiresAt = new Date(value.accessExpiresAt).getTime();
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
          setSnapshot(undefined);
          setSnapshotExpired(true);
          setSnapshotError('订阅查询授权已过期，请重新授权查询。');
          return;
        }
        setSnapshotExpired(false);
        setSnapshot(value);
      })
      .catch((reason: unknown) => {
        if (!mounted.current || !active || request !== snapshotRequest.current) return;
        setSnapshot(undefined);
        if (reason instanceof ApiError && ['QUERY_ACCESS_EXPIRED', 'QUERY_AUTHORIZATION_REQUIRED'].includes(reason.code ?? '')) setSnapshotExpired(true);
        setSnapshotError(reason instanceof Error ? reason.message : '订阅授权读取失败。');
      })
      .finally(() => { if (mounted.current && active && request === snapshotRequest.current) setSnapshotLoading(false); });
    return () => { active = false; };
  }, [grantId, queryRequested, refreshIndex, successfulQuery?.id, successfulQuery?.status]);

  useEffect(() => {
    if (!snapshot) return;
    const remaining = new Date(snapshot.accessExpiresAt).getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      setSnapshot(undefined);
      setSnapshotExpired(true);
      setSnapshotError('订阅查询授权已过期，请重新授权查询。');
      return;
    }
    const timer = window.setTimeout(() => {
      if (!mounted.current) return;
      setSnapshot(undefined);
      setSnapshotExpired(true);
      setSnapshotError('订阅查询授权已过期，请重新授权查询。');
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [snapshot]);

  const refreshAfterMutation = useCallback(async () => { await onRefresh(); if (mounted.current) setRefreshIndex((value) => value + 1); }, [onRefresh, mounted]);

  function viewAuthorized() {
    if (!authorizedQuery || snapshotExpired) return;
    setSnapshot(undefined); setSnapshotError(undefined); setSnapshotExpired(false);
    setQueryActionIdExpected(authorizedQuery.id); setQueryRequested(true);
    setRefreshIndex((value) => value + 1);
  }

  async function prepare(spec: ManagementSpec, _key: string) {
    if (!mounted.current || recovery.busy || recovery.pending) return;
    if (spec.kind === 'SUBSCRIPTION_QUERY') {
      ++snapshotRequest.current;
      setSnapshot(undefined);
      setSnapshotError(undefined);
      setSnapshotExpired(false);
      setQueryActionIdExpected(undefined);
      setQueryRequested(true);
    }
    setError(undefined);
    try {
      await recovery.execute({ spec });
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : '订阅管理候选生成失败。'); }
  }

  return <section className="management-page business-page">
    <PageHeader title="订阅" eyebrow="订阅查询与扣款管理" description="订阅列表初始隐藏。先明确请求查询并完成授权；商户取消与银行拦截是不同操作。" />
    {error && <p className="management-error" role="alert">{error}</p>}
    <CommandRecoveryNotice recovery={recovery} />
    {!snapshot && <section className="panel subscription-query-gate"><div className="subscription-lock"><LockKeyhole size={19} /></div><div><strong>{snapshotExpired ? '查询授权已过期' : queryRequested ? '订阅内容暂不可见' : '订阅内容暂未读取'}</strong><p>{snapshotExpired ? '为保护订阅明细，旧快照已清除。重新授权后可读取一份新的短时快照。' : authorizedQuery ? '已有查询授权。点击查看后，服务端会核对原授权并读取当前订阅；不会新增查询授权。' : queryRequested ? '只有完成新的查询动作授权后，服务端才会开放短时只读订阅快照。' : '订阅列表初始隐藏。准备并确认查询动作后，服务端才会开放短时只读订阅快照。'}</p></div>{authorizedQuery && !snapshotExpired && <button className="button button-primary" onClick={viewAuthorized} disabled={snapshotLoading || (recovery.busy || Boolean(recovery.pending))}>{snapshotLoading ? '正在读取…' : '查看已授权订阅'}</button>}<button className={`button ${authorizedQuery && !snapshotExpired ? 'button-outline' : 'button-primary'}`} onClick={() => void prepare({ kind: 'SUBSCRIPTION_QUERY' }, 'query')} disabled={(recovery.busy || Boolean(recovery.pending)) || snapshotLoading}>{(recovery.busy || Boolean(recovery.pending)) ? '正在准备…' : <><RefreshCw size={14} />{queryRequested || authorizedQuery ? '重新授权查询' : '准备查询订阅'}</>}</button></section>}
    {queryRequested && snapshotLoading && <div className="business-loading"><span className="loader loader-small" />等待订阅读取授权并加载快照…</div>}
    {queryRequested && snapshotError && <div className="business-error" role="alert">{snapshotExpired ? '订阅查询授权已过期：' : '订阅快照读取失败：'}{snapshotError}</div>}
    {queryRequested && !successfulQuery && !snapshotLoading && !snapshotError && !snapshot && <div className="panel subscription-query-gate"><div className="subscription-lock"><LockKeyhole size={18} /></div><div><strong>等待查询动作完成授权</strong><p>管理动作完成后，订阅数据会通过短时授权查询加载。若已取消候选，可重新授权查询。</p></div></div>}
    {snapshot && <><div className="subscription-snapshot-note"><ShieldCheck size={15} /><span>快照读取于 {shortTime(snapshot.queriedAt)}，授权有效至 {shortTime(snapshot.accessExpiresAt)} · 来源为合成商户。</span><button className="button button-outline" onClick={() => void prepare({ kind: 'SUBSCRIPTION_QUERY' }, 'query')} disabled={(recovery.busy || Boolean(recovery.pending))}>重新授权查询</button></div><div className="subscription-list">{snapshot.items.map((subscription) => <SubscriptionCard key={subscription.id} subscription={subscription} card={dashboard?.cards.find((item) => item.id === subscription.cardId)} queryActionId={snapshot.queryActionId} busy={recovery.busy || Boolean(recovery.pending)} onPrepare={prepare} />)}{snapshot.items.length === 0 && <div className="panel management-empty">授权快照中没有合成订阅。</div>}</div></>}
    {allActions.length > 0 && <section className="management-action-list"><div className="business-panel-heading"><div><span className="section-kicker">订阅授权记录</span><h2>查询与管理动作</h2></div></div>{allActions.map((action) => <ManagementActionCard key={action.id} action={action} onRefresh={refreshAfterMutation} />)}</section>}
  </section>;
}

function SubscriptionCard({ subscription, card, queryActionId, busy, onPrepare }: { subscription: SubscriptionView; card?: CardView; queryActionId: string; busy: boolean; onPrepare: (spec: ManagementSpec, key: string) => Promise<void> }) {
  const active = subscription.merchantStatus === 'ACTIVE';
  return <article className="panel subscription-card"><div className="subscription-card-main"><div className="management-icon"><RefreshCw size={16} /></div><div><strong>{subscription.merchant}</strong><span>{money(subscription.amountMinor)} · 下次扣款 {subscription.nextChargeDate}</span></div><span className={`collection-state ${subscription.collectionStatus === 'ENABLED' ? 'collection-enabled' : 'collection-blocked'}`}>{subscription.collectionStatus === 'ENABLED' ? '扣款开放' : '扣款受阻'}</span></div><div className="subscription-status-grid"><span>商户状态 <b>{subscription.merchantStatus === 'ACTIVE' ? '有效' : '已取消'}</b></span><span>银行状态 <b>{subscription.bankStatus === 'ALLOWED' ? '允许扣款' : '已拦截'}</b></span><span>卡片 <b>{card ? `${card.name} · ${card.maskedNumber}` : '卡片状态不可用'}</b></span><span>数据版本 <b>{subscription.version}</b></span></div><div className="subscription-operations">{active && subscription.cancellationSupported ? <button className="button button-warning" onClick={() => void onPrepare({ kind: 'SUBSCRIPTION_CANCEL', subscriptionId: subscription.id, expectedVersion: subscription.version, queryActionId }, subscription.id)} disabled={busy}>准备商户取消</button> : active ? <div className="merchant-cancel-note">此商户不支持应用内取消，请联系商户办理；银行拦截不会把商户状态改成已取消。</div> : <span className="subscription-terminal">商户已取消</span>}{subscription.bankStatus === 'ALLOWED' ? <button className="button button-outline" onClick={() => void onPrepare({ kind: 'SUBSCRIPTION_BLOCK', subscriptionId: subscription.id, expectedVersion: subscription.version, queryActionId }, subscription.id)} disabled={busy}>准备银行拦截扣款</button> : <span className="subscription-terminal">银行已拦截</span>}</div><p className="subscription-operations-note">商户取消会请求改变商户订阅；银行拦截只阻止未来从此账户扣款。未来可能节省金额不会加到当前余额。</p></article>;
}

export function ManagementActionCard({ action: incomingAction, onRefresh }: { action: ManagementAction; onRefresh: Refresh }) {
  const mounted = useMounted();
  const operationLock = useRef(false);
  const [recoveredAction, setRecoveredAction] = useState<ManagementAction>();
  const [, rerenderPrivacy] = useState(0);
  const latestAction = recoveredAction?.id === incomingAction.id && recoveredAction.updatedAt >= incomingAction.updatedAt ? recoveredAction : incomingAction;
  const action = projectManagementAction(latestAction, [incomingAction, recoveredAction]);
  const privateDetailsHidden = action.detailsRedacted === true;
  const incomingDeadline = incomingAction.detailsAccessExpiresAt;
  const recoveredDeadline = recoveredAction?.detailsAccessExpiresAt;
  useEffect(() => {
    if (privateDetailsHidden) return;
    const deadlines = [incomingDeadline, recoveredDeadline].filter((value): value is string => Boolean(value)).map(Date.parse).filter(Number.isFinite);
    if (!deadlines.length) return;
    const remaining = Math.min(...deadlines) - Date.now();
    const timer = window.setTimeout(() => { if (mounted.current) rerenderPrivacy((value) => value + 1); }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [incomingDeadline, recoveredDeadline, privateDetailsHidden, mounted]);
  const [busy, setBusy] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [recoveryRequired, setRecoveryRequired] = useState(() => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(incomingAction.status));
  const [checking, setChecking] = useState(() => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(incomingAction.status));
  const pending = action.status === 'AWAITING_CONFIRMATION' || action.status === 'AWAITING_VERIFICATION';
  const final = action.status === 'SUCCEEDED' || action.status === 'FAILED' || action.status === 'CANCELLED' || action.status === 'EXPIRED';

  // A remounted plan may still contain a pre-request snapshot. Read the original
  // action before allowing any mutation, including after navigation or reload.
  useEffect(() => {
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(incomingAction.status)) return;
    let active = true;
    operationLock.current = true;
    setRecoveryRequired(true); setChecking(true);
    void api.managementAction(incomingAction.id).then((fresh) => {
      if (!active || !mounted.current) return;
      setRecoveredAction(fresh);
      setRecoveryRequired(false);
    }).catch((reason: unknown) => {
      if (!active || !mounted.current) return;
      setError(reason instanceof Error ? reason.message : '原动作状态读取失败。');
      setNotice('原动作状态尚未核实，请先只读查询成功后再操作。不会自动提交授权或启动 Passkey。');
    }).finally(() => {
      if (!active || !mounted.current) return;
      operationLock.current = false; setChecking(false);
    });
    return () => { active = false; operationLock.current = false; };
    // The card is keyed by action ID; ordinary dashboard updates must not refetch.
  }, [incomingAction.id, mounted]);

  async function recoverOriginalAction(reason: unknown, fallback: string) {
    if (!mounted.current) return;
    const originalError = reason instanceof Error ? reason.message : fallback;
    setError(originalError);
    setRecoveryRequired(true);
    let recovered: ManagementAction;
    try {
      recovered = await api.managementAction(action.id);
    } catch {
      if (mounted.current) setNotice('原请求结果尚未核实；只读查询失败，请刷新原动作状态。不会自动重发授权或启动 Passkey。');
      return;
    }
    if (!mounted.current) return;
    setRecoveryRequired(false);
    setRecoveredAction((current) => mergeManagementActions(current ? [current] : [], [recovered]).find((item) => item.id === action.id));
    setNotice('已只读核对原动作。原请求发生错误，查单不代表该请求成功；请以本动作的最新状态和回执为准。未自动重发授权或启动 Passkey。');
    try { await onRefresh(); }
    catch { if (mounted.current) setNotice('已只读核对原动作；列表刷新失败，请再次刷新并核对本动作的最新状态和回执。未自动重发授权或启动 Passkey。'); }
  }

  async function checkOriginalAction() {
    if (!mounted.current || operationLock.current) return;
    operationLock.current = true;
    setChecking(true);
    try { await recoverOriginalAction(error ? new Error(error) : undefined, '原请求结果需要核实。'); }
    finally { operationLock.current = false; if (mounted.current) setChecking(false); }
  }

  async function confirm() {
    if (!mounted.current || operationLock.current || recoveryRequired || privateDetailsHidden) return;
    operationLock.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (action.tier === 'RED') {
        const response = await api.managementAuthenticationOptions(action.id);
        if (!mounted.current) return;
        const assertion = await startAuthentication({ optionsJSON: unwrapPublicKeyOptions(response) as unknown as PublicKeyCredentialRequestOptionsJSON });
        if (!mounted.current) return;
        await api.managementAuthenticationVerify(action.id, assertion);
        if (!mounted.current) return;
        setNotice('Passkey 强验证已提交，管理动作状态将从服务端刷新。');
      } else {
        const result = await api.confirmManagement(action.id, action.actionHash);
        if (!mounted.current) return;
        setRecoveredAction(result);
        setNotice(result.status === 'AWAITING_VERIFICATION' ? '本次确认返回红档验证要求；请按本动作的最新状态核对后续操作。' : '本人确认已提交，管理动作状态将从服务端刷新。');
      }
      await onRefresh();
    } catch (reason) { await recoverOriginalAction(reason, '管理动作授权未完成。'); }
    finally { operationLock.current = false; if (mounted.current) setBusy(false); }
  }

  async function cancel() {
    if (!mounted.current || operationLock.current || recoveryRequired) return;
    operationLock.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      await api.cancelManagement(action.id);
      if (!mounted.current) return;
      await onRefresh();
      if (mounted.current) setNotice('取消请求已提交，状态已刷新。');
    } catch (reason) { await recoverOriginalAction(reason, '取消动作失败。'); }
    finally { operationLock.current = false; if (mounted.current) setBusy(false); }
  }

  async function registerPasskey() {
    if (!mounted.current || operationLock.current || recoveryRequired || privateDetailsHidden) return;
    operationLock.current = true;
    setRegisterBusy(true); setError(undefined); setNotice(undefined);
    try {
      const options = await api.registerOptions();
      if (!mounted.current) return;
      const response = await startRegistration({ optionsJSON: unwrapPublicKeyOptions(options) as unknown as PublicKeyCredentialCreationOptionsJSON });
      if (!mounted.current) return;
      await api.registerVerify(response);
      if (!mounted.current) return;
      await onRefresh();
      if (mounted.current) setNotice('Passkey 已注册，请再执行此管理动作的强验证。');
    } catch (reason) { await recoverOriginalAction(reason, 'Passkey 注册未完成。'); }
    finally { operationLock.current = false; if (mounted.current) setRegisterBusy(false); }
  }

  return <article data-action-id={action.id} className={`management-action-card ${final ? 'management-action-final' : ''}`}>
    <div className="management-action-heading"><div><span className="management-action-kind">{action.tier === 'RED' ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}{action.tier === 'RED' ? '红档 · Passkey 强验证' : '黄档 · 本人确认'}</span><h3>{action.title}</h3></div><span className={`management-action-status status-${statusTone(action.status)}`}>{statusLabel(action.status)}</span></div>
    <ul className="management-action-details">{action.details.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul>
    {action.failureReason && <p className="management-error">{action.failureReason}</p>}
    {action.receipt && <div className="management-receipt"><CheckCircle2 size={14} /><div><strong>{action.receipt.summary}</strong><span>{shortTime(action.receipt.completedAt)} · 余额变化 {money(action.receipt.balanceDeltaMinor)}</span>{action.receipt.payee && <small>已保存别名：{action.receipt.payee.aliases.join('、')}</small>}{action.receipt.card && <small>卡片状态：{action.receipt.card.status === 'ACTIVE' ? '正常' : '已挂失'} · {action.receipt.card.maskedNumber}</small>}{action.receipt.subscription && <small>商户：{action.receipt.subscription.merchantStatus === 'ACTIVE' ? '有效' : '已取消'} · 银行扣款：{action.receipt.subscription.bankStatus === 'ALLOWED' ? '允许' : '已拦截'}</small>}</div></div>}
    {error && <p className="management-error" role="alert">{error}</p>}{notice && <p className="management-success" role="status">{notice}</p>}
    {privateDetailsHidden && pending && <p className="management-error">原查询授权已失效或订阅明细不可见。请重新授权查询并核对详情后创建新的管理候选。</p>}
    {recoveryRequired && <button className="button button-outline" disabled={busy || registerBusy || checking} onClick={() => void checkOriginalAction()}>{checking ? '正在查询原动作…' : '只读查询原动作状态'}</button>}
    {pending && <div className="management-action-controls"><button className={`button ${action.tier === 'RED' ? 'button-dark' : 'button-primary'}`} onClick={() => void confirm()} disabled={busy || registerBusy || checking || recoveryRequired || privateDetailsHidden}>{busy ? '正在授权…' : action.tier === 'RED' ? <><Fingerprint size={15} />Passkey 强验证</> : <><Check size={15} />确认此管理动作</>}</button>{action.tier === 'RED' && <button className="button button-outline" onClick={() => void registerPasskey()} disabled={busy || registerBusy || checking || recoveryRequired || privateDetailsHidden}>{registerBusy ? '正在注册…' : '还没有 Passkey？先注册'}</button>}<button className="management-cancel-link" onClick={() => void cancel()} disabled={busy || registerBusy || checking || recoveryRequired}>取消候选动作</button></div>}
    {action.status === 'AUTHORIZED' || action.status === 'SUBMITTING' ? <p className="management-running"><span className="loader loader-small" />等待服务端管理执行。</p> : null}
    {action.status === 'UNKNOWN' && <p className="management-running">结果待查，请刷新管理状态后再继续。</p>}
    {final && !action.receipt && <p className="management-final-state">{statusLabel(action.status)} · {shortTime(action.updatedAt)}</p>}
    <span className="management-action-expiry">动作摘要 {action.actionHash.slice(0, 16)}… · 有效期 {shortTime(action.expiresAt)}</span>
  </article>;
}
