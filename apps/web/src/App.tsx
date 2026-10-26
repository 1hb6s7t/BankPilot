import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowRight,
  BadgeCheck,
  Banknote,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CircleUserRound,
  Clock3,
  CreditCard,
  FileClock,
  FileText,
  Fingerprint,
  Goal,
  Landmark,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { ActionView, AgentEvent, BillReport, BillTransaction, FaultMode, FundObligation, FundsOverview, FundsPreview, FundsPolicy, PayeeView, PlanningFailure, PlanResult, RiskTier } from '../../../packages/contracts/src';
import type { ManagementAction, ManagementDashboard } from '../../../packages/contracts/src/management';
import { api, setApiSessionSignal, unwrapPublicKeyOptions, type DashboardData } from './api';
import { GenerationGate, LogoutIntent, planningFailureView, type GenerationTicket } from './chatState';
import { DashboardReadCoordinator, dashboardActionViews, dashboardRefreshKeys, dashboardRequiresPolling } from './dashboardState';
import type { ConversationEnvelope } from '../../../packages/contracts/src/conversations';
import { ManagementActionsPanel, ManagementPages, mergeManagementActions } from './ManagementPages';
import { InvestmentPages } from './InvestmentPages';
import { transferStatusLabel as statusLabel } from './actionStatus';
import { GoalsPage } from './GoalsPage';
import { PreparationRequestsPage } from './PreparationRequestsPage';
import { setCommandRecoveryOwner } from './commandRecovery';
import type { GoalView, InvestmentAction } from '../../../packages/contracts/src';
import type { PreparationResult } from '../../../packages/contracts/src/preparations';

const ConversationsPanel = lazy(() => import('./ConversationsPanel').then(module => ({ default: module.ConversationsPanel })));

type AuthState = 'checking' | 'signed-out' | 'signed-in' | 'signing-out' | 'sign-out-failed';
type Section = '转账工作台' | '联系人' | '账单' | '理财' | '卡片' | '订阅' | '资金计划' | '生活目标' | '请求恢复';

const DEMO_EMAIL = 'bankpilot@example.test';
const DEMO_PASSWORD = 'BankPilot-demo-2026!';

const navigation: { name: Section; icon: typeof ArrowLeftRight; available: boolean }[] = [
  { name: '转账工作台', icon: ArrowLeftRight, available: true },
  { name: '联系人', icon: CircleUserRound, available: true },
  { name: '账单', icon: FileText, available: true },
  { name: '理财', icon: Banknote, available: true },
  { name: '卡片', icon: CreditCard, available: true },
  { name: '订阅', icon: RefreshCw, available: true },
  { name: '资金计划', icon: Goal, available: true },
  { name: '生活目标', icon: Goal, available: true },
  { name: '请求恢复', icon: FileClock, available: true },
];

function formatMoney(minor: string | bigint): string {
  const value = typeof minor === 'bigint' ? minor : BigInt(minor || '0');
  const yuan = Number(value) / 100;
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(yuan);
}

function formatTime(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}


function statusTone(status: ActionView['status']): string {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'UNKNOWN' || status === 'SUBMITTING') return 'warning';
  if (status === 'FAILED' || status === 'EXPIRED') return 'danger';
  if (status === 'CANCELLED') return 'muted';
  return 'pending';
}

function tierLabel(tier: RiskTier): string {
  return tier === 'RED' ? '高风险 · Passkey' : '普通风险 · 本人确认';
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    transfer: '转账 Agent',
    bills: '账单 Agent',
    investment: '理财 Agent',
    card: '卡片 Agent',
    subscription: '订阅 Agent',
    goal: '资金计划 Agent',
    reviewer: '复核 Agent',
    'semantic-intent': '意图理解 Agent',
    semantic_intent: '意图理解 Agent',
    supervisor: '总控 Agent',
    planner: '规划 Agent',
  };
  return labels[role] ?? role;
}

function eventState(event: AgentEvent): string {
  return event.status === 'completed' ? '已完成' : '处理中';
}


