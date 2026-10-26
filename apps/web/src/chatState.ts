import type { ChatMessage, Clarification, ClarificationAnswer, Conversation, ConversationCommand, ConversationMessageInput, ConversationRecoveryItem } from '../../../packages/contracts/src/conversations';
import type { PlanningFailure } from '../../../packages/contracts/src';

/** Keep the server's newest version of each command, within the active chat. */
export function mergeConversationCommands(conversationId: string, current: ConversationCommand[], incoming: ConversationCommand[], source: 'history' | 'detail' = 'detail'): ConversationCommand[] {
  const commands = new Map<string, ConversationCommand>();
  for (const command of [...current, ...incoming]) {
    if (command.conversationId !== conversationId) continue;
    const old = commands.get(command.commandId);
    const oldVersion = stateVersion(old), newVersion = stateVersion(command);
    if (!old || (oldVersion !== undefined ? newVersion !== undefined && newVersion >= oldVersion
      : newVersion !== undefined || command.updatedAt >= old.updatedAt)) {
      const sameState = old && (oldVersion !== undefined ? oldVersion === newVersion : old.updatedAt === command.updatedAt);
      const result = source === 'history' && old?.result && command.result
        ? sameState && old.status === command.status ? old.result : preserveTerminalActions(old.result, command.result) : command.result;
      commands.set(command.commandId, result === command.result ? command : { ...command, result });
    }
  }
  return [...commands.values()].sort((left, right) => {
    const a = requestSequence(left), b = requestSequence(right);
    return (a !== undefined && b !== undefined ? a - b : 0) || left.createdAt.localeCompare(right.createdAt)
      || left.revision - right.revision || left.commandId.localeCompare(right.commandId);
  });
}
function stateVersion(command?: Pick<ConversationCommand, 'stateVersion'>): bigint | undefined {
  const value = command?.stateVersion;
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined;
}
function requestSequence(command: ConversationCommand): number | undefined {
  const value = command.requestSequence;
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined;
}

/** A history envelope is a stored proposal, not a fresh Core read. Terminal action IDs are immutable. */
function preserveTerminalActions(current: NonNullable<ConversationCommand['result']>, incoming: NonNullable<ConversationCommand['result']>) {
  const result = { ...incoming };
  const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);
  for (const key of ['actions', 'managementActions', 'investmentActions'] as const) {
    if (!current[key] || !incoming[key]) continue;
    const byId = new Map(current[key].flatMap(value => value && typeof value === 'object' && 'id' in value && 'status' in value
      && typeof value.id === 'string' && typeof value.status === 'string' && terminal.has(value.status) ? [[value.id, value] as const] : []));
    result[key] = incoming[key].map(value => value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
      ? byId.get(value.id) ?? value : value);
  }
  return result;
}

/** History pages may have been read before a newer poll changed the chat title/version. */
export function mergeConversationSummary(current: Conversation, incoming: Conversation): Conversation {
  if (current.id !== incoming.id || incoming.version < current.version
    || (incoming.version === current.version && incoming.updatedAt < current.updatedAt)) return current;
  return incoming;
}

/** The list cursor uses immutable creation order, independently of title/activity updates. */
export function mergeConversationList(current: Conversation[], incoming: Conversation[]): Conversation[] {
  const byId = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) byId.set(item.id, byId.has(item.id) ? mergeConversationSummary(byId.get(item.id)!, item) : item);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Restore a selected old chat with one exact lookup, never by walking the entire list. */
export async function restoreConversationSelection(initial: Conversation[], selectedId: string | null, read: (id: string) => Promise<Conversation | undefined>) {
  const selected = initial.find(item => item.id === selectedId) ?? (selectedId ? await read(selectedId) : undefined);
  if (selected && selectedId && selected.id !== selectedId) throw new Error('恢复的聊天与所选聊天不一致，请重试。');
  const conversations = mergeConversationList(initial, selected ? [selected] : []);
  return { conversations, selected: selected ?? conversations[0] };
}

export function mergeClarifications(conversationId: string, current: Clarification[], incoming: Clarification[]): Clarification[] {
  const byId = new Map<string, Clarification>();
  for (const item of [...current, ...incoming]) {
    if (item.conversationId !== conversationId) continue;
    const old = byId.get(item.id);
    if (!old || item.version > old.version || (item.version === old.version && old.status === 'waiting')) byId.set(item.id, item);
  }
  return [...byId.values()];
}

