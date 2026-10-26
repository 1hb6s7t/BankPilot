import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react';
import { LockKeyhole, Plus, RefreshCw, Send, Sparkles } from 'lucide-react';
import type { ChatMessage, Clarification, ClarificationAnswer, Conversation, ConversationCommand, ConversationEnvelope, ConversationHistory, ConversationRecoveryItem } from '../../../packages/contracts/src/conversations';
import type { PlanningFailure } from '../../../packages/contracts/src';
import { api, ApiError } from './api';
import { conversationCommandView, conversationView, createSubmission, GenerationGate, hasAcceptedSubmission, mergeConversationCommands, mergeConversationSummary, mergeConversationList, restoreConversationSelection, mergeClarifications, withClarificationEvidence, mergeHistoryMessages, recoveryItemsForPage, recoveryItemView, recoveryPageTarget, type RecoveryCursorState, type GenerationTicket, type PendingSubmission } from './chatState';

type Props = { ownerId: string; onViewPlan: (result?: ConversationEnvelope, failure?: PlanningFailure) => void; onPlanning: (value: boolean) => void; onError: (message: string) => void };
const time = (value: string) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
type RecoveryPageState = RecoveryCursorState & { items: ConversationRecoveryItem[] };
const emptyRecovery = (): RecoveryPageState => ({ previous: [], items: [] });