export default function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const sessionGate = useRef(new GenerationGate());
  const logoutIntent = useRef(new LogoutIntent());
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [ownerId, setOwnerId] = useState<string>();
  const sessionTicket = useMemo(() => sessionGate.current.capture(), [sessionEpoch]);

  const [dashboard, setDashboard] = useState<DashboardData>();
  const dashboardSnapshot = useRef<DashboardData | undefined>(undefined);
  const dashboardReads = useRef(new DashboardReadCoordinator<DashboardData>());
  const managementReads = useRef(new DashboardReadCoordinator<ManagementDashboard>());
  const observedTerminalActions = useRef(new Set<string>());
  const [dashboardStale, setDashboardStale] = useState(false);
  const [managementDashboard, setManagementDashboard] = useState<ManagementDashboard>();
  const [latestManagementActions, setLatestManagementActions] = useState<ManagementAction[]>([]);
  const [latestInvestmentActions, setLatestInvestmentActions] = useState<InvestmentAction[]>([]);
  const [latestGoal, setLatestGoal] = useState<GoalView>();
  const [requestedGoalId, setRequestedGoalId] = useState<string>();
  const latestPlanTaskId = useRef<string | undefined>(undefined);
  const [activeSection, setActiveSection] = useState<Section>('转账工作台');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [selectedActionId, setSelectedActionId] = useState<string>();
  const [latestPlan, setLatestPlan] = useState<PlanResult>();
  const [planningFailure, setPlanningFailure] = useState<PlanningFailure>();
  const [recentPlanActions, setRecentPlanActions] = useState<ActionView[]>([]);
  const [planning, setPlanning] = useState(false);
  const [serverMode, setServerMode] = useState<PlanResult['mode']>();
  const [faultMode, setFaultMode] = useState<FaultMode>('NORMAL');
  const [faultApplied, setFaultApplied] = useState(false);
  const [actionFunds, setActionFunds] = useState<{ actionId: string; overview: FundsOverview }>();
  const [actionFundsLoading, setActionFundsLoading] = useState(false);
  const [actionFundsError, setActionFundsError] = useState<{ actionId: string; message: string }>();
  const [busyActionId, setBusyActionId] = useState<string>();
  const [loginBusy, setLoginBusy] = useState(false);
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success' | 'info'; text: string }>();
  const [refreshing, setRefreshing] = useState(false);

  const clearIdentity = useCallback(() => {
    setCommandRecoveryOwner(undefined); managementReads.current.invalidate();
    dashboardReads.current.invalidate(); dashboardSnapshot.current = undefined; observedTerminalActions.current.clear(); setDashboardStale(false);
    setDashboard(undefined); setManagementDashboard(undefined); setRecentPlanActions([]);
    setLatestPlan(undefined); setPlanningFailure(undefined); latestPlanTaskId.current = undefined;
    setLatestManagementActions([]); setLatestInvestmentActions([]); setLatestGoal(undefined); setRequestedGoalId(undefined);
    setSelectedActionId(undefined); setActionFunds(undefined); setActionFundsError(undefined);
    setActionFundsLoading(false); setBusyActionId(undefined); setPlanning(false); setRefreshing(false);
    setFaultMode('NORMAL'); setFaultApplied(false); setDrawerOpen(false); setMobileNavOpen(false);
    setActiveSection('转账工作台'); setOwnerId(undefined); setNotice(undefined);
  }, []);
  const renewSession = useCallback(() => {
    setCommandRecoveryOwner(undefined); managementReads.current.invalidate();
    dashboardReads.current.invalidate();
    const ticket = sessionGate.current.renew();
    setApiSessionSignal(ticket.signal); setSessionEpoch(ticket.generation);
    return ticket;
  }, []);
  const finishLogout = useCallback(async (ticket: ReturnType<GenerationGate['capture']>) => {
    clearIdentity(); setAuthState('signing-out'); setLoginBusy(true); setPassword('');
    logoutIntent.current.begin();
    try {
      await api.signOut();
      if (!sessionGate.current.isCurrent(ticket)) return;
      logoutIntent.current.complete();
      setAuthState('signed-out'); setNotice({ kind: 'info', text: '已退出本地演示账号。' });
    } catch {
      if (!sessionGate.current.isCurrent(ticket)) return;
      setAuthState('sign-out-failed');
      setNotice({ kind: 'error', text: '服务端退出尚未确认。账户显示已清空，请重试退出；确认退出前暂不开放登录。' });
    } finally { if (sessionGate.current.isCurrent(ticket)) setLoginBusy(false); }
  }, [clearIdentity]);

  const loadDashboard = useCallback((ticket: GenerationTicket, requireFresh = false) => dashboardReads.current.read(api.dashboard, value => {
    if (!sessionGate.current.isCurrent(ticket)) return;
    dashboardSnapshot.current = value;
    setDashboard(value); setDashboardStale(false);
    if (value.plannerMode) setServerMode(value.plannerMode);
  }, requireFresh), []);

  const refreshDashboard = useCallback(async (quiet = false, requireFresh = false) => {
    const ticket = sessionTicket;
    if (!sessionGate.current.isCurrent(ticket)) return;
    if (requireFresh) setDashboardStale(true);
    if (!quiet) setRefreshing(true);
    try {
      await loadDashboard(ticket, requireFresh);
      if (!sessionGate.current.isCurrent(ticket)) return;
      // The selected conversation command owns the plan pane; a user's global latestPlan does not.
    } catch (error) {
      if (!sessionGate.current.isCurrent(ticket)) return;
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 401) {
        renewSession(); clearIdentity(); setAuthState('signed-out');
      } else if (!quiet) setNotice({ kind: 'error', text: error instanceof Error ? error.message : '读取工作台失败。' });
    } finally {
      if (sessionGate.current.isCurrent(ticket) && !quiet) setRefreshing(false);
    }
  }, [sessionTicket, renewSession, clearIdentity, loadDashboard]);

  useEffect(() => {
    const ticket = renewSession();
    if (logoutIntent.current.isPending()) {
      void finishLogout(ticket);
      return () => { sessionGate.current.abort(); };
    }
    void (async () => {
      try {
        const [session] = await Promise.all([api.session(), loadDashboard(ticket)]);
        if (!sessionGate.current.isCurrent(ticket)) return;
        setCommandRecoveryOwner(session.userId); setOwnerId(session.userId);
        setAuthState('signed-in');
      } catch (error) {
        if (!sessionGate.current.isCurrent(ticket)) return;
        clearIdentity(); setAuthState('signed-out');
        if (!(error instanceof Error && 'status' in error && (error as { status?: number }).status === 401)) {
          setNotice({ kind: 'info', text: '请登录本地合成沙箱账号，连接后将从 API 恢复账户与聊天。' });
        }
      }
    })();
    return () => { sessionGate.current.abort(); };
  }, [renewSession, clearIdentity, finishLogout, loadDashboard]);

  const refreshManagement = useCallback(async () => {
    const ticket = sessionTicket;
    if (!sessionGate.current.isCurrent(ticket)) return;
    try {
      await managementReads.current.read(api.management, value => {
        if (sessionGate.current.isCurrent(ticket)) setManagementDashboard(value);
      }, true);
    } catch (error) {
      if (sessionGate.current.isCurrent(ticket)) setNotice({ kind: 'error', text: error instanceof Error ? error.message : '管理工作台状态读取失败。' });
    }
  }, [sessionTicket]);

  const refreshAll = useCallback(async () => {
    if (!sessionGate.current.isCurrent(sessionTicket)) return;
    await Promise.all([refreshDashboard(true, true), refreshManagement()]);
  }, [refreshDashboard, refreshManagement, sessionTicket]);
  const openPreparationResult = useCallback(async (recovered: PreparationResult) => {
    if (!sessionGate.current.isCurrent(sessionTicket)) return;
    if (recovered.family === 'investment') {
      setLatestInvestmentActions(current => [recovered.result, ...current.filter(action => action.id !== recovered.result.id)]);
      setActiveSection('理财');
    } else if (recovered.family === 'goal') {
      setLatestGoal(recovered.result); setRequestedGoalId(recovered.result.id); setActiveSection('生活目标');
    } else {
      // Keep the literal recovered action available even if a dashboard read fails.
      setLatestManagementActions(current => mergeManagementActions(current, [recovered.result]));
      try { await refreshAll(); } catch { /* The original action remains available for inspection. */ }
      if (!sessionGate.current.isCurrent(sessionTicket)) return;
      const kind = recovered.result.spec.kind;
      setActiveSection(kind === 'CONTACT_ALIAS_SAVE' ? '联系人' : kind.startsWith('CARD_') ? '卡片' : '订阅');
    }
  }, [refreshAll, sessionTicket]);
  useEffect(() => {
    if (authState === 'signed-in') void refreshManagement();
    else setManagementDashboard(undefined);
  }, [authState, refreshManagement]);

  const actions = useMemo(() => dashboardActionViews(dashboard, recentPlanActions), [dashboard, recentPlanActions]);
  const managementPlanActions = useMemo(() => {
    if (!latestPlan) return [];
    const taskId = latestPlan.taskId;
    return mergeManagementActions(
      latestManagementActions.filter((action) => action.taskId === taskId),
      managementDashboard?.actions.filter((action) => action.taskId === taskId),
    );
  }, [latestManagementActions, latestPlan, managementDashboard?.actions]);
  const selectedAction = actions.find((action) => action.id === selectedActionId) ?? (latestPlan ? actions.find(action => action.taskId === latestPlan.taskId) : undefined);
  const selectedActionNeedsPreview = selectedAction ? ['AWAITING_CONFIRMATION', 'AWAITING_VERIFICATION'].includes(selectedAction.status) : false;
  const currentActionFunds = selectedActionNeedsPreview && actionFunds?.actionId === selectedAction?.id ? actionFunds?.overview : undefined;
  const currentActionFundsError = selectedActionNeedsPreview && actionFundsError?.actionId === selectedAction?.id ? actionFundsError?.message : undefined;
  const selectedPlanFundsSnapshot = selectedAction && latestPlan?.taskId === selectedAction.taskId
    && latestPlan.fundsPreview?.accountId === selectedAction.accountId
    && latestPlan.fundsPreview.amountMinor === selectedAction.amountMinor
    ? latestPlan.fundsPreview
    : undefined;
  const needsPolling = dashboardRequiresPolling(dashboard, dashboardStale);

  useEffect(() => {
    if (!selectedAction || authState !== 'signed-in' || !['AWAITING_CONFIRMATION', 'AWAITING_VERIFICATION'].includes(selectedAction.status)) {
      setActionFunds(undefined);
      setActionFundsError(undefined);
      setActionFundsLoading(false);
      return;
    }
    let active = true;
    const ticket = sessionTicket;
    setActionFunds(undefined);
    setActionFundsLoading(true);
    setActionFundsError(undefined);
    api.funds(selectedAction.accountId, selectedAction.amountMinor)
      .then((value) => {
        if (!active || !sessionGate.current.isCurrent(ticket)) return;
        if (value.preview.accountId !== selectedAction.accountId || value.preview.amountMinor !== selectedAction.amountMinor) {
          setActionFundsError({ actionId: selectedAction.id, message: '服务端返回的预演账户或金额与当前动作不一致，已阻止授权。' });
          return;
        }
        setActionFunds({ actionId: selectedAction.id, overview: value });
      })
      .catch((error: unknown) => { if (active && sessionGate.current.isCurrent(ticket)) setActionFundsError({ actionId: selectedAction.id, message: error instanceof Error ? error.message : '资金预演暂不可用。' }); })
      .finally(() => { if (active && sessionGate.current.isCurrent(ticket)) setActionFundsLoading(false); });
    return () => { active = false; };
  }, [authState, sessionTicket, selectedAction?.id, selectedAction?.accountId, selectedAction?.amountMinor, selectedAction?.status]);

  useEffect(() => {
    if (!needsPolling || authState !== 'signed-in') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshDashboard(true);
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [authState, needsPolling, refreshDashboard]);

  useEffect(() => {
    if (!drawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [drawerOpen]);

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authState !== 'signed-out' || loginBusy || logoutIntent.current.isPending()) return;
    const ticket = renewSession(); clearIdentity(); setLoginBusy(true);
    try {
      await api.signIn(email, password);
      if (!sessionGate.current.isCurrent(ticket)) return;
      const [session] = await Promise.all([api.session(), loadDashboard(ticket)]);
      if (!sessionGate.current.isCurrent(ticket)) return;
      setCommandRecoveryOwner(session.userId); setOwnerId(session.userId);
      setAuthState('signed-in'); setNotice({ kind: 'success', text: '已连接本地合成银行账户。' });
    } catch (error) {
      if (sessionGate.current.isCurrent(ticket)) setNotice({ kind: 'error', text: error instanceof Error ? error.message : '登录失败。' });
    } finally {
      if (sessionGate.current.isCurrent(ticket)) setLoginBusy(false);
    }
  }
  async function handleLogout() {
    if (authState === 'signing-out') return;
    const ticket = renewSession();
    await finishLogout(ticket);
  }

  function viewConversationPlan(result?: ConversationEnvelope, failure?: PlanningFailure) {
    if (!sessionGate.current.isCurrent(sessionTicket)) return;
    const currentFailure = failure ?? result?.failure;
    const response = (currentFailure ? undefined : result) as (PlanResult & { actions?: ActionView[]; managementActions?: ManagementAction[]; investmentActions?: InvestmentAction[]; goal?: GoalView }) | undefined;
    setPlanningFailure(currentFailure);
    latestPlanTaskId.current = response?.taskId;
    setLatestPlan(response); setRecentPlanActions(response?.actions ?? []);
    setLatestManagementActions(response?.managementActions ?? []);
    setLatestInvestmentActions(response?.investmentActions ?? []); setLatestGoal(response?.goal); setRequestedGoalId(response?.goal?.id);
    setSelectedActionId(response?.actions?.[0]?.id);
    if (response) {
      setServerMode(response.mode);
      const refreshKeys = dashboardRefreshKeys(dashboardSnapshot.current, response.actions ?? [])
        .filter(key => !observedTerminalActions.current.has(key));
      if (refreshKeys.length) {
        for (const key of refreshKeys) observedTerminalActions.current.add(key);
        void refreshDashboard(true, true);
      }
      setManagementDashboard(current => current ? { ...current, actions: mergeManagementActions(current.actions, response.managementActions) } : current);
    }
  }

  async function applyFault() {
    const ticket = sessionTicket;
    if (!sessionGate.current.isCurrent(ticket)) return;
    try {
      await api.setFault(faultMode);
      if (!sessionGate.current.isCurrent(ticket)) return;
      setFaultApplied(true);
      setNotice({ kind: 'success', text: faultMode === 'NORMAL' ? '下一笔转账将使用正常执行路径。' : `已为下一笔转账设置 ${faultMode}。` });
    } catch (error) {
      if (!sessionGate.current.isCurrent(ticket)) return;
      setFaultApplied(false);
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '故障注入设置失败。' });
    }
  }

  async function confirmAction(action: ActionView) {
    const ticket = sessionTicket;
    if (!sessionGate.current.isCurrent(ticket)) return;
    setBusyActionId(action.id);
    setNotice(undefined);
    try {
      if (action.tier === 'YELLOW') {
        const confirmed = await api.confirm(action.id, action.actionHash);
      if (!sessionGate.current.isCurrent(ticket)) return;
        if (confirmed.status === 'AWAITING_VERIFICATION') {
          setNotice({ kind: 'info', text: '日累计金额已升至红档，请重新核对并完成 Passkey 强验证。' });
        } else {
          setNotice({ kind: 'success', text: '本人确认已提交，动作状态将从服务端刷新。' });
        }
      } else {
        const optionResponse = await api.authenticationOptions(action.id);
      if (!sessionGate.current.isCurrent(ticket)) return;
      const optionsJSON = unwrapPublicKeyOptions(optionResponse) as unknown as PublicKeyCredentialRequestOptionsJSON;
        const assertion = await startAuthentication({ optionsJSON });
      if (!sessionGate.current.isCurrent(ticket)) return;
        await api.authenticationVerify(action.id, assertion);
      if (!sessionGate.current.isCurrent(ticket)) return;
        setNotice({ kind: 'success', text: 'Passkey 验证已提交，动作状态将从服务端刷新。' });
      }
      await refreshDashboard(true, true);
      if (!sessionGate.current.isCurrent(ticket)) return;
    } catch (error) {
      if (!sessionGate.current.isCurrent(ticket)) return;
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '授权未完成。' });
      await refreshDashboard(true, true);
    } finally {
      if (sessionGate.current.isCurrent(ticket)) setBusyActionId(undefined);
    }
  }

  async function registerPasskey() {
    const ticket = sessionTicket;
    if (!sessionGate.current.isCurrent(ticket)) return;
    setBusyActionId('register-passkey');
    try {
      const optionResponse = await api.registerOptions();
      if (!sessionGate.current.isCurrent(ticket)) return;
      const optionsJSON = unwrapPublicKeyOptions(optionResponse) as unknown as PublicKeyCredentialCreationOptionsJSON;
      const attestation = await startRegistration({ optionsJSON });
      if (!sessionGate.current.isCurrent(ticket)) return;
      await api.registerVerify(attestation);
      if (!sessionGate.current.isCurrent(ticket)) return;
      await refreshDashboard(true, true);
      if (!sessionGate.current.isCurrent(ticket)) return;
      setNotice({ kind: 'success', text: 'Passkey 已注册到当前演示账号，可用于红档授权。' });
    } catch (error) {
      if (!sessionGate.current.isCurrent(ticket)) return;
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Passkey 注册未完成。' });
      await refreshDashboard(true, true);
    } finally {
      if (sessionGate.current.isCurrent(ticket)) setBusyActionId(undefined);
    }
  }

  async function cancelAction(action: ActionView) {
    const ticket = sessionTicket;
    if (!sessionGate.current.isCurrent(ticket)) return;
    setBusyActionId(action.id);
    try {
      await api.cancel(action.id);
      if (!sessionGate.current.isCurrent(ticket)) return;
      await refreshDashboard(true, true);
      if (!sessionGate.current.isCurrent(ticket)) return;
      setNotice({ kind: 'success', text: '取消请求已提交。' });
    } catch (error) {
      if (!sessionGate.current.isCurrent(ticket)) return;
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '取消失败。' });
      await refreshDashboard(true, true);
    } finally {
      if (sessionGate.current.isCurrent(ticket)) setBusyActionId(undefined);
    }
  }

  async function reconcileAction(action: ActionView) {
    const ticket = sessionTicket;
    if (!sessionGate.current.isCurrent(ticket)) return;
    setBusyActionId(action.id);
    try {
      await api.reconcile(action.id);
      if (!sessionGate.current.isCurrent(ticket)) return;
      await refreshDashboard(true, true);
      if (!sessionGate.current.isCurrent(ticket)) return;
      setNotice({ kind: 'success', text: '查单完成，已按服务端状态刷新。' });
    } catch (error) {
      if (!sessionGate.current.isCurrent(ticket)) return;
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '查单失败。' });
      await refreshDashboard(true, true);
    } finally {
      if (sessionGate.current.isCurrent(ticket)) setBusyActionId(undefined);
    }
  }

  if (authState === 'signing-out' || authState === 'sign-out-failed') return <div className="page-loading" role="status">
    {authState === 'signing-out' ? <><div className="loader" /><span>正在退出登录，等待服务端确认…</span></> : <><ShieldAlert size={24} /><span>{notice?.text ?? '服务端退出尚未确认，请重试。'}</span><button className="button button-primary" onClick={() => void handleLogout()}>重试退出登录</button></>}
  </div>;
  if (authState === 'checking') return <div className="page-loading"><div className="loader" /><span>正在连接 BankPilot 本地沙箱…</span></div>;
  if (authState === 'signed-out') {
    return <LoginScreen
      email={email}
      password={password}
      busy={loginBusy}
      notice={notice}
      onEmail={setEmail}
      onPassword={setPassword}
      onSubmit={handleLogin}
    />;
  }

  const account = dashboard?.accounts[0];
  const availableMinor = account ? BigInt(account.balanceMinor) - BigInt(account.reservedMinor) : 0n;
  const activeActions = actions.filter((action) => !['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(action.status));

  return (
    <div className="app-frame" key={`${ownerId}:${sessionEpoch}`}>
      {mobileNavOpen && <button className="mobile-nav-scrim" aria-label="关闭导航菜单" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Landmark size={20} strokeWidth={2.3} /></div>
          <div><span className="brand-name">BankPilot</span><span className="brand-caption">银行智能工作台</span></div>
          <button className="icon-button sidebar-close" onClick={() => setMobileNavOpen(false)} aria-label="关闭菜单"><X size={17} /></button>
        </div>
        <div className="environment-chip"><span className="env-dot" />本地合成沙箱</div>
        <nav className="primary-nav" aria-label="主要功能">
          <div className="nav-label">服务</div>
          {navigation.map(({ name, icon: Icon, available }) => (
            <button
              className={`nav-item ${activeSection === name ? 'nav-active' : ''} ${!available ? 'nav-later' : ''}`}
              key={name}
              onClick={() => { setActiveSection(name); setMobileNavOpen(false); }}
              aria-current={activeSection === name ? 'page' : undefined}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{name}</span>
              {!available && <span className="nav-next">后续</span>}
              {available && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="support-card">
            <div className="support-icon"><ShieldCheck size={16} /></div>
            <div><strong>交易安全验证</strong><span>{dashboard?.passkeyCount === undefined ? '每笔操作需本人授权' : `${dashboard.passkeyCount} 个 Passkey 已登记`}</span></div>
          </div>
          <div className="sidebar-account">
            <div className="avatar">林</div>
            <div className="sidebar-user"><strong>林女士</strong><span>演示用户</span></div>
            <button className="icon-button logout-button" onClick={() => void handleLogout()} aria-label="退出登录" title="退出登录"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu" onClick={() => setMobileNavOpen(true)} aria-label="打开导航菜单"><Menu size={20} /></button>
            <div className="breadcrumbs"><span>个人金融</span><span className="breadcrumb-sep">/</span><strong>{activeSection}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className="mode-chip"><span className="mode-icon"><Sparkles size={13} /></span>{modeLabel(serverMode)}</span>
            <button className="icon-button top-icon" aria-label="通知" title="通知"><Bell size={18} /><i /></button>
            <div className="top-user"><div className="avatar avatar-small">林</div><ChevronDown size={14} /></div>
          </div>
        </header>

        <div className="content-area">
          {notice && <div className={`notice notice-${notice.kind}`} role="status"><span>{notice.text}</span><button className="notice-close" aria-label="关闭提示" onClick={() => setNotice(undefined)}><X size={15} /></button></div>}

          {activeSection === '转账工作台' ? (
            <>
              <section className="page-heading">
                <div>
                  <div className="eyebrow"><span className="eyebrow-line" />今日工作台 <span className="heading-date">{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</span></div>
                  <h1>把每笔转账，确认清楚。</h1>
                  <p>用自然语言提出需求，检查计划与风险，再由你本人授权执行。</p>
                </div>
                <button className="button button-outline refresh-button" onClick={() => void refreshAll()} disabled={refreshing}>
                  <RefreshCw size={15} className={refreshing ? 'spin' : ''} />刷新状态
                </button>
              </section>

              <section className="overview-grid" aria-label="账户概览">
                <article className="balance-card">
                  <div className="balance-card-top"><div><span className="card-overline">账户总余额</span><span className="account-name">{account?.name ?? '演示账户'}</span></div><div className="balance-icon"><Wallet size={20} /></div></div>
                  <div className="balance-number">{account ? formatMoney(account.balanceMinor) : '—'}</div>
                  <div className="balance-card-foot"><span><i className="balance-status-dot" />{dashboardStale ? '正在刷新完整账户状态' : '账户状态正常'}</span><span>{account?.maskedNumber ?? '•••• 0000'}</span></div>
                </article>
                <article className="metric-card available-card">
                  <div className="metric-top"><span>可用余额</span><div className="metric-icon mint"><ArrowDownLeft size={18} /></div></div>
                  <strong>{account ? formatMoney(availableMinor) : '—'}</strong>
                  <span className="metric-caption">已扣除待处理交易占额</span>
                  <div className="metric-foot"><span>待处理占额</span><b>{account ? formatMoney(account.reservedMinor) : '—'}</b></div>
                </article>
                <article className="metric-card daily-card">
                  <div className="metric-top"><span>今日已转出</span><div className="metric-icon blue"><ArrowRight size={18} /></div></div>
                  <strong>{formatMoney(dashboard?.dailyUsedMinor ?? '0')}</strong>
                  <span className="metric-caption">按服务端记账与状态汇总</span>
                  <div className="metric-foot"><span>风险校验</span><b className="positive-caption"><ShieldCheck size={14} />已启用</b></div>
                </article>
              </section>

              <div className="workbench-grid">
                <section className="chat-card panel">
                  <div className="panel-header chat-header">
                    <div className="panel-title-group"><div className="assistant-avatar"><Sparkles size={17} /></div><div><h2>BankPilot 助手</h2><span>描述你要办理的事情</span></div></div>
                    <div className="mode-explainer"><span className={`mode-led ${serverMode === 'model' ? 'mode-led-model' : ''}`} />{modeLabel(serverMode)}<button className="help-icon" title="本模式由服务端 PlanResult.mode 决定，不把脚本化规划标记为真实模型。" aria-label="了解规划模式"><CircleHelp size={15} /></button></div>
                  </div>
                  <Suspense fallback={<div className="business-loading" role="status"><span className="loader loader-small" />正在加载聊天工作台…</div>}>
                    <ConversationsPanel key={`${ownerId}:${sessionEpoch}`} ownerId={ownerId!} onViewPlan={viewConversationPlan} onError={(text) => { if (sessionGate.current.isCurrent(sessionTicket)) setNotice({ kind: 'error', text }); }} onPlanning={(value) => { if (sessionGate.current.isCurrent(sessionTicket)) setPlanning(value); }} />
                  </Suspense>
                </section>

                <aside className="right-column">
                  <section className="panel plan-panel">
                    <div className="panel-header compact-header">
                      <div><span className="section-kicker">服务端流程</span><h2>计划与执行进度</h2></div>
                      <span className="live-indicator"><i />服务端事件</span>
                    </div>
                    <AgentProgress events={latestPlan?.events ?? []} planning={planning} failure={planningFailure} plan={latestPlan} goal={latestGoal} planActions={latestPlan ? [...actions.filter((action) => action.taskId === latestPlan.taskId), ...managementPlanActions, ...latestInvestmentActions, ...(latestGoal?.nodes.flatMap(node => node.investmentAction ? [node.investmentAction] : []) ?? []), ...(latestGoal?.nodes.flatMap(node => node.transferAction ? [node.transferAction] : []) ?? [])] : []} />
                    {latestPlan && <PlanEvidenceCard plan={latestPlan} />}
                    {managementPlanActions.length > 0 && <ManagementActionsPanel actions={managementPlanActions} onRefresh={refreshAll} />}
                    {latestInvestmentActions.length > 0 && <div className="phase4-plan-link"><strong>赎回建议已准备 · 每笔需 Passkey</strong><p>请查看产品、金额和预计到账时间，再完成独立授权。</p><button className="button button-outline" onClick={() => setActiveSection('理财')}>查看赎回确认卡 <ArrowRight size={14} /></button></div>}
                    {latestGoal && <div className="phase4-plan-link"><strong>{latestGoal.title} · {formatMoney(latestGoal.amountMinor)}</strong><p>截止 {latestGoal.targetDate}。{latestGoal.status === 'NEEDS_REPLAN' ? latestGoal.reasons.join('；') : '请按资金准备步骤分别核对、授权；目标本身不授权付款。'}</p><button className="button button-outline" onClick={() => setActiveSection('生活目标')}>查看生活目标计划 <ArrowRight size={14} /></button></div>}
                  </section>

                  <section className="panel actions-panel">
                    <div className="panel-header compact-header">
                      <div><span className="section-kicker">待你处理</span><h2>交易授权</h2></div>
                      <span className="count-badge">{activeActions.length}</span>
                    </div>
                    {selectedAction ? (
                      <ActionReview
                        action={selectedAction}
                        payee={dashboard?.payees.find((item) => item.id === selectedAction.payeeId)}
                        fundsPreview={currentActionFunds?.preview}
                        snapshotFundsPreview={selectedPlanFundsSnapshot}
                        fundsLoading={selectedActionNeedsPreview && actionFundsLoading}
                        fundsError={currentActionFundsError}
                        busy={busyActionId === selectedAction.id}
                        registerBusy={busyActionId === 'register-passkey'}
                        onConfirm={() => void confirmAction(selectedAction)}
                        onCancel={() => void cancelAction(selectedAction)}
                        onReconcile={() => void reconcileAction(selectedAction)}
                        onRegisterPasskey={() => void registerPasskey()}
                      />
                    ) : (
                      <div className="empty-action"><div className="empty-action-icon"><LockKeyhole size={19} /></div><strong>暂无待授权交易</strong><span>提出转账需求后，服务端会返回可审阅动作。</span></div>
                    )}
                    {actions.length > 1 && <button className="text-action see-all-actions" onClick={() => setDrawerOpen(true)}>查看全部 {actions.length} 笔动作 <ArrowRight size={14} /></button>}
                  </section>

                  <section className="sandbox-panel">
                    <div className="sandbox-title"><div><span className="sandbox-label">本地演示控制</span><strong>下一笔执行故障</strong></div><div className="sandbox-icon"><CircleHelp size={15} /></div></div>
                    <p>仅影响合成银行下一笔转账，可验证超时后的查单恢复。</p>
                    <div className="fault-row">
                      <label className="visually-hidden" htmlFor="fault-mode">选择下一笔执行故障</label>
                      <select id="fault-mode" value={faultMode} onChange={(event) => { setFaultMode(event.target.value as FaultMode); setFaultApplied(false); }}>
                        <option value="NORMAL">正常执行</option>
                        <option value="TIMEOUT_AFTER_COMMIT">记账后超时 · UNKNOWN</option>
                        <option value="REJECT">模拟拒绝</option>
                      </select>
                      <button className="button button-quiet" onClick={() => void applyFault()}>{faultApplied ? <Check size={14} /> : <Plus size={14} />}{faultApplied ? '已设置' : '应用'}</button>
                    </div>
                  </section>
                </aside>
              </div>

              <section className="bottom-strip">
                <div className="bottom-strip-label"><FileClock size={15} /><span>最近动作</span></div>
                <div className="recent-actions">
                  {actions.slice(0, 3).map((action) => <button key={action.id} className="recent-action" onClick={() => { setSelectedActionId(action.id); setDrawerOpen(true); }}>
                    <span className={`tiny-status tiny-${statusTone(action.status)}`} /><span className="recent-name">给 {action.payeeName}</span><b>{formatMoney(action.amountMinor)}</b><span className="recent-status">{statusLabel(action.status)}</span><ArrowRight size={13} />
                  </button>)}
                  {actions.length === 0 && <span className="no-recent">完成规划后，最近的交易动作会显示在这里。</span>}
                </div>
                <button className="text-action audit-open" onClick={() => setDrawerOpen(true)}>回执与审计 <ArrowRight size={14} /></button>
              </section>
            </>
          ) : activeSection === '账单' ? (
            <BillsPage onBack={() => setActiveSection('转账工作台')} />
          ) : activeSection === '资金计划' ? (
            <FundsPlanPage accountId={account?.id} onBack={() => setActiveSection('转账工作台')} />
          ) : activeSection === '理财' ? (
            <InvestmentPages accountId={account?.id} planActions={latestInvestmentActions} onRefresh={refreshAll} />
          ) : activeSection === '生活目标' ? (
            <GoalsPage accountId={account?.id} accounts={dashboard?.accounts ?? []} payees={dashboard?.payees ?? []} suggestedGoal={latestGoal} requestedGoalId={requestedGoalId} onRefresh={refreshAll} />
          ) : activeSection === '请求恢复' ? (
            <PreparationRequestsPage onRefresh={refreshAll} onOpenResult={openPreparationResult} />
          ) : activeSection === '联系人' || activeSection === '卡片' || activeSection === '订阅' ? (
            <ManagementPages page={activeSection} payees={dashboard?.payees ?? []} dashboard={managementDashboard || latestManagementActions.length ? { cards: managementDashboard?.cards ?? [], ...managementDashboard, actions: mergeManagementActions(latestManagementActions, managementDashboard?.actions) } : undefined} onRefresh={refreshAll} />
          ) : (
            <ScopeNotice section={activeSection} onBack={() => setActiveSection('转账工作台')} />
          )}

          <footer className="page-footer"><span><i className="footer-dot" />所有账户与收款人均为合成数据</span><span>BankPilot Sandbox · 本地演示环境</span></footer>
        </div>
      </main>

      <button className="drawer-trigger" onClick={() => setDrawerOpen(true)} aria-label="打开动作、回执与审计"><FileClock size={18} /><span>流水与审计</span>{actions.length > 0 && <b>{actions.length}</b>}</button>

      {drawerOpen && <>
        <button className="drawer-scrim" aria-label="关闭流水与审计" onClick={() => setDrawerOpen(false)} />
        <aside className="audit-drawer" role="dialog" aria-modal="true" aria-labelledby="audit-title">
          <div className="drawer-header"><div><span className="section-kicker">账户安全记录</span><h2 id="audit-title">动作、回执与审计</h2></div><button className="icon-button" aria-label="关闭抽屉" onClick={() => setDrawerOpen(false)}><PanelRightClose size={19} /></button></div>
          <div className="drawer-section"><div className="drawer-section-heading"><span>交易动作</span><span>{actions.length} 笔</span></div>
            {actions.length ? <div className="drawer-action-list">{actions.map((action) => <button key={action.id} className={`drawer-action ${selectedActionId === action.id ? 'drawer-action-selected' : ''}`} onClick={() => setSelectedActionId(action.id)}>
              <span className={`tiny-status tiny-${statusTone(action.status)}`} /><span className="drawer-action-main"><strong>给 {action.payeeName}</strong><small>{statusLabel(action.status)} · {formatTime(action.createdAt)}</small></span><b>{formatMoney(action.amountMinor)}</b>
            </button>)}</div> : <p className="drawer-empty">目前没有服务端返回的动作。</p>}
          </div>
          {selectedAction && <div className="drawer-section"><div className="drawer-section-heading"><span>执行回执</span><span>{selectedAction.receipt ? '已收到' : '等待中'}</span></div>
            {selectedAction.receipt ? <div className="receipt-card"><div className="receipt-success"><CheckCircle2 size={17} /><strong>支付成功</strong></div><ReceiptRows action={selectedAction} /></div> : <p className="drawer-empty">{selectedAction.status === 'UNKNOWN' ? '执行结果不确定，请点击“手动查单”。查单会用原动作恢复状态，不会创建新转账。' : '服务端尚未返回银行回执。'} </p>}
          </div>}
          <div className="drawer-section drawer-audit"><div className="drawer-section-heading"><span>审计事件</span><span>{dashboard?.audit.length ?? 0} 条</span></div>
            {dashboard?.audit.length ? <ol className="audit-list">{dashboard.audit.map((event) => <li key={event.id}><span className="audit-marker" /><div className="audit-copy"><strong>{auditLabel(event.type)}</strong><p>{auditDetail(event.detail)}</p><time>{formatTime(event.createdAt)}</time></div></li>)}</ol> : <p className="drawer-empty">登录后，审计事件由服务端账户快照提供。</p>}
          </div>
          <div className="drawer-footer"><ShieldCheck size={16} /><span>以服务端状态与审计记录为准</span><button className="icon-button" aria-label="刷新账户状态" onClick={() => void refreshDashboard()}><RefreshCw size={15} /></button></div>
        </aside>
      </>}
    </div>
  );
}

function modeLabel(mode?: PlanResult['mode']): string {
  if (mode === 'scripted') return '合成银行 · 脚本化规划验证';
  if (mode === 'model') return '合成银行 · 真实模型模式';
  return '合成银行 · 等待服务端模式';
}

function auditLabel(type: string): string {
  const labels: Record<string, string> = {
    PLAN_CREATED: '生成交易计划',
    ACTION_CREATED: '建立待授权动作',
    ACTION_CONFIRMED: '本人确认动作',
    STRONG_AUTH_VERIFIED: 'Passkey 强验证通过',
    TRANSFER_SUBMITTED: '提交合成银行',
    TRANSFER_SUCCEEDED: '收到成功回执',
    TRANSFER_UNKNOWN: '提交结果待查',
    TRANSFER_REJECTED: '执行被拒绝',
    ACTION_CANCELLED: '取消交易动作',
    ACTION_RECONCILED: '查单状态恢复',
  };
  return labels[type] ?? type.replaceAll('_', ' ').toLowerCase();
}

function auditDetail(detail: Record<string, unknown>): string {
  return Object.entries(detail).slice(0, 3).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || '服务端记入的账户事件';
}

function LoginScreen({
  email,
  password,
  busy,
  notice,
  onEmail,
  onPassword,
  onSubmit,
}: {
  email: string;
  password: string;
  busy: boolean;
  notice?: { kind: string; text: string };
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return <div className="login-page">
    <div className="login-art">
      <div className="login-brand"><div className="brand-mark"><Landmark size={20} /></div><span>BankPilot</span><span className="login-beta">SANDBOX</span></div>
      <div className="login-story"><span className="eyebrow"><span className="eyebrow-line" />安全交易沙箱</span><h1>让智能助手<br /><em>每一步都可确认。</em></h1><p>从你的自然语言请求开始，检查计划、验证风险，最后由你本人授权。</p>
        <div className="login-flow"><div className="login-flow-step"><span className="flow-number">01</span><span>理解请求与账户边界</span><Check size={14} /></div><div className="login-flow-line" /><div className="login-flow-step"><span className="flow-number">02</span><span>展示动作与风险等级</span><Check size={14} /></div><div className="login-flow-line" /><div className="login-flow-step"><span className="flow-number">03</span><span>本人确认并取得回执</span><ShieldCheck size={14} /></div></div>
      </div>
      <div className="login-art-foot"><span>合成账户 · 不连接真实银行</span><span>© 2026 BankPilot</span></div>
    </div>
    <main className="login-form-side">
      <div className="login-card">
        <div className="login-card-heading"><span className="mini-overline">WELCOME BACK</span><h2>登录演示账户</h2><p>进入本地 BankPilot 合成银行工作台</p></div>
        {notice && <div className={`notice notice-${notice.kind}`} role="status">{notice.text}</div>}
        <form onSubmit={onSubmit} className="login-form">
          <label htmlFor="email">邮箱地址</label><div className="login-input-wrap"><CircleUserRound size={17} /><input id="email" autoComplete="username" type="email" value={email} onChange={(event) => onEmail(event.target.value)} required /></div>
          <div className="label-row"><label htmlFor="password">密码</label><span>本地演示账号</span></div><div className="login-input-wrap"><LockKeyhole size={17} /><input id="password" autoComplete="current-password" type="password" value={password} onChange={(event) => onPassword(event.target.value)} required /></div>
          <button className="button button-primary login-submit" type="submit" disabled={busy}>{busy ? <><span className="button-spinner" />连接中…</> : <>进入安全工作台<ArrowRight size={16} /></>}</button>
        </form>
        <div className="demo-credentials"><div className="demo-credential-icon"><BadgeCheck size={17} /></div><div><strong>预填的演示账号</strong><span>bankpilot@example.test</span><small>密码已预填，仅用于本地合成沙箱</small></div></div>
        <div className="login-security"><ShieldCheck size={15} /><span>交易确认与 Passkey 验证由本地 API 处理</span></div>
      </div>
      <div className="login-footnote">在合成账户中体验账单分析、资金保护与授权转账。</div>
    </main>
  </div>;
}

function AgentProgress({ events, planning, failure, plan, goal, planActions }: { events: AgentEvent[]; planning: boolean; failure?: PlanningFailure; plan?: PlanResult; goal?: GoalView; planActions: (ActionView | ManagementAction | InvestmentAction)[] }) {
  const latestByRole = new Map<string, AgentEvent>();
  for (const event of events) latestByRole.set(event.role, event);
  const awaitingAuthorization = planActions.some((action) => action.status === 'AWAITING_CONFIRMATION' || action.status === 'AWAITING_VERIFICATION');
  const actionUnknown = planActions.some((action) => action.status === 'UNKNOWN' || action.status === 'SUBMITTING');
  const actionAuthorized = planActions.some((action) => action.status === 'AUTHORIZED' || action.status === 'SETTLING');
  const actionSucceeded = planActions.some((action) => action.status === 'SUCCEEDED');
  const allActionsSucceeded = planActions.length > 0 && planActions.every((action) => action.status === 'SUCCEEDED') && (!goal || goal.status === 'SUCCEEDED');
  const latestModelRuns = new Map((plan?.modelRuns ?? []).map(run => [run.role, run]));
  const failedModelRun = [...latestModelRuns.values()].find((run) => run.status === 'failed');
  const needsClarification = Boolean(plan?.clarification);
  const fundsBlocked = !goal && Boolean(plan?.fundsPreview && !plan.fundsPreview.allowed);
  const closing = goal?.status === 'NEEDS_REPLAN'
    ? { title: '目标需要调整', state: '重新规划', detail: goal.reasons.join('；') }
    : awaitingAuthorization
    ? { title: '本人授权', state: '等待你确认', detail: '请核对具体操作对象、影响与风险级别，再确认下方动作。' }
    : fundsBlocked
      ? { title: '资金保护拦截', state: '不可授权', detail: plan?.fundsPreview?.reasons.join('；') || '当前可用资金不满足保护策略。' }
      : needsClarification
        ? { title: '需要补充信息', state: '等待补充', detail: plan?.clarification ?? '请补充必要信息后重新规划。' }
        : actionUnknown
          ? { title: '交易结果待查', state: '查单中', detail: '已有动作正在恢复服务端执行结果。' }
          : actionAuthorized
            ? { title: '本人已授权', state: '执行中', detail: '等待服务端 Worker 处理，不会重复提交。' }
            : failedModelRun
              ? { title: '规划未完成', state: '暂未完成', detail: '服务未能完成本次规划，请查看当前请求状态后再继续。' }
              : allActionsSucceeded
                ? { title: '操作已完成', state: '已完成', detail: '本次计划的全部动作均已返回成功回执。' }
                : actionSucceeded
                  ? { title: '操作部分完成', state: '查看各项回执', detail: '部分动作已成功，其余状态请查看对应动作。' }
                : planActions.length > 0
                  ? { title: '动作已结束', state: '无需授权', detail: '当前计划没有待本人确认的动作。' }
                  : plan?.suggestions.length || plan?.managementSuggestions?.length || plan?.investmentSuggestions?.length || plan?.goalSuggestion
                    ? { title: '规划建议已返回', state: '未创建动作', detail: '服务端没有返回可确认动作，请检查计划说明。' }
                    : { title: '暂无可执行动作', state: '规划已返回', detail: '当前结果没有待确认的业务动作。' };
  return <div className="agent-progress">
    <div className="progress-line" aria-hidden="true" />
    {failure ? (
      <div className="progress-empty" role="status"><strong>{planningFailureView(failure).title}</strong><p>{planningFailureView(failure).message}</p></div>
    ) : plan ? (
      <>
        {[...latestByRole.values()].map((event) => <div className="agent-step" key={event.role}>
          <div className={`agent-node ${event.status === 'completed' ? 'agent-node-done' : 'agent-node-live'}`}>{event.status === 'completed' ? <Check size={13} /> : <span className="node-pulse" />}</div>
          <div className="agent-step-copy"><div><strong>{roleLabel(event.role)}</strong><span className={event.status === 'completed' ? 'step-done' : 'step-active'}>{eventState(event)}</span></div><p>{event.summary}</p></div>
        </div>)}
        <div className="agent-step agent-step-end"><div className={`agent-node ${awaitingAuthorization ? 'agent-node-idle' : 'agent-node-done'}`}>{awaitingAuthorization ? <LockKeyhole size={12} /> : <Check size={13} />}</div><div className="agent-step-copy"><div><strong>{closing.title}</strong><span className={awaitingAuthorization ? 'step-wait' : fundsBlocked || failedModelRun ? 'step-active' : 'step-done'}>{closing.state}</span></div><p>{closing.detail}</p></div></div>
      </>
    ) : planning ? (
      <div className="progress-waiting"><span className="loader loader-small" /><div><strong>规划请求处理中</strong><p>等待服务端返回实际 Agent 事件。</p></div></div>
    ) : (
      <div className="progress-empty"><div className="empty-timeline-icon"><Clock3 size={16} /></div><strong>等待第一笔请求</strong><p>规划事件会按服务端 PlanResult.events 显示，不预设虚构进度。</p></div>
    )}
    {plan && <div className="plan-result-meta"><span className={`result-mode result-mode-${plan.mode}`}>{plan.mode === 'scripted' ? '脚本化规划验证' : '真实模型模式'}</span><span>计划版本 {plan.planVersion}</span></div>}
  </div>;
}

function FundsPreviewCard({ preview, title, stale = false }: { preview: FundsPreview; title: string; stale?: boolean }) {
  return <section className={`funds-preview-card ${preview.allowed ? 'funds-allowed' : 'funds-denied'} ${stale ? 'funds-stale' : ''}`} aria-label={title}>
    <div className="funds-preview-heading"><strong>{title}</strong><span>{stale ? '非实时快照' : preview.allowed ? '符合资金保护规则' : '保护规则拦截'}</span></div>
    <div className="funds-preview-grid"><div><span>当前账户可用</span><b>{formatMoney(preview.availableBeforeMinor)}</b></div><div><span>扣除保护后可安排</span><b>{formatMoney(preview.spendableMinor)}</b></div><div><span>保护金额</span><b>{formatMoney(preview.protectedMinor)}</b></div><div><span>资金缺口</span><b>{formatMoney(preview.shortfallMinor)}</b></div></div>
    {preview.amountMinor !== '0' && <p className="funds-obligation-note">本次拟支出 {formatMoney(preview.amountMinor)}；支出后账户可用 {formatMoney(preview.availableAfterMinor)}（包含仍需保护的金额）。</p>}
    {preview.obligations.length > 0 && <p className="funds-obligation-note">30 日内义务：{preview.obligations.map((item) => `${item.title} ${formatMoney(item.amountMinor)}`).join(' · ')}</p>}
    {!preview.allowed && preview.reasons.length > 0 && <ul className="funds-reasons">{preview.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>}
  </section>;
}

function PlanEvidenceCard({ plan }: { plan: PlanResult }) {
  const reports = plan.billReports ?? (plan.billReport ? [plan.billReport] : []);
  const analysis = plan.billAnalysis;
  const runs = plan.modelRuns ?? [];
  if (!reports.length && !analysis && !plan.billAnswerReview && !plan.fundsPreview && runs.length === 0) return null;
  return <div className="plan-evidence">
    {plan.billAnswerReview?.status === 'withheld' && <section className="plan-evidence-card" aria-label="账单答案待核对"><div className="evidence-heading"><strong>账单答案待核对</strong></div><p>{plan.billAnswerReview.message}</p></section>}
    {analysis && <section className="plan-evidence-card" aria-label="账单查询依据"><div className="evidence-heading"><strong>账单查询依据</strong><span>{({ complete: '所需账单已提供', partial: '仅有部分流水', missing_data: '缺少账单', unsupported: '需要明确查询条件' } as const)[analysis.status]}</span></div>{analysis.filter && <p>{analysis.filter.kind === 'category' ? '消费类别' : '商户名称包含'}：{analysis.filter.value}</p>}{analysis.status === 'partial' && <p>以下金额仅对应已提供流水，不代表完整月份的消费总额。</p>}{analysis.missingPeriods.length > 0 && <p>缺少完整账单的月份：{analysis.missingPeriods.join('、')}，未按零消费处理。</p>}{analysis.amountMinor !== undefined && <p>{analysis.kind === 'largest_expense' ? '最大单笔消费' : '符合条件的支出合计'}：<strong>{formatMoney(analysis.amountMinor)}</strong></p>}{analysis.transactionIds.length > 0 && <details><summary>查看 {analysis.transactionIds.length} 条原流水编号</summary><p>{analysis.transactionIds.join('、')}</p></details>}</section>}
    {reports.map(report => <section className="plan-evidence-card" key={report.period}><div className="evidence-heading"><strong>账单联动</strong><span>{report.period} · 合成历史</span></div>{report.coverage?.status === 'missing' ? <p>该月账单尚未提供，无法据此判断收支。</p> : <><div className="evidence-stats"><span>收入 <b>{formatMoney(report.incomeMinor)}</b></span><span>支出 <b>{formatMoney(report.expenseMinor)}</b></span><span>净额 <b>{formatMoney(report.netMinor)}</b></span></div>{report.coverage?.status === 'partial' && <p>本月数据不完整，金额仅按已提供流水计算。</p>}<p>{report.findings.length ? `发现 ${report.findings.length} 条账单提示。` : '本期没有返回异常或周期提示。'} 历史交易不重复计入当前余额。</p></>}</section>)}
    {plan.fundsPreview && <FundsPreviewCard preview={plan.fundsPreview} title="计划生成时资金预演" stale />}
    {runs.length > 0 && <section className="plan-evidence-card"><div className="evidence-heading"><strong>{plan.mode === 'scripted' ? '脚本规划结果' : '模型运行记录'}</strong><span>{plan.mode === 'scripted' ? '非 LLM' : `${runs.length} 次调用`}</span></div><div className="model-run-list">{runs.map((run, index) => <div className={`model-run ${run.status === 'failed' ? 'model-run-failed' : ''}`} key={`${run.role}-${index}`}><span>{roleLabel(run.role)} · {run.model}</span><b>{run.status === 'success' ? `${run.durationMs} ms` : '暂未完成'}</b></div>)}</div>{runs.some((run) => run.status === 'failed' && run.errorCode?.toLowerCase().includes('schema')) && <p className="model-schema-error">返回内容未能通过核对，未将其作为有效结果。</p>}</section>}
  </div>;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(period: string, delta: number): string {
  const [year, month] = period.split('-').map(Number);
  return monthKey(new Date(year, month - 1 + delta, 1));
}

function BillsPage({ onBack }: { onBack: () => void }) {
  const currentPeriod = monthKey(new Date());
  const [period, setPeriod] = useState(currentPeriod);
  const [report, setReport] = useState<BillReport>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [focusedId, setFocusedId] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    setReport(undefined);
    api.bills(period)
      .then((value) => { if (active) setReport(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '账单读取失败。'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, retryToken]);

  const evidenceTransactions = report ? (report as BillReport & { evidenceTransactions?: BillTransaction[] }).evidenceTransactions ?? [] : [];

  function focusTransaction(id: string) {
    setFocusedId(id);
    const currentId = report?.transactions.some((item) => item.id === id) ? `bill-${CSS.escape(id)}` : `bill-evidence-${CSS.escape(id)}`;
    document.getElementById(currentId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => setFocusedId((current) => current === id ? undefined : current), 2200);
  }

  const maxCategory = report ? Math.max(1, ...report.categories.filter((item) => item.category !== '收入').map((item) => Number(item.amountMinor))) : 1;
  return <section className="business-page bills-page">
    <header className="business-page-heading"><div><span className="section-kicker">合成历史账单</span><h1>账单分析</h1><p>分类、趋势和异常提示来自 API 账单报告；历史流水不会再次叠加到当前余额。</p></div><button className="button button-outline" onClick={onBack}><ArrowLeftRight size={15} />返回转账工作台</button></header>
    <div className="period-toolbar"><div><strong>统计期间</strong><span>{report?.generatedAt ? `报告生成于 ${formatTime(report.generatedAt)}` : '选择当前月或上月查看'}</span></div><div className="period-controls"><button className="button button-outline" onClick={() => setPeriod(shiftMonth(currentPeriod, -1))}>上月</button><label htmlFor="bill-period" className="visually-hidden">选择账单月份</label><input id="bill-period" type="month" value={period} max={currentPeriod} onChange={(event) => setPeriod(event.target.value)} /><button className="button button-outline" onClick={() => setPeriod(currentPeriod)} disabled={period === currentPeriod}>本月</button></div></div>
    {loading && <div className="business-loading"><span className="loader loader-small" />正在读取 {period} 合成账单…</div>}
    {error && <div className="business-error" role="alert">账单 API 未返回报告：{error}<button className="button button-outline" onClick={() => setRetryToken((value) => value + 1)}>重试</button></div>}
    {report?.coverage?.status === 'missing' && <section className="panel bill-category-panel"><h2>{period} 账单尚未提供</h2><p>不能将缺少数据理解为该月没有消费。请选择有账单的月份。</p></section>}
    {report && report.coverage?.status !== 'missing' && <>
      {report.coverage?.status === 'partial' && <p className="bill-coverage-note" role="status">该月数据不完整。以下汇总只覆盖已提供的流水，不代表完整月份的收支。</p>}
      <div className="bill-summary-grid"><article><span>本期收入</span><strong className="money-positive">{formatMoney(report.incomeMinor)}</strong></article><article><span>本期支出</span><strong>{formatMoney(report.expenseMinor)}</strong><small>前一期 {formatMoney(report.previousExpenseMinor)}</small></article><article><span>收支净额</span><strong className={BigInt(report.netMinor) >= 0n ? 'money-positive' : 'money-negative'}>{formatMoney(report.netMinor)}</strong><small>按合成账单交易汇总</small></article></div>
      <div className="bills-content-grid"><section className="panel bill-category-panel"><div className="business-panel-heading"><div><span className="section-kicker">支出分类</span><h2>{period} 分类汇总</h2></div><span className="synthetic-tag">合成数据</span></div><div className="category-bars">{report.categories.filter((category) => category.category !== '收入').map((category) => <div className="category-bar-row" key={category.category}><div className="category-bar-label"><strong>{category.category}</strong><span>{category.count} 笔 · {formatMoney(category.amountMinor)}</span></div><div className="category-track"><span style={{ width: `${Math.max(2, Number(category.amountMinor) / maxCategory * 100)}%` }} /></div><div className="category-source-links">{category.transactionIds.map((id) => <button key={id} onClick={() => focusTransaction(id)} title={`定位交易 ${id}`}>{id}</button>)}</div></div>)}{report.categories.every((item) => item.category === '收入') && <p className="no-report-data">没有支出分类记录。</p>}</div></section>
        <section className="panel bill-findings-panel"><div className="business-panel-heading"><div><span className="section-kicker">报告提示</span><h2>异常与周期记录</h2></div><span className="count-badge">{report.findings.length}</span></div>{report.findings.length ? <div className="finding-list">{report.findings.map((finding) => <article className="finding-card" key={finding.id}><div><strong>{finding.kind === 'LARGE_EXPENSE' ? '较大支出' : finding.kind === 'POSSIBLE_DUPLICATE' ? '可能重复' : '周期性支出'}</strong><p>{finding.summary}</p></div><div className="finding-links">{finding.transactionIds.map((id) => <button key={id} onClick={() => focusTransaction(id)}>查看原交易 {id} <ArrowRight size={12} /></button>)}</div></article>)}</div> : <p className="no-report-data">服务端本期没有返回异常或周期提示。</p>}</section></div>
      <section className="panel bill-transactions-panel"><div className="business-panel-heading"><div><span className="section-kicker">流水明细</span><h2>原始交易记录</h2></div><span className="transaction-count">{report.transactions.length} 笔</span></div><div className="table-scroll"><table className="bill-table"><thead><tr><th>记账时间</th><th>商户</th><th>分类</th><th>来源</th><th>金额</th><th>原记录 ID</th></tr></thead><tbody>{report.transactions.map((item) => <tr id={`bill-${CSS.escape(item.id)}`} className={focusedId === item.id ? 'bill-row-focused' : ''} key={item.id}><td>{formatTime(item.bookedAt)}</td><td>{item.merchant}</td><td><span className="category-chip">{item.category}</span></td><td>{item.source === 'SYNTHETIC_STATEMENT' ? '合成历史账单' : '沙箱转账'}</td><td className={item.direction === 'IN' ? 'money-positive' : ''}>{item.direction === 'IN' ? '+' : '−'}{formatMoney(item.amountMinor)}</td><td><button className="transaction-id-link" onClick={() => focusTransaction(item.id)}>{item.id}</button></td></tr>)}</tbody></table></div>{report.transactions.length === 0 && <p className="no-report-data">该期间没有交易记录。</p>}</section>
      {evidenceTransactions.length > 0 && <section className="panel bill-transactions-panel evidence-transactions-panel"><div className="business-panel-heading"><div><span className="section-kicker">周期对照证据</span><h2>跨月原始记录</h2></div><span className="synthetic-tag">不计入本期合计</span></div><div className="table-scroll"><table className="bill-table"><thead><tr><th>记账时间</th><th>商户</th><th>分类</th><th>金额</th><th>原记录 ID</th></tr></thead><tbody>{evidenceTransactions.map((item) => <tr id={`bill-evidence-${CSS.escape(item.id)}`} className={focusedId === item.id ? 'bill-row-focused' : ''} key={item.id}><td>{formatTime(item.bookedAt)}</td><td>{item.merchant}</td><td><span className="category-chip">{item.category}</span></td><td>{item.direction === 'IN' ? '+' : '−'}{formatMoney(item.amountMinor)}</td><td><button className="transaction-id-link" onClick={() => focusTransaction(item.id)}>{item.id}</button></td></tr>)}</tbody></table></div></section>}
    </>}
  </section>;
}

type ObligationDraft = { id: string; title: string; amountYuan: string; dueDate: string };

function minorToYuanInput(value: string): string {
  const amount = BigInt(value || '0');
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
}

function yuanToMinor(value: string): string | undefined {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed)) return undefined;
  const [yuan, fraction = ''] = trimmed.split('.');
  return String(BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, '0') || '0'));
}

function FundsPlanPage({ accountId, onBack }: { accountId?: string; onBack: () => void }) {
  const [overview, setOverview] = useState<FundsOverview>();
  const [minimumYuan, setMinimumYuan] = useState('');
  const [obligations, setObligations] = useState<ObligationDraft[]>([]);
  const refreshSerial = useRef(0);
  const draftRevision = useRef(0);
  const draftBaseVersion = useRef<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string }>();

  const refresh = useCallback(async () => {
    if (!accountId) return;
    const serial = ++refreshSerial.current;
    const hydrateIfRevision = draftRevision.current;
    setLoading(true);
    setError(undefined);
    try {
      const value = await api.funds(accountId);
      if (serial !== refreshSerial.current) return;
      setOverview(value);
      // An older read may finish after a person has started editing the form.
      if (hydrateIfRevision === draftRevision.current) {
        setMinimumYuan(minorToYuanInput(value.policy.minimumBalanceMinor));
        setObligations(value.policy.obligations.map((item) => ({ id: item.id, title: item.title, amountYuan: minorToYuanInput(item.amountMinor), dueDate: item.dueDate.slice(0, 10) })));
        draftBaseVersion.current = value.policy.version;
      } else if (draftBaseVersion.current !== undefined && value.policy.version !== draftBaseVersion.current) {
        setNotice({ kind: 'error', text: '资金规则版本已变化；当前表单尚未保存。请重新核对，旧版本提交会被拒绝。' });
      }
    } catch (reason) {
      if (serial === refreshSerial.current) setError(reason instanceof Error ? reason.message : '资金规则读取失败。');
    } finally {
      if (serial === refreshSerial.current) setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void refresh();
    return () => { refreshSerial.current += 1; };
  }, [refresh]);

  function updateObligation(id: string, key: keyof Omit<ObligationDraft, 'id'>, value: string) {
    draftRevision.current += 1;
    setObligations((current) => current.map((item) => item.id === id ? { ...item, [key]: value } : item));
  }

  async function savePolicy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!overview) return;
    const expectedVersion = draftBaseVersion.current;
    if (expectedVersion === undefined) {
      setNotice({ kind: 'error', text: '资金规则尚未完成读取，请刷新后再保存。' });
      return;
    }
    const minimumBalanceMinor = yuanToMinor(minimumYuan);
    if (minimumBalanceMinor === undefined) {
      setNotice({ kind: 'error', text: '最低保留金额格式无效，请输入最多两位小数的人民币金额。' });
      return;
    }
    const parsedObligations: FundObligation[] = [];
    for (const item of obligations) {
      const amountMinor = yuanToMinor(item.amountYuan);
      if (!item.title.trim() || !amountMinor || !item.dueDate) {
        setNotice({ kind: 'error', text: '请为每项义务填写名称、正数金额和到期日。' });
        return;
      }
      parsedObligations.push({ id: item.id, title: item.title.trim(), amountMinor, dueDate: item.dueDate });
    }
    setSaving(true);
    setNotice(undefined);
    try {
      const policy: FundsPolicy = await api.updateFundsPolicy({ expectedVersion, minimumBalanceMinor, obligations: parsedObligations, confirmed: true });
      setOverview((current) => current ? { ...current, policy } : current);
      setNotice({ kind: 'success', text: `资金保护规则已保存，版本 ${policy.version}。` });
      await refresh();
    } catch (reason) {
      const apiError = reason as { status?: number; code?: string; message?: string };
      if (apiError.status === 409 || apiError.code?.includes('VERSION')) {
        await refresh();
        setNotice({ kind: 'error', text: '资金规则版本已变化，已刷新服务端最新版本与表单；请复核后再保存。' });
      } else {
        setNotice({ kind: 'error', text: reason instanceof Error ? reason.message : '资金规则保存失败。' });
      }
    } finally {
      setSaving(false);
    }
  }

  return <section className="business-page funds-page">
    <header className="business-page-heading"><div><span className="section-kicker">资金保护规则</span><h1>资金计划</h1><p>查看未来 30 日义务与最低生活保留金额；转账前预演由服务端按最新余额重新计算。</p></div><button className="button button-outline" onClick={onBack}><ArrowLeftRight size={15} />返回转账工作台</button></header>
    {notice && <div className={`notice notice-${notice.kind}`} role="status"><span>{notice.text}</span></div>}
    {error && <div className="business-error" role="alert">资金规则 API 未返回数据：{error}<button className="button button-outline" onClick={() => void refresh()}>重试</button></div>}
    {loading && <div className="business-loading"><span className="loader loader-small" />正在读取资金规则…</div>}
    {!accountId && <p className="business-error">当前没有可用的合成账户。</p>}
    {overview && <>
      <FundsPreviewCard preview={overview.preview} title="当前账户 · 基准资金预演" />
      <form className="panel funds-policy-form" onSubmit={(event) => void savePolicy(event)}>
        <div className="business-panel-heading"><div><span className="section-kicker">本人配置</span><h2>30 日义务与最低生活保留</h2></div><span className="policy-version">版本 {overview.policy.version}</span></div>
        <fieldset disabled={saving} style={{ display: 'contents' }}>
        <label className="funds-form-field"><span>最低保留金额（元）</span><input inputMode="decimal" aria-label="最低保留金额（元）" value={minimumYuan} onChange={(event) => { draftRevision.current += 1; setMinimumYuan(event.target.value); }} placeholder="例如 3000.00" /></label>
        <div className="obligation-editor-heading"><div><strong>未来 30 日义务</strong><span>例如房租、保险或固定账单</span></div><button type="button" className="button button-outline" onClick={() => { draftRevision.current += 1; setObligations((current) => [...current, { id: crypto.randomUUID(), title: '', amountYuan: '', dueDate: new Date().toISOString().slice(0, 10) }]); }}><Plus size={14} />添加义务</button></div>
        <div className="obligation-editor">{obligations.map((item) => <div className="obligation-row" key={item.id}><label><span>义务名称</span><input aria-label="义务名称" value={item.title} onChange={(event) => updateObligation(item.id, 'title', event.target.value)} placeholder="例如 房租" /></label><label><span>金额（元）</span><input inputMode="decimal" aria-label="义务金额（元）" value={item.amountYuan} onChange={(event) => updateObligation(item.id, 'amountYuan', event.target.value)} placeholder="0.00" /></label><label><span>到期日</span><input type="date" aria-label="到期日" value={item.dueDate} onChange={(event) => updateObligation(item.id, 'dueDate', event.target.value)} /></label><button type="button" className="icon-button obligation-remove" aria-label={`删除${item.title || '未命名'}义务`} onClick={() => { draftRevision.current += 1; setObligations((current) => current.filter((entry) => entry.id !== item.id)); }}><X size={15} /></button></div>)}{obligations.length === 0 && <p className="no-report-data">尚未设置 30 日义务，可添加房租等计划支出。</p>}</div>
        </fieldset>
        <div className="funds-form-footer"><span>保存会提交当前策略版本号；冲突时将刷新并要求重新复核。</span><button className="button button-primary" type="submit" disabled={saving || loading}>{saving ? <><span className="button-spinner" />保存中…</> : <><Check size={15} />确认并保存规则</>}</button></div>
      </form>
    </>}
  </section>;
}

function ActionReview({ action, payee, fundsPreview, snapshotFundsPreview, fundsLoading, fundsError, busy, registerBusy, onConfirm, onCancel, onReconcile, onRegisterPasskey }: {
  action: ActionView;
  payee?: PayeeView;
  fundsPreview?: FundsPreview;
  snapshotFundsPreview?: FundsPreview;
  fundsLoading: boolean;
  fundsError?: string;
  busy: boolean;
  registerBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onReconcile: () => void;
  onRegisterPasskey: () => void;
}) {
  const isPending = action.status === 'AWAITING_CONFIRMATION' || action.status === 'AWAITING_VERIFICATION';
  const isUnknown = action.status === 'UNKNOWN' || action.status === 'SUBMITTING';
  const isFinal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(action.status);
  const riskHeading = action.status === 'SUCCEEDED'
    ? action.tier === 'RED' ? '已完成强验证' : '已完成本人确认'
    : isFinal
      ? `历史风险要求 · ${action.tier === 'RED' ? 'Passkey 强验证' : '本人确认'}`
      : action.tier === 'RED' ? '需要 Passkey 强验证' : '请核对后亲自确认';
  const riskDescription = isFinal ? `历史等级：${tierLabel(action.tier)}` : tierLabel(action.tier);
  return <div className="action-review">
    <div className={`risk-banner ${action.tier === 'RED' ? 'risk-red' : 'risk-yellow'}`}>
      <div className="risk-symbol">{action.tier === 'RED' ? <ShieldAlert size={17} /> : <ShieldCheck size={17} />}</div>
      <div><strong>{riskHeading}</strong><span>{riskDescription}</span></div>
      <span className="risk-tier">{action.tier}</span>
    </div>
    <div className="transfer-summary">
      <div className="transfer-payee"><div className="payee-avatar">{(payee?.name ?? action.payeeName).slice(0, 1)}</div><div><span>收款人</span><strong>{payee?.name ?? action.payeeName}</strong><small>{payee ? `${payee.bank} · ${payee.maskedNumber}` : action.payeeId}</small></div><div className="transfer-arrow"><ArrowRight size={16} /></div></div>
      <div className="transfer-amount"><span>转账金额</span><strong>{formatMoney(action.amountMinor)}</strong><small>人民币 · 合成转账</small></div>
      <div className="transfer-details"><span>备注</span><b>{action.memo || '无'}</b></div>
      <div className="transfer-details"><span>有效期</span><b>{formatTime(action.expiresAt)}</b></div>
      <div className="transfer-details action-status-row"><span>当前状态</span><b className={`status-pill status-${statusTone(action.status)}`}><i />{statusLabel(action.status)}</b></div>
    </div>
    {fundsPreview ? <FundsPreviewCard preview={fundsPreview} title="当前资金预演" /> : fundsLoading ? <div className="funds-inline-state"><span className="loader loader-small" />正在读取当前资金预演…</div> : fundsError ? <div className="funds-inline-error">当前资金预演读取失败：{fundsError}</div> : snapshotFundsPreview ? <FundsPreviewCard preview={snapshotFundsPreview} title="计划生成时资金快照" stale /> : <div className="funds-inline-error">当前资金预演不可用，授权前需重新读取。</div>}
    {action.failureReason && <div className={`action-message ${action.status === 'FAILED' ? 'action-message-error' : ''}`}>{action.failureReason}</div>}
    {action.status === 'UNKNOWN' && <div className="unknown-callout"><Clock3 size={16} /><span>银行可能已记账，但客户端没有收到响应。请先查单，避免重复提交。</span></div>}
    {action.receipt && <div className="receipt-card action-receipt"><div className="receipt-success"><CheckCircle2 size={16} /><strong>服务端回执</strong></div><ReceiptRows action={action} /></div>}
    {isPending && !fundsPreview?.allowed && <div className="funds-blocked" role="status"><ShieldAlert size={15} /><span>{fundsPreview ? fundsPreview.reasons.join('；') || (BigInt(fundsPreview.shortfallMinor) > 0n ? `可用资金不足 ${formatMoney(fundsPreview.shortfallMinor)}` : '资金保护规则不允许此笔转账，请核对保护金额与到期义务。') : '资金预演尚未确认允许，暂不能授权。'}</span></div>}
    {isPending && fundsPreview?.allowed && <div className="action-buttons">
      <button className={`button ${action.tier === 'RED' ? 'button-dark' : 'button-primary'} confirm-button`} onClick={onConfirm} disabled={busy}>
        {busy ? <><span className="button-spinner" />正在验证…</> : action.tier === 'RED' ? <><Fingerprint size={16} />Passkey 授权</> : <><ShieldCheck size={16} />确认并执行</>}
      </button>
      {action.tier === 'RED' && <button className="button button-outline passkey-register" onClick={onRegisterPasskey} disabled={registerBusy}>{registerBusy ? '正在注册…' : '还没有 Passkey？先注册'}</button>}
      <button className="cancel-link" onClick={onCancel} disabled={busy}>取消这笔转账</button>
    </div>}
    {isUnknown && <div className="action-buttons"><button className="button button-warning confirm-button" onClick={onReconcile} disabled={busy}>{busy ? <><span className="button-spinner" />正在查单…</> : <><RefreshCw size={15} />手动查单</>}</button><p className="button-hint">查单使用同一个动作 ID，不会再创建一笔转账。</p></div>}
    {action.status === 'AUTHORIZED' && <div className="status-explainer"><span className="loader loader-small" />已授权，等待服务端执行 Worker 处理。</div>}
    {action.status === 'SUBMITTING' && <div className="status-explainer"><span className="loader loader-small" />提交处理中。系统会每 1.5 秒刷新状态。</div>}
    {isFinal && <div className={`final-state final-${statusTone(action.status)}`}>{action.status === 'SUCCEEDED' ? <CheckCircle2 size={16} /> : <Clock3 size={16} />}{statusLabel(action.status)} · {formatTime(action.updatedAt)}</div>}
    <div className="action-hash"><span>动作校验摘要</span><code>{action.actionHash.slice(0, 17)}…</code></div>
  </div>;
}

function ReceiptRows({ action }: { action: ActionView }) {
  if (!action.receipt) return null;
  return <dl className="receipt-rows"><div><dt>银行请求号</dt><dd>{action.receipt.providerRequestId}</dd></div><div><dt>交易流水号</dt><dd>{action.receipt.providerTransactionId}</dd></div><div><dt>到账金额</dt><dd>{formatMoney(action.receipt.amountMinor)}</dd></div><div><dt>结算时间</dt><dd>{formatTime(action.receipt.settledAt)}</dd></div></dl>;
}

function ScopeNotice({ section, onBack }: { section: Exclude<Section, '转账工作台' | '联系人' | '账单' | '资金计划' | '请求恢复'>; onBack: () => void }) {
  const scope: Record<Exclude<Section, '转账工作台' | '联系人' | '账单' | '资金计划' | '请求恢复'>, { icon: typeof FileText; title: string; desc: string; note: string }> = {
    '理财': { icon: Banknote, title: '理财体验，后续扩展', desc: '合成理财产品展示与模拟操作可作为后续扩展方向。', note: '不属于当前首版范围；当前不接入行情或理财交易。' },
    '卡片': { icon: CreditCard, title: '卡片服务，后续扩展', desc: '卡状态查询、挂失与解挂可作为后续扩展方向。', note: '不属于当前首版范围；当前不展示真实卡片或处理 PIN 生命周期。' },
    '订阅': { icon: RefreshCw, title: '订阅管理，后续接入', desc: '周期账单和扣款授权会在后续阶段定义。', note: 'Stripe 官方样例依赖真实测试 API，目前不作为离线模拟器使用。' },
    '生活目标': { icon: Goal, title: '生活目标计划', desc: '按目标日期安排资金准备与逐项授权。', note: '当前生活目标页面仅适用于合成沙箱。' },
  };
  const item = scope[section];
  const Icon = item.icon;
  return <section className="scope-page"><div className="scope-icon"><Icon size={22} /></div><span className="section-kicker">首阶段范围说明</span><h1>{item.title}</h1><p>{item.desc}</p><div className="scope-note"><CircleHelp size={17} /><span>{item.note}</span></div><button className="button button-primary" onClick={onBack}><ArrowLeftRight size={16} />返回转账工作台</button></section>;
}