/** Successful clarification writes are evidence even if the following detail GET fails. */
export function withClarificationEvidence(conversationId: string, commands: ConversationCommand[], known: Clarification[]): ConversationCommand[] {
  const byParent = new Map(mergeClarifications(conversationId, commands.flatMap(command => command.clarification ? [command.clarification] : []), known)
    .map(item => [item.parentCommandId, item]));
  return commands.map(command => command.conversationId === conversationId && byParent.has(command.commandId)
    ? { ...command, clarification: byParent.get(command.commandId)! } : command);
}

export type RecoveryCursorState = { cursor?: string; previous: (string | undefined)[]; nextCursor?: string };
export function recoveryPageTarget(current: RecoveryCursorState, move: 'refresh' | 'first' | 'next' | 'previous') {
  if (move === 'first') return { cursor: undefined, previous: [] };
  if (move === 'next') return current.nextCursor === undefined ? undefined : { cursor: current.nextCursor, previous: [...current.previous, current.cursor] };
  if (move === 'previous') return !current.previous.length ? undefined : { cursor: current.previous.at(-1), previous: current.previous.slice(0, -1) };
  return { cursor: current.cursor, previous: [...current.previous] };
}

/** An index page is only membership for that page; newer exact-command evidence can remove stale rows. */
export function recoveryItemsForPage(conversationId: string, items: ConversationRecoveryItem[], known: ConversationCommand[], clarifications: Clarification[] = []): ConversationRecoveryItem[] {
  const commands = new Map(mergeConversationCommands(conversationId, [], withClarificationEvidence(conversationId, known, clarifications)).map(item => [item.commandId, item]));
  const knownClarifications = new Map(mergeClarifications(conversationId, [], clarifications).map(item => [item.id, item]));
  const byId = new Map<string, ConversationRecoveryItem>();
  for (const item of items) {
    if (item.conversationId !== conversationId) continue;
    const knownClarification = item.clarification && knownClarifications.get(item.clarification.id);
    if (knownClarification && knownClarification.version >= item.clarification!.version && knownClarification.status !== 'waiting') continue;
    const command = commands.get(item.commandId);
    if (item.clarification && command?.clarification?.id === item.clarification.id
      && command.clarification.version >= item.clarification.version && command.clarification.status !== 'waiting') continue;
    const knownVersion = stateVersion(command), indexVersion = stateVersion(item);
    const newer = command && (knownVersion !== undefined ? indexVersion === undefined || knownVersion >= indexVersion : command.updatedAt >= item.updatedAt);
    if (newer) {
      const waiting = command.clarification?.status === 'waiting';
      if (command.status === 'complete' && !waiting) continue;
      byId.set(item.commandId, { ...item, status: command.status, retryable: command.retryable, leaseExpiresAt: command.leaseExpiresAt,
        stateVersion: command.stateVersion ?? item.stateVersion, updatedAt: command.updatedAt,
        clarification: waiting ? { id: command.clarification!.id, version: command.clarification!.version, question: command.clarification!.question } : undefined });
    } else byId.set(item.commandId, item);
  }
  return [...byId.values()];
}

export function recoveryItemView(item: ConversationRecoveryItem, now = Date.now()) {
  const expired = item.status === 'running' && Boolean(item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= now);
  return { title: item.clarification ? '等待补充信息' : item.status === 'failed' ? '请求尚未完成' : expired ? '处理已超时' : '服务端处理中',
    canRetry: !item.clarification && item.retryable && (item.status === 'pending' || item.status === 'failed' || expired) };
}

/** The newest request owns the pane, even while pending or after a failure. */
export function conversationView(conversationId: string, commands: ConversationCommand[], saving = false, selectedCommandId?: string, latestCommandId?: string) {
  const ordered = mergeConversationCommands(conversationId, [], commands);
  const target = selectedCommandId ?? latestCommandId;
  const command = target === undefined ? ordered.at(-1) : ordered.find(item => item.commandId === target);
  const terminal = command && (command.status === 'failed' || command.status === 'complete');
  const failure = !saving && terminal ? command.failure ?? command.result?.failure : undefined;
  return { command, failure, result: !saving && command?.status === 'complete' && !failure ? command.result : undefined };
}

export function planningFailureView(failure: PlanningFailure) {
  return { title: failure.phase === 'planning' ? '规划尚未完成' : '识别尚未完成', message: failure.message, retryable: failure.retryable };
}

