import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileClock, RefreshCw } from 'lucide-react';
import type { PreparationRequest, PreparationRequestPage, PreparationResult } from '../../../packages/contracts/src/preparations';
import { api, getApiSessionSignal } from './api';
import { commandSummary } from './commandRecovery';
import { ManagementActionCard } from './ManagementPages';
import { InvestmentActionCard } from './InvestmentPages';
import { mergePreparationRequest } from './preparationState';

type Props = { onRefresh: () => Promise<void>; onOpenResult: (result: PreparationResult) => void | Promise<void> };
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : '请求状态暂时无法读取，请稍后再次查询。';
const stateLabel = { PENDING: '待核实或继续准备', PREPARED: '已生成原结果', ABANDONED: '已停止准备' };
const familyLabel = { management: '账户管理', investment: '理财赎回', goal: '生活目标' };
function dateLabel(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '时间暂不可用' : date.toLocaleString('zh-CN', { hour12: false }); }

/** The inbox is reconstructed entirely from the signed-in owner's server records. */
export function PreparationRequestsPage({ onRefresh, onOpenResult }: Props) {
  const [page, setPage] = useState<PreparationRequestPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cursor = useRef<string | undefined>(undefined);
  const mounted = useRef(false), epoch = useRef(0), lock = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const session = useRef(getApiSessionSignal());
  function current(version: number) { return mounted.current && epoch.current === version && !session.current?.aborted && session.current === getApiSessionSignal(); }
  async function load(nextCursor?: string) {
    if (lock.current || !mounted.current) return;
    lock.current = true; const version = epoch.current;
    cursor.current = nextCursor; controller.current?.abort();
    const requestController = new AbortController(); controller.current = requestController;
    setBusy(true); setError(undefined);
    try {
      const next = await api.preparationRequests(nextCursor, requestController.signal);
      if (current(version)) setPage(next);
    } catch (reason) { if (current(version)) setError(errorMessage(reason)); }
    finally { if (current(version)) { lock.current = false; setBusy(false); } }
  }
  useEffect(() => {
    mounted.current = true; epoch.current += 1; lock.current = false;
    void load();
    return () => { mounted.current = false; epoch.current += 1; controller.current?.abort(); lock.current = false; };
  }, []);
  return <section className="business-page preparation-page">
    <header className="business-page-heading"><div><span className="section-kicker">账户请求记录</span><h1>请求恢复</h1><p>查看当前账户保留的准备请求。每页最多 20 笔，按首次提交时间从新到旧排列。可先查询原结果，再决定继续准备或停止。</p></div><button type="button" className="button button-outline" disabled={busy} onClick={() => void load()}><RefreshCw size={14} />查看最新一页</button></header>
    <div className="notice notice-info"><span>读取记录不会执行付款、授权或 Passkey 验证。已生成候选的请求，请查看原结果；需要取消时，在原确认卡上单独操作。</span></div>
    {error && <div className="notice notice-error" role="alert"><span>本页读取失败：{error}{page && ' 下方保留上次成功读取的记录。'}</span><button type="button" className="button button-outline" disabled={busy} onClick={() => void load(cursor.current)}>重试读取此页</button></div>}
    {busy && <p className="preparation-read-status" role="status">正在读取请求记录…</p>}
    {page && page.requests.length === 0 && <div className="panel preparation-empty"><FileClock size={24} /><h2>暂无准备请求</h2><p>当前账户还没有可恢复的服务端请求记录。</p></div>}
    <div className="preparation-list">{page?.requests.map(request => <PreparationRequestRow key={`${request.family}:${request.commandId}`} initial={request} onRefresh={onRefresh} onOpenResult={onOpenResult} />)}</div>
    {page && <div className="preparation-pagination"><span>本页 {page.requests.length} 笔</span>{page.nextCursor ? <button type="button" className="button button-outline" disabled={busy} onClick={() => void load(page.nextCursor)}>查看下一页 <ArrowRight size={14} /></button> : <span>已到记录末尾</span>}</div>}
  </section>;
}