export function ConversationsPanel({ ownerId, onViewPlan, onPlanning, onError }: Props) {
  const gate = useRef(new GenerationGate());
  const ownerGate = useRef(new GenerationGate());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextConversations, setNextConversations] = useState<string>();
  const [loadingConversations, setLoadingConversations] = useState(false);
  const conversationListBusy = useRef(false);
  const [listError, setListError] = useState<string>();
  const [listRetry, setListRetry] = useState(0);
  const [conversationId, setConversationId] = useState<string>();
  const activeId = useRef<string | undefined>(undefined);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [commands, setCommands] = useState<ConversationCommand[]>([]);
  const commandsRef = useRef<ConversationCommand[]>([]);
  // Undefined follows the latest request; a user may explicitly inspect an older saved plan.
  const selectedCommandId = useRef<string | undefined>(undefined);
  const latestCommandId = useRef<string | undefined>(undefined);
  const latestConversationVersion = useRef(0);
  const historyRequest = useRef(0);
  const detailRequest = useRef(0);
  const recoveryRef = useRef<RecoveryPageState>(emptyRecovery());
  const [recovery, setRecovery] = useState<RecoveryPageState>(emptyRecovery);
  const recoveryBusy = useRef(false);
  const recoveryFirstPending = useRef(false);
  const [loadingRecovery, setLoadingRecovery] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string>();
  const [clarifications, setClarifications] = useState<Clarification[]>([]);
  const clarificationsRef = useRef<Clarification[]>([]);
  const [before, setBefore] = useState<number>();
  const [hydrating, setHydrating] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [sending, setSending] = useState(false);
  const operationLock = useRef(false);
  const pendingByConversation = useRef(new Map<string, PendingSubmission>());
  const [pending, setPending] = useState<PendingSubmission>();
  const [error, setError] = useState<string>();
  const [continuation, setContinuation] = useState<Clarification>();
  const [answer, setAnswer] = useState<ClarificationAnswer>({});
  const shownComplete = useRef(new Set<string>());
  const callbacks = useRef({ onViewPlan, onPlanning, onError });
  callbacks.current = { onViewPlan, onPlanning, onError };
  const currentCommand = conversationView(conversationId ?? '', commands, false, selectedCommandId.current, latestCommandId.current).command;
  const running = [currentCommand, ...recovery.items].some(command => command?.status === 'pending' || command?.status === 'running');
  const waiting = recovery.items.some(item => item.clarification) || commands.some(command => ['WAITING_QUERY','PLANNING'].includes(command.result?.subscriptionContinuation?.state ?? ''));
  const blocked = hydrating || sending || Boolean(pending) || !conversationId;

  const publishClarifications = useCallback((incoming: Clarification[]) => {
    const id = activeId.current;
    if (!id) return;
    const merged = mergeClarifications(id, clarificationsRef.current, incoming);
    clarificationsRef.current = merged; setClarifications(merged);
    const commands = withClarificationEvidence(id, commandsRef.current, merged);
    commandsRef.current = commands; setCommands(commands);
    const page = { ...recoveryRef.current, items: recoveryItemsForPage(id, recoveryRef.current.items, commands, merged) };
    recoveryRef.current = page; setRecovery(page);
  }, []);

  const publishCommands = useCallback((incoming: ConversationCommand[], source: 'history' | 'detail' = 'detail') => {
    const id = activeId.current;
    if (!id) return;
    publishClarifications(incoming.flatMap(command => command.clarification ? [command.clarification] : []));
    const merged = mergeConversationCommands(id, commandsRef.current, withClarificationEvidence(id, incoming, clarificationsRef.current), source);
    commandsRef.current = merged; setCommands(merged);
    const page = { ...recoveryRef.current, items: recoveryItemsForPage(id, recoveryRef.current.items, merged, clarificationsRef.current) };
    recoveryRef.current = page; setRecovery(page);
    const view = conversationView(id, merged, pendingByConversation.current.has(id), selectedCommandId.current, latestCommandId.current);
    callbacks.current.onViewPlan(view.result, view.failure);
  }, [publishClarifications]);

  const refreshLatestPlan = useCallback(async (id: string, ticket: GenerationTicket, force = false) => {
    const target = selectedCommandId.current ?? latestCommandId.current;
    const latest = conversationView(id, commandsRef.current, pendingByConversation.current.has(id), selectedCommandId.current, latestCommandId.current);
    const commandId = target ?? latest.command?.commandId;
    if (!commandId) return;
    const key = latest.command ? `${commandId}:${latest.command.stateVersion ?? latest.command.updatedAt}` : undefined;
    if (!force && key && latest.command?.status === 'complete' && shownComplete.current.has(key)) return;
    const request = ++detailRequest.current;
    const fresh = await api.conversationCommand(id, commandId, ticket.signal);
    if (!gate.current.isCurrent(ticket) || id !== activeId.current || request !== detailRequest.current) return;
    if (fresh.commandId !== (selectedCommandId.current ?? latestCommandId.current ?? commandId)) return;
    shownComplete.current.add(`${fresh.commandId}:${fresh.stateVersion ?? fresh.updatedAt}`);
    publishCommands([fresh]);
  }, [publishCommands]);

  const applyHistory = useCallback((history: ConversationHistory, ticket: GenerationTicket, earlier = false) => {
    if (!gate.current.isCurrent(ticket) || history.conversation.id !== activeId.current) return;
    const page = mergeHistoryMessages(history.conversation.id, messagesRef.current, history.messages, earlier);
    messagesRef.current = page.messages; setMessages(page.messages); setBefore(page.beforeSequence);
    publishClarifications(history.clarifications);
    if (!earlier && history.conversation.version >= latestConversationVersion.current) {
      latestConversationVersion.current = history.conversation.version;
      latestCommandId.current = history.latestCommandId;
    }
    const submission = pendingByConversation.current.get(history.conversation.id);
    if (submission && hasAcceptedSubmission(history.messages, submission)) {
      pendingByConversation.current.delete(history.conversation.id);
      setPending(undefined);
    }
    publishCommands(history.commands, 'history');
    setConversations(current => current.map(item => mergeConversationSummary(item, history.conversation)));
  }, [publishCommands, publishClarifications]);

  const readHistory = useCallback(async (id: string, ticket: GenerationTicket, beforeSequence?: number, earlier = false) => {
    const request = earlier ? undefined : ++historyRequest.current;
    const history = await api.conversationHistory(id, beforeSequence, ticket.signal);
    if (!gate.current.isCurrent(ticket) || (request !== undefined && request !== historyRequest.current)) return;
    applyHistory(history, ticket, earlier);
  }, [applyHistory]);

  const readRecovery = useCallback(async (id: string, ticket: GenerationTicket, move: 'refresh' | 'first' | 'next' | 'previous' = 'refresh') => {
    if (!gate.current.isCurrent(ticket) || id !== activeId.current) return;
    if (recoveryBusy.current) { if (move === 'first') recoveryFirstPending.current = true; return; }
    const target = recoveryPageTarget(recoveryRef.current, move);
    if (!target) return;
    recoveryBusy.current = true; setLoadingRecovery(true);
    try {
      const page = await api.conversationRecovery(id, target.cursor, ticket.signal);
      if (!gate.current.isCurrent(ticket) || id !== activeId.current) return;
      if (page.nextCursor !== undefined && page.nextCursor === target.cursor) throw new Error('这页待处理请求尚未读全，请重试刷新。');
      const next = { ...target, nextCursor: page.nextCursor, items: recoveryItemsForPage(id, page.items, commandsRef.current, clarificationsRef.current) };
      recoveryRef.current = next; setRecovery(next); setRecoveryError(undefined);
    } catch (cause) {
      if (gate.current.isCurrent(ticket)) setRecoveryError(cause instanceof Error ? cause.message : '读取待处理请求失败，请重试。');
    } finally {
      if (gate.current.isCurrent(ticket)) {
        recoveryBusy.current = false; setLoadingRecovery(false);
        if (recoveryFirstPending.current) { recoveryFirstPending.current = false; void readRecovery(id, ticket, 'first'); }
      }
    }
  }, []);

  const selectConversation = useCallback(async (id: string) => {
    const ticket = gate.current.renew();
    activeId.current = id;
    selectedCommandId.current = undefined;
    latestCommandId.current = undefined; latestConversationVersion.current = 0; historyRequest.current += 1;
    detailRequest.current += 1;
    try { sessionStorage.setItem(`bankpilot:selected-conversation:${ownerId}`, id); } catch { /* History still works with browser storage disabled. */ }
    callbacks.current.onViewPlan(undefined);
    operationLock.current = false;
    setConversationId(id); messagesRef.current = []; setMessages([]); commandsRef.current = []; setCommands([]); clarificationsRef.current = []; setClarifications([]); setBefore(undefined);
    setContinuation(undefined); setAnswer({}); setError(undefined); setSending(false); setLoadingEarlier(false);
    recoveryRef.current = emptyRecovery(); setRecovery(recoveryRef.current); recoveryBusy.current = false; recoveryFirstPending.current = false; setLoadingRecovery(false); setRecoveryError(undefined);
    setPending(pendingByConversation.current.get(id)); setHydrating(true);
    try {
      await Promise.all([readHistory(id, ticket), readRecovery(id, ticket, 'first')]);
      if (!gate.current.isCurrent(ticket)) return;
      await refreshLatestPlan(id, ticket, true);
    } catch (cause) {
      if (gate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : '无法恢复聊天历史。');
    } finally {
      if (gate.current.isCurrent(ticket)) setHydrating(false);
    }
  }, [readHistory, readRecovery, refreshLatestPlan, ownerId]);

  useEffect(() => {
    const ticket = ownerGate.current.renew();
    setListError(undefined); setHydrating(true);
    void (async () => {
      try {
        const page = await api.conversations(ticket.signal);
        if (!ownerGate.current.isCurrent(ticket)) return;
        let selected: string | null = null;
        try { selected = sessionStorage.getItem(`bankpilot:selected-conversation:${ownerId}`); } catch { /* Optional view preference only. */ }
        const { conversations: list, selected: chosen } = await restoreConversationSelection(page.conversations, selected, async id => {
          try { return await api.conversation(id, ticket.signal); }
          catch (cause) { if (cause instanceof ApiError && cause.status === 404) return undefined; throw cause; }
        });
        if (!ownerGate.current.isCurrent(ticket)) return;
        if (!list.length) list.push(await api.createConversation(ticket.signal));
        if (!ownerGate.current.isCurrent(ticket)) return;
        setConversations(list); setNextConversations(page.nextCursor);
        await selectConversation(chosen?.id ?? list[0]!.id);
      } catch (cause) {
        if (ownerGate.current.isCurrent(ticket)) { setListError(cause instanceof Error ? cause.message : '无法读取聊天列表。'); setHydrating(false); }
      }
    })();
    return () => { ownerGate.current.abort(); gate.current.abort(); };
  }, [selectConversation, ownerId, listRetry]);

  async function loadMoreConversations() {
    if (!nextConversations || conversationListBusy.current) return;
    const cursor = nextConversations, ticket = ownerGate.current.capture();
    conversationListBusy.current = true; setLoadingConversations(true);
    try {
      const page = await api.conversations(ticket.signal, cursor);
      if (!ownerGate.current.isCurrent(ticket)) return;
      if (page.nextCursor === cursor) throw new Error('这页聊天列表尚未读全，请重试加载。');
      setConversations(current => mergeConversationList(current, page.conversations));
      setNextConversations(page.nextCursor); setListError(undefined);
    } catch (cause) { if (ownerGate.current.isCurrent(ticket)) setListError(cause instanceof Error ? cause.message : '读取更多聊天失败，请重试。'); }
    finally { if (ownerGate.current.isCurrent(ticket)) { conversationListBusy.current = false; setLoadingConversations(false); } }
  }

  useEffect(() => { callbacks.current.onPlanning(running || sending); return () => callbacks.current.onPlanning(false); }, [running, sending]);
  useEffect(() => {
    if (!continuation) return;
    const current = clarifications.find(item => item.id === continuation.id);
    if (current && (current.status !== 'waiting' || current.version !== continuation.version)) { setContinuation(undefined); setAnswer({}); }
  }, [clarifications, continuation]);

  // Each poll finishes before the next starts. History reads never invoke planning.
  useEffect(() => {
    if (!conversationId || hydrating || (!running && !pending && !waiting)) return;
    const ticket = gate.current.capture();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await Promise.all([readHistory(conversationId, ticket), readRecovery(conversationId, ticket)]);
        if (stopped || !gate.current.isCurrent(ticket)) return;
        await refreshLatestPlan(conversationId, ticket, Boolean(continuation));
      } catch (cause) {
        if (!stopped && gate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : '读取请求进度失败。');
      } finally {
        if (!stopped && gate.current.isCurrent(ticket)) timer = setTimeout(poll, 1500);
      }
    };
    timer = setTimeout(poll, 750);
    return () => { stopped = true; clearTimeout(timer); };
  }, [conversationId, hydrating, running, waiting, pending, continuation, readHistory, readRecovery, refreshLatestPlan]);

  async function subscriptionAction(commandId: string, action: 'resume' | 'requery' | 'stop') {
    if (!conversationId || operationLock.current) return;
    const id = conversationId, ticket = gate.current.capture();
    operationLock.current = true; setSending(true);
    try {
      await api.subscriptionContinuation(id, commandId, action, ticket.signal);
      if (!gate.current.isCurrent(ticket)) return;
      await readHistory(id, ticket); await readRecovery(id, ticket);
      selectedCommandId.current = action === 'requery' ? commandId : undefined;
      await refreshLatestPlan(id, ticket, true);
    } catch (cause) {
      if (gate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : '订阅续办状态更新失败。');
    } finally { operationLock.current = false; if (gate.current.isCurrent(ticket)) setSending(false); }
  }
  async function submit(submission: PendingSubmission) {
    if (operationLock.current || activeId.current !== submission.conversationId) return;
    const ticket = gate.current.capture();
    operationLock.current = true; setSending(true); setError(undefined);
    selectedCommandId.current = undefined;
    historyRequest.current += 1;
    detailRequest.current += 1;
    callbacks.current.onViewPlan(undefined);
    pendingByConversation.current.set(submission.conversationId, submission); setPending(submission);
    try {
      const accepted = await api.sendConversationMessage(submission.conversationId, submission.body, ticket.signal);
      if (!gate.current.isCurrent(ticket)) return;
      pendingByConversation.current.delete(submission.conversationId); setPending(undefined);
      latestCommandId.current = accepted.command.commandId; historyRequest.current += 1;
      const page = mergeHistoryMessages(submission.conversationId, messagesRef.current, [accepted.message]);
      messagesRef.current = page.messages; setMessages(page.messages); setBefore(page.beforeSequence);
      publishCommands([accepted.command]);
      setContinuation(undefined); setAnswer({});
      if (submission.body.clarificationId && accepted.command.parentCommandId) {
        const answered = clarificationsRef.current.find(item => item.id === submission.body.clarificationId && item.parentCommandId === accepted.command.parentCommandId);
        // A returned successor proves the server committed the exact clarification
        // version CAS. Retain that closure before optional follow-up reads.
        if (answered && submission.body.expectedClarificationVersion !== undefined) publishClarifications([{
          ...answered, status: 'resolved', version: submission.body.expectedClarificationVersion + 1, resolvedByCommandId: accepted.command.commandId,
        }]);
        const parent = await api.conversationCommand(submission.conversationId, accepted.command.parentCommandId, ticket.signal);
        if (!gate.current.isCurrent(ticket)) return;
        publishCommands([parent]);
      }
      await Promise.all([readHistory(submission.conversationId, ticket), readRecovery(submission.conversationId, ticket, 'first')]);
      if (!gate.current.isCurrent(ticket)) return;
      await refreshLatestPlan(submission.conversationId, ticket);
    } catch (cause) {
      if (!gate.current.isCurrent(ticket)) return;
      // Validation conflicts are known failures; connectivity/5xx may follow a committed save.
      if (cause instanceof ApiError && cause.status && cause.status < 500 && cause.status !== 408) {
        pendingByConversation.current.delete(submission.conversationId); setPending(undefined);
      }
      setError(cause instanceof Error ? cause.message : '发送状态未知，请重试同一消息。');
    } finally {
      if (gate.current.isCurrent(ticket)) { operationLock.current = false; setSending(false); }
    }
  }

  async function send(text: string) {
    if (blocked || operationLock.current || !conversationId || !text.trim()) return;
    if (continuation) return; // Typed continuation has its own complete-slot submit control.
    await submit(createSubmission(conversationId, text));
  }
  async function newConversation() {
    if (hydrating || sending) return;
    const ticket = gate.current.capture(); setHydrating(true);
    try {
      const created = await api.createConversation(ticket.signal);
      if (!gate.current.isCurrent(ticket)) return;
      setConversations(current => mergeConversationList(current, [created]));
      await selectConversation(created.id);
    } catch (cause) {
      if (gate.current.isCurrent(ticket)) { setError(cause instanceof Error ? cause.message : '新建聊天失败。'); setHydrating(false); }
    }
  }
  async function reload(earlier = false) {
    if (!conversationId || hydrating || sending || loadingEarlier) return;
    const ticket = gate.current.capture();
    if (earlier) setLoadingEarlier(true); else setHydrating(true);
    try {
      await readHistory(conversationId, ticket, earlier ? before : undefined, earlier);
      if (!earlier && gate.current.isCurrent(ticket)) await refreshLatestPlan(conversationId, ticket, true);
      if (gate.current.isCurrent(ticket)) setError(undefined);
    } catch (cause) { if (gate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : '历史读取失败。'); }
    finally { if (gate.current.isCurrent(ticket)) { setHydrating(false); setLoadingEarlier(false); } }
  }
  async function commandAction(command: ConversationCommand | string, retry: boolean, continueAfter = false) {
    if (blocked || operationLock.current || !conversationId) return;
    if (retry && typeof command !== 'string' && !conversationCommandView(command).canRetry) return;
    const ticket = gate.current.capture(); operationLock.current = true; setSending(true); setError(undefined);
    const commandId = typeof command === 'string' ? command : command.commandId;
    selectedCommandId.current = commandId;
    const request = ++detailRequest.current;
    callbacks.current.onViewPlan(undefined);
    try {
      let fresh = await api.conversationCommand(conversationId, commandId, ticket.signal);
      if (!gate.current.isCurrent(ticket) || request !== detailRequest.current) return;
      if (retry && conversationCommandView(fresh).canRetry) fresh = await api.retryConversationCommand(conversationId, commandId, ticket.signal);
      if (!gate.current.isCurrent(ticket) || request !== detailRequest.current) return;
      publishCommands([fresh]);
      if (continueAfter && fresh.clarification?.status === 'waiting') {
        if (continuation?.id !== fresh.clarification.id || continuation.version !== fresh.clarification.version) setAnswer({});
        setContinuation(fresh.clarification);
      }
      await Promise.all([readHistory(conversationId, ticket), readRecovery(conversationId, ticket)]);
    } catch (cause) { if (gate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : '请求读取失败，可重试原请求。'); }
    finally { if (gate.current.isCurrent(ticket)) { operationLock.current = false; setSending(false); } }
  }
  async function cancelClarification(item: Pick<Clarification, 'id' | 'version' | 'parentCommandId'>) {
    if (blocked || !conversationId || operationLock.current) return;
    const ticket = gate.current.capture(); operationLock.current = true; setSending(true);
    try {
      const cancelled = await api.cancelConversationClarification(conversationId, item.id, item.version, ticket.signal);
      if (!gate.current.isCurrent(ticket)) return;
      publishClarifications([cancelled]);
      setContinuation(undefined); setAnswer({});
      const command = await api.conversationCommand(conversationId, item.parentCommandId, ticket.signal);
      if (!gate.current.isCurrent(ticket)) return;
      publishCommands([command]);
      await Promise.all([readHistory(conversationId, ticket), readRecovery(conversationId, ticket)]);
    } catch (cause) { if (gate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : '取消澄清失败。'); }
    finally { if (gate.current.isCurrent(ticket)) { operationLock.current = false; setSending(false); } }
  }
  async function showLatestRequest() {
    if (!conversationId || blocked || operationLock.current) return;
    const ticket = gate.current.capture(); selectedCommandId.current = undefined; detailRequest.current += 1;
    callbacks.current.onViewPlan(undefined);
    try { await refreshLatestPlan(conversationId, ticket, true); }
    catch (cause) { if (gate.current.isCurrent(ticket)) setError(cause instanceof Error ? cause.message : '读取最新请求失败。'); }
  }
  const recoveryIds = new Set(recovery.items.map(item => item.commandId));
  const messageCommandIds = new Set(messages.flatMap(message => message.commandId ? [message.commandId] : []));
  const waitingParentIds = new Set(clarifications.filter(item => item.status === 'waiting').map(item => item.parentCommandId));
  const timelineCommands = commands.filter(command => messageCommandIds.has(command.commandId) && !recoveryIds.has(command.commandId) && !waitingParentIds.has(command.commandId));
  const typedReady = continuation?.requestedSlots.every(slot => slot === 'payee' ? Boolean(answer.payeeId || answer.payeeSuffix) : slot === 'amount' ? Boolean(answer.amount?.trim()) : Boolean(answer.targetDate?.trim()));
  const convertMessage = useCallback((message: ChatMessage): ThreadMessageLike => ({ id: message.id, role: message.role, content: [{ type: 'text', text: message.text }], createdAt: new Date(message.createdAt) }), []);
  const runtime = useExternalStoreRuntime({ messages, convertMessage, isLoading: hydrating, isDisabled: hydrating || !conversationId, isSendDisabled: blocked || Boolean(continuation), isRunning: running || sending,
    onNew: async (message: AppendMessage) => { await send(message.content.filter(part => part.type === 'text').map(part => part.text).join('').trim()); },
  });

  return <AssistantRuntimeProvider runtime={runtime}><div className="chat-thread persistent-chat">
    <div className="conversation-toolbar"><label>聊天<select aria-label="选择聊天" value={conversationId ?? ''} disabled={hydrating || sending} onChange={event => void selectConversation(event.target.value)}>{!conversationId && <option value="">正在恢复…</option>}{conversations.map(item => <option key={item.id} value={item.id}>{item.title || '新聊天'}</option>)}</select></label><button aria-label="新建聊天" disabled={hydrating || sending} onClick={() => void newConversation()}><Plus size={14} />新聊天</button><button aria-label="重载聊天历史" disabled={hydrating || sending} onClick={() => void reload()}><RefreshCw size={14} /></button></div>
    {(nextConversations || listError) && <div className="conversation-pagination">{nextConversations && <button disabled={loadingConversations} onClick={() => void loadMoreConversations()}>{loadingConversations ? '读取中…' : '加载更多聊天'}</button>}{listError && <span role="alert">{listError}<button disabled={loadingConversations} onClick={() => nextConversations ? void loadMoreConversations() : setListRetry(value => value + 1)}>重试读取聊天列表</button></span>}</div>}
    {conversationId && <section className="chat-recovery" aria-label="待处理请求"><header><strong>待处理请求</strong><span>第 {recovery.previous.length + 1} 页</span><button disabled={loadingRecovery || hydrating} onClick={() => void readRecovery(conversationId, gate.current.capture())}>刷新待处理请求</button></header>
      <p>仅显示本页事项。可翻页查找更早请求，或回到最新页查看变化；查看详情不会重新办理。</p>
      {recoveryError && <p role="alert">{recoveryError}</p>}
      <div className="chat-recovery-items">{!recovery.items.length && !loadingRecovery && <p>本页没有待处理请求。可回到最新页刷新，或查看聊天消息。</p>}
      {recovery.items.map(item => {
        const view = recoveryItemView(item);
        return <article className="chat-command" key={item.commandId} data-command-id={item.commandId}><div><strong>请求 · 第 {item.revision} 版</strong><span>{view.title}</span></div><p>{item.messagePreview}</p>
          {item.clarification && <p>{item.clarification.question}</p>}
          <button disabled={blocked} onClick={() => void commandAction(item.commandId, false)}>查看请求状态</button>
          {view.canRetry && <button disabled={blocked} onClick={() => void commandAction(item.commandId, true)}>{item.status === 'pending' ? '继续原请求' : '重试原请求'}</button>}
          {item.clarification && <><button disabled={blocked} onClick={() => void commandAction(item.commandId, false, true)}>继续补充此请求</button><button disabled={blocked} onClick={() => void cancelClarification({ ...item.clarification!, parentCommandId: item.commandId })}>取消这次请求</button></>}
        </article>;
      })}</div><footer><button disabled={loadingRecovery || !recovery.previous.length} onClick={() => void readRecovery(conversationId, gate.current.capture(), 'previous')}>上一页待处理请求</button><button disabled={loadingRecovery || recovery.nextCursor === undefined} onClick={() => void readRecovery(conversationId, gate.current.capture(), 'next')}>下一页待处理请求</button>{recovery.cursor !== undefined && <button disabled={loadingRecovery} onClick={() => void readRecovery(conversationId, gate.current.capture(), 'first')}>回到最新待处理请求</button>}{loadingRecovery && <span role="status">正在读取待处理请求…</span>}</footer>
    </section>}
    <ThreadPrimitive.Root className="thread-root"><ThreadPrimitive.Viewport className="thread-viewport" autoScroll turnAnchor="bottom">
      {before !== undefined && <button className="chat-history-button" disabled={hydrating || sending || loadingEarlier} onClick={() => void reload(true)}>{loadingEarlier ? '读取中…' : '加载更早消息'}</button>}
      {!messages.length && !hydrating && <div className="chat-introduction">你好，我是 BankPilot。描述你要办理的事情，授权前请核对收款人、金额与风险等级。聊天历史会保存在当前账号。</div>}
      <ThreadPrimitive.Messages>{({ message }) => <MessagePrimitive.Root className={`chat-message chat-message-${message.role}`}>
        {message.role !== 'user' && <div className="message-avatar"><Sparkles size={14} /></div>}
        <div className="message-content"><MessagePrimitive.Parts /><span className="message-time">{message.createdAt ? time(message.createdAt.toString()) : ''}</span></div>
        {message.role === 'user' && <div className="message-user-avatar">我</div>}
      </MessagePrimitive.Root>}</ThreadPrimitive.Messages>
      {hydrating && <div role="status" className="planning-indicator">正在恢复服务端聊天历史…</div>}
      {error && <div role="alert" className="chat-error">{error}</div>}
      {pending && <div className="chat-command"><strong>这条消息的保存状态待确认</strong><p>{pending.body.text}</p><span>重试会使用同一个消息标识，避免重复创建请求。</span><button disabled={hydrating || sending} onClick={() => void submit(pending)}>重试同一消息</button></div>}
      {selectedCommandId.current && <button className="chat-history-button" disabled={blocked} onClick={() => void showLatestRequest()}>查看最新请求</button>}
      {timelineCommands.map(command => {
        const view = conversationCommandView(command);
        return <div key={command.commandId} className="chat-command"><div><strong>请求 · 第 {command.revision} 版</strong><span>{view.title}</span></div>
          {view.message && <p role="status">{view.message}</p>}
          {view.canViewPlan && <button disabled={blocked} onClick={() => void commandAction(command, false)}>查看计划 · 刷新动作状态</button>}
          {view.canRetry && <button disabled={blocked} onClick={() => void commandAction(command, true)}>{command.status === 'pending' ? '继续原请求' : '重试原请求'}</button>}
          {command.result?.subscriptionContinuation && <div className="chat-clarification" aria-label="订阅原请求续办">
            <strong>原请求续办 · {command.result.subscriptionContinuation.taskCount} 项</strong>
            <p>{({ WAITING_QUERY: '等待查询确认。确认查询后会按原请求继续规划；取消和银行拦截仍需分别确认。', PLANNING: '查询已获授权，正在核对原请求。规划中暂不能停止；生成候选后可逐项取消。', WRITE_PREPARED: '原请求已核对。请查看续办计划，逐项确认需要办理的操作。', NEEDS_QUERY_REAUTH: '查询授权已失效，原请求仍保留。重新准备查询后仍需本人确认。', FAILED_RECOVERABLE: '续办未完成，可以继续同一请求，不会新建另一条用户消息。', NEEDS_CLARIFICATION: '尚未完整核对所有事项，没有生成部分办理结果。请完整重述请求。', UNSUPPORTED: '原请求包含当前不支持的事项，请完整重述。', STOPPED: '已停止等待或重试续办；已准备的动作仍需单独取消。' } as Record<string,string>)[command.result.subscriptionContinuation.state] ?? '正在核对续办状态。'}</p>
            {command.result.subscriptionContinuation.state === 'FAILED_RECOVERABLE' && <button disabled={blocked} onClick={() => void subscriptionAction(command.commandId, 'resume')}>继续原订阅请求</button>}
            {command.result.subscriptionContinuation.state === 'NEEDS_QUERY_REAUTH' && <button disabled={blocked} onClick={() => void subscriptionAction(command.commandId, 'requery')}>重新准备查询确认</button>}
            {['WAITING_QUERY','NEEDS_QUERY_REAUTH','FAILED_RECOVERABLE'].includes(command.result.subscriptionContinuation.state) && <button disabled={blocked} onClick={() => void subscriptionAction(command.commandId, 'stop')}>停止续办此请求</button>}
            {command.result.subscriptionContinuation.successorCommandId && <button disabled={blocked} onClick={() => void commandAction(command.result!.subscriptionContinuation!.successorCommandId!, false)}>查看续办计划</button>}
          </div>}
          {view.needsRestatement && <small>此问题暂不支持逐项补充，请以新请求完整重述。</small>}
        </div>;
      })}
      {clarifications.filter(item => item.status === 'waiting' && messageCommandIds.has(item.parentCommandId) && !recoveryIds.has(item.parentCommandId)).map(item => <div className="chat-clarification" key={item.id}><strong>待补充 · 第 {commands.find(command => command.commandId === item.parentCommandId)?.revision ?? 1} 版请求</strong><p>{item.question}</p><button disabled={blocked} onClick={() => void commandAction(item.parentCommandId, false, true)}>继续补充此请求</button><button disabled={blocked} onClick={() => void cancelClarification(item)}>取消这次请求</button></div>)}
      {(running || sending) && <div role="status" className="planning-indicator"><span className="thinking-dots"><i /><i /><i /></span><span>{sending ? '正在保存请求' : '请求已保存，服务端正在规划；可刷新或稍后返回。'}</span></div>}
      <ThreadPrimitive.ViewportFooter className="thread-footer">
        <div className="chat-request-mode"><strong>{continuation ? '继续补充选中的请求' : '新请求'}</strong>{continuation ? <button disabled={blocked} onClick={() => { setContinuation(undefined); setAnswer({}); }}>改为新请求</button> : <span>不会自动补充之前的问题</span>}</div>
        {continuation && <div className="clarification-form"><p>{continuation.question}</p>
          {continuation.requestedSlots.includes('payee') && <label>选择收款账户<select aria-label="补充收款账户" disabled={blocked} value={answer.payeeId ?? ''} onChange={event => setAnswer(current => ({ ...current, payeeId: event.target.value || undefined }))}><option value="">请选择明确的收款账户</option>{continuation.candidates.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.bank} · {candidate.maskedNumber}</option>)}</select></label>}
          {continuation.requestedSlots.includes('amount') && <label>金额（带单位）<input aria-label="补充金额" disabled={blocked} value={answer.amount ?? ''} placeholder="例如：600元" onChange={event => setAnswer(current => ({ ...current, amount: event.target.value }))} /></label>}
          {continuation.requestedSlots.includes('targetDate') && <label>目标日期<input aria-label="补充目标日期" disabled={blocked} value={answer.targetDate ?? ''} placeholder="例如：2027年2月15日" onChange={event => setAnswer(current => ({ ...current, targetDate: event.target.value }))} /></label>}
          <button disabled={blocked || !typedReady} onClick={() => { if (!conversationId || !typedReady) return; const candidate = continuation.candidates.find(item => item.id === answer.payeeId); const suffix = candidate?.maskedNumber.match(/(\d{4})$/)?.[1]; const values = { ...answer, ...(suffix ? { payeeSuffix: suffix } : {}) }; const text = [suffix && `尾号${suffix}`, answer.amount, answer.targetDate].filter(Boolean).join('，'); void submit(createSubmission(conversationId, text, continuation, values)); }}>提交补充</button>
        </div>}
        {!continuation && <><div className="suggestion-row"><span className="suggestion-label">试试这个：</span><button onClick={() => void send('给林晓转600元')} disabled={blocked}><Sparkles size={13} />给林晓转600元</button><button onClick={() => void send('查本月账单，给林晓转600元，不影响房租和生活费')} disabled={blocked}><Sparkles size={13} />账单联动与资金保护</button></div>
        <ComposerPrimitive.Root className="composer-root"><ComposerPrimitive.Input className="composer-input" placeholder="例如：给林晓转600元" aria-label="描述转账需求" submitMode="ctrlEnter" /><div className="composer-bottom"><span><LockKeyhole size={13} />所有交易都需要本人授权</span><ComposerPrimitive.Send className="composer-send" aria-label="发送请求"><Send size={16} /><span>发送</span></ComposerPrimitive.Send></div></ComposerPrimitive.Root><div className="composer-caption">Enter 换行 · Ctrl / ⌘ + Enter 发送 · 仅处理合成数据</div></>}
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport></ThreadPrimitive.Root>
  </div></AssistantRuntimeProvider>;
}