export function conversationCommandView(command: ConversationCommand, now = Date.now()) {
  const terminal = command.status === 'failed' || command.status === 'complete';
  const failure = terminal ? command.failure ?? command.result?.failure : undefined;
  const expired = command.status === 'running' && Boolean(command.leaseExpiresAt && Date.parse(command.leaseExpiresAt) <= now);
  const clarification = !failure && command.status === 'complete'
    && (command.clarification ? command.clarification.status === 'waiting' : Boolean(command.result?.clarification));
  return {
    title: failure ? planningFailureView(failure).title : command.status === 'failed' ? '请求尚未完成'
      : clarification ? '等待补充信息' : command.status === 'complete' ? '规划已完成' : expired ? '处理已超时' : '服务端处理中',
    message: failure?.message ?? (command.status === 'failed' ? '这次请求尚未完成，请刷新状态后再继续。' : undefined),
    canRetry: Boolean((command.status === 'pending' || command.status === 'failed' || expired) && command.retryable && (!failure || failure.retryable)),
    canViewPlan: command.status === 'complete' && !failure && Boolean(command.result),
    needsRestatement: clarification && !command.clarification,
  };
}

export type GenerationTicket = { readonly generation: number; readonly signal: AbortSignal };
/** Rejects late results even when a transport ignores AbortSignal. */
export class GenerationGate {
  private generation = 0;
  private controller = new AbortController();
  capture(): GenerationTicket { return { generation: this.generation, signal: this.controller.signal }; }
  isCurrent(ticket: GenerationTicket): boolean { return ticket.generation === this.generation && ticket.signal === this.controller.signal && !ticket.signal.aborted; }
  renew(): GenerationTicket {
    this.controller.abort();
    this.generation += 1;
    this.controller = new AbortController();
    return this.capture();
  }
  abort(): void { this.controller.abort(); }
}

/** Only server messages enter the timeline; pagination never duplicates or rewrites a row. */
export function mergeMessages(conversationId: string, current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const messages = new Map<string, ChatMessage>();
  for (const message of [...current, ...incoming]) {
    if (message.conversationId === conversationId && !messages.has(message.id)) messages.set(message.id, message);
  }
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

/** Messages are immutable and numbered consecutively from one by the server transaction. */
export function mergeHistoryMessages(conversationId: string, current: ChatMessage[], incoming: ChatMessage[], earlier = false) {
  const messages = mergeMessages(conversationId, current, incoming);
  let beforeSequence: number | undefined;
  // A latest-page refresh can leave a gap between cached and new messages; fill it first.
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i]!.sequence > messages[i - 1]!.sequence + 1) { beforeSequence = messages[i]!.sequence; break; }
  }
  if (beforeSequence === undefined && messages[0] && messages[0].sequence > 1) beforeSequence = messages[0].sequence;
  if (earlier && beforeSequence !== undefined && messages.length === current.filter(message => message.conversationId === conversationId).length)
    throw new Error('这页聊天历史尚未读全，请重试加载更早消息。');
  return { messages, beforeSequence };
}

export type PendingSubmission = { readonly conversationId: string; readonly body: ConversationMessageInput };
/** Construct once at user submit; all uncertain retries reuse this exact frozen payload. */
export function createSubmission(conversationId: string, text: string, clarification?: Clarification, answer?: ClarificationAnswer, id: string = crypto.randomUUID()): PendingSubmission {
  const normalized = text.trim();
  if (!normalized) throw new Error('请输入请求内容。');
  if (clarification && clarification.status !== 'waiting') throw new Error('该澄清已结束，请刷新历史。');
  const body: ConversationMessageInput = {
    clientMessageId: id, text: normalized,
    ...(clarification ? { clarificationId: clarification.id, expectedClarificationVersion: clarification.version, answer: Object.freeze({ ...answer }) } : {}),
  };
  return Object.freeze({ conversationId, body: Object.freeze(body) });
}

export function hasAcceptedSubmission(messages: ChatMessage[], pending: PendingSubmission): boolean {
  return messages.some(message => message.conversationId === pending.conversationId && message.role === 'user' && message.clientMessageId === pending.body.clientMessageId);
}

const LOGOUT_INTENT_KEY = 'bankpilot:logout-pending';
type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** A non-sensitive intent flag prevents navigation from restoring a session mid sign-out. */
export class LogoutIntent {
  private pending = false;
  private readonly storage?: IntentStorage;
  constructor(storage?: IntentStorage) {
    try { this.storage = storage ?? globalThis.sessionStorage; } catch { /* Private-mode storage can be unavailable. */ }
  }
  isPending(): boolean {
    try { return this.pending || this.storage?.getItem(LOGOUT_INTENT_KEY) === '1'; } catch { return this.pending; }
  }
  begin(): void {
    this.pending = true;
    try { this.storage?.setItem(LOGOUT_INTENT_KEY, '1'); } catch { /* In-memory protection still applies. */ }
  }
  complete(): void {
    this.pending = false;
    try { this.storage?.removeItem(LOGOUT_INTENT_KEY); } catch { /* A stale flag only causes another safe sign-out. */ }
  }
}