function PreparationRequestRow({ initial, onRefresh, onOpenResult }: Props & { initial: PreparationRequest }) {
  const [request, setRequest] = useState(initial);
  const requestRef = useRef(initial);
  const [result, setResult] = useState<PreparationResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [readRequired, setReadRequired] = useState(false);
  const readRequiredRef = useRef(false), lock = useRef(false), mounted = useRef(false), epoch = useRef(0);
  const session = useRef(getApiSessionSignal()), controller = useRef<AbortController | undefined>(undefined);
  function current(version: number) { return mounted.current && epoch.current === version && !session.current?.aborted && session.current === getApiSessionSignal(); }
  function requireRead(value: boolean) { readRequiredRef.current = value; setReadRequired(value); }
  function observe(incoming: PreparationRequest) {
    const merged = mergePreparationRequest(requestRef.current, incoming);
    requestRef.current = merged.request; setRequest(merged.request);
    if (merged.requiresRead) {
      requireRead(true);
      setNotice('收到的请求状态存在差异，已保留先前核实的结果。请重新查询原请求后再操作。');
    }
    return merged;
  }
  function observeResult(found: PreparationResult) {
    if (found.family !== requestRef.current.family) throw new Error('原结果与请求类型不一致，请重新查询原请求。');
    const merged = observe({ ...requestRef.current, state: 'PREPARED', resultId: found.result.id });
    if (merged.requiresRead) throw new Error('原请求结果与已核实状态不一致，请重新查询原请求。');
    setResult(found); requireRead(false);
  }
  useEffect(() => { mounted.current = true; epoch.current += 1; return () => { mounted.current = false; epoch.current += 1; controller.current?.abort(); }; }, []);
  useEffect(() => { observe(initial); }, [initial]);

  async function readRequest(version: number, signal: AbortSignal): Promise<PreparationRequest | undefined> {
    const fresh = await api.preparationRequest(request.family, request.commandId, signal);
    if (!current(version)) return;
    const merged = observe(fresh);
    if (merged.requiresRead) throw new Error('原请求状态尚未核实一致，请再次查询。');
    requireRead(false);
    return merged.request;
  }
  async function readResult(version: number, signal: AbortSignal): Promise<PreparationResult | undefined> {
    const found = await api.preparationResult(request.family, request.commandId, signal);
    if (!current(version)) return;
    observeResult(found);
    return found;
  }
  async function query(version: number, signal: AbortSignal) {
    const fresh = await readRequest(version, signal);
    if (!current(version) || !fresh) return;
    if (fresh.state === 'PREPARED') await readResult(version, signal);
    if (current(version)) setNotice(fresh.state === 'ABANDONED' ? '已确认这笔请求停止准备，原请求不会再生成候选。' : fresh.state === 'PREPARED' ? '已找到原请求结果。请核对下方原确认卡或生活目标。' : '已核实原请求尚未生成结果。可按原内容重试，或停止准备。');
  }
  async function run(kind: 'query' | 'retry' | 'stop') {
    if (lock.current || !mounted.current || (kind !== 'query' && (readRequiredRef.current || requestRef.current.state !== 'PENDING'))) return;
    const version = epoch.current; if (!current(version)) return;
    lock.current = true; controller.current?.abort();
    const requestController = new AbortController(); controller.current = requestController;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (kind === 'query') await query(version, requestController.signal);
      else if (kind === 'retry') {
        // Replaying always uses the server's exact saved input and original number.
        const found = await api.retryPreparation(request.family, request.commandId);
        if (!current(version)) return;
        observeResult(found);
        setNotice('已取得原请求的准备结果。后续确认与授权需要单独操作。');
      } else {
        const fresh = await api.abandonPreparation(request.family, request.commandId);
        if (!current(version)) return;
        const merged = observe(fresh);
        if (merged.requiresRead) throw new Error('停止回复与原请求状态存在差异，请重新查询原请求。');
        requireRead(false);
        if (merged.request.state === 'PREPARED') { setNotice('原请求已经生成结果，不能通过停止准备取消。请查询原结果，再在确认卡上单独取消候选。'); }
        else if (merged.request.state === 'ABANDONED') setNotice('已确认停止准备。原请求不会再生成候选。');
        else { requireRead(true); setNotice('尚未确认停止，请先查询原请求状态。'); }
      }
    } catch (reason) {
      if (!current(version)) return;
      setError(errorMessage(reason)); requireRead(true);
      if (kind !== 'query') {
        // A transport failure does not prove whether the write committed.
        try {
          if (kind === 'retry') {
            try { await readResult(version, requestController.signal); if (current(version)) setNotice('回复未完整收到，已查询到原请求结果。'); }
            catch { if (!current(version)) return; await query(version, requestController.signal); }
          } else await query(version, requestController.signal);
        } catch (readError) {
          if (!current(version)) return;
          requireRead(true); setNotice(`处理结果仍未核实：${errorMessage(readError)} 请先查询成功，再重试或停止。`);
        }
      } else setNotice('当前状态尚未核实，请先查询成功，再重试或停止。已读取的原结果继续保留。');
    } finally { if (current(version)) { lock.current = false; setBusy(false); } }
  }
  const summary = request.input ? commandSummary({ ...request.input, commandId: request.commandId }) : [];
  const pending = request.state === 'PENDING';
  return <article className="panel preparation-request" aria-label={`${familyLabel[request.family]}请求 ${request.commandId}`}>
    <div className="preparation-request-heading"><div><span className="section-kicker">{familyLabel[request.family]}</span><h2>{request.operation === 'goal-replan' ? '调整生活目标' : request.operation === 'goal-create' ? '创建生活目标' : request.family === 'investment' ? '准备理财赎回' : '准备管理操作'}</h2></div><span className={`preparation-state preparation-state-${request.state.toLowerCase()}`}>{stateLabel[request.state]}</span></div>
    <p className="preparation-request-id">请求编号：<code>{request.commandId}</code></p>
    <p className="preparation-request-time">首次提交：{dateLabel(request.createdAt)} · 最近更新：{dateLabel(request.updatedAt)}</p>
    <details className="preparation-original"><summary>核对原请求内容</summary>{summary.length > 0 ? <ul>{summary.map(line => <li key={line}>{line}</li>)}</ul> : <p>原请求内容暂不可用，请先查询当前状态。</p>}</details>
    {request.lastError && <p className="preparation-last-error">最近准备提示：{request.lastError.message}</p>}
    {error && <p className="preparation-last-error" role="alert">{error}</p>}
    {notice && <p className="preparation-notice" role="status">{notice}</p>}
    {readRequired && <p className="preparation-notice">请先成功查询原请求，再继续准备或停止。</p>}
    <div className="preparation-request-actions"><button type="button" className="button button-outline" disabled={busy} onClick={() => void run('query')}>{busy ? '正在核实…' : '查询原请求'}</button>{pending && <><button type="button" className="button button-outline" disabled={busy || readRequired || !request.input} onClick={() => void run('retry')}>按原内容重试</button><button type="button" className="button button-outline" disabled={busy || readRequired} onClick={() => void run('stop')}>停止准备</button></>}</div>
    {request.state === 'ABANDONED' && <p className="preparation-notice">此请求已停止准备。需要修改内容时，请在对应业务页面重新发起。</p>}
    {request.state === 'PREPARED' && !result && <p className="preparation-notice">原结果已生成。点击“查询原请求”读取确认卡或生活目标。</p>}
    {result && <div className="preparation-result">
      {result.family === 'management' && <ManagementActionCard key={result.result.id} action={result.result} onRefresh={onRefresh} />}
      {result.family === 'investment' && <InvestmentActionCard key={result.result.id} action={result.result} onRefresh={onRefresh} onUpdated={action => setResult({ family: 'investment', result: action })} />}
      {result.family === 'goal' && <div className="preparation-goal"><h3>{result.result.title}</h3><p>目标金额：{(Number(result.result.amountMinor) / 100).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' })} · 完成日期：{result.result.targetDate}</p><p>{result.result.status === 'SUCCEEDED' ? '目标已完成' : result.result.status === 'NEEDS_REPLAN' ? '目标需要调整' : '目标正在准备'} · 共 {result.result.nodes.length} 个步骤</p></div>}
      <button type="button" className="button button-outline" onClick={() => { if (current(epoch.current)) void onOpenResult(result); }}>{result.family === 'goal' ? '查看生活目标' : result.family === 'investment' ? '查看理财工作台' : '查看对应管理页面'} <ArrowRight size={14} /></button>
    </div>}
  </article>;
}
