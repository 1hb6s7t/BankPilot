import { useEffect, useRef, useState } from 'react';
import { CommandJournal, commandRecoverySession, isCommandRecoverySession, type CommandInput } from './commandJournal';
import { api } from './api';
import type { PreparationFamily } from '../../../packages/contracts/src/preparations';
export { setCommandRecoveryOwner } from './commandJournal';

type Options<I, R> = { slot: string; family: PreparationFamily; send: (input: I) => Promise<R>; lookup: (commandId: string) => Promise<R>; onResolved: (result: R) => void };
const message = (error: unknown) => error instanceof Error ? error.message : '原请求结果暂时无法读取。';
const commandAbsent = (error: unknown) => error && typeof error === 'object' && 'status' in error && error.status === 404 && 'code' in error && error.code === 'COMMAND_NOT_FOUND';

/** Only preparation commands use this journal. Confirmation and Passkey assertions are never replayed here. */
export function useCommandRecovery<I extends CommandInput, R>(options: Options<I, R>) {
  const latest = useRef(options); latest.current = options;
  const ticket = useRef(commandRecoverySession());
  const epoch = useRef(0), mounted = useRef(false), locked = useRef(false);
  const journal = useRef<CommandJournal<I> | undefined>(undefined);
  const [pending, setPending] = useState<I>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  function current(version: number) { return mounted.current && version === epoch.current && isCommandRecoverySession(ticket.current); }
  function store() {
    if (!isCommandRecoverySession(ticket.current)) throw new Error('登录状态已变化，请重新进入当前账户。');
    return journal.current ??= new CommandJournal<I>(window.sessionStorage, ticket.current.owner!, options.slot);
  }
  function resolved(input: I, result: R, version: number, recovered: boolean) {
    if (!current(version)) return;
    store().resolve(input.commandId); setPending(undefined);
    setNotice(recovered ? '已找到原请求的服务端记录，当前显示其最新状态。后续动作仍需单独核对与授权。' : undefined);
    latest.current.onResolved(result);
  }
  function stopped(input: I, version: number) {
    if (!current(version)) return;
    store().resolve(input.commandId); setPending(undefined);
    setNotice('服务端已停止准备原请求。此编号后续到达的准备请求也不会生成候选；你可以重新填写新的请求。');
  }
  async function lookup(input: I, version: number): Promise<'found' | 'not-found' | 'rejected' | 'unavailable'> {
    try {
      const result = await latest.current.lookup(input.commandId);
      if (!current(version)) return 'unavailable';
      resolved(input, result, version, true); return 'found';
    } catch (reason) {
      if (!current(version)) return 'unavailable';
      try {
        const record = await api.preparationRequest(options.family, input.commandId);
        if (!current(version)) return 'unavailable';
        if (record.state === 'ABANDONED') { stopped(input, version); return 'rejected'; }
        if (record.state === 'PREPARED') {
          setNotice('原结果已在服务端生成，但详情暂时无法读取，已保留原编号和内容。请再次查询原结果；停止准备不会撤销已生成的动作。');
          return 'unavailable';
        }
        setNotice('服务端已记录原请求，当前尚未读到候选结果，已保留原编号和内容。可按原内容重试，或明确停止准备。');
        return 'not-found';
      } catch { if (!current(version)) return 'unavailable'; }
      setNotice(commandAbsent(reason)
        ? '暂未找到原请求记录，仍保留原编号。可以再次查询，或按原内容重试；不会自动提交。'
        : '原请求查单暂不可用，已保留原编号和内容。恢复连接后请再次查询。');
      return commandAbsent(reason) ? 'not-found' : 'unavailable';
    }
  }
  async function write(input: I, version: number): Promise<R | undefined> {
    try {
      const result = await latest.current.send(input);
      if (!current(version)) return undefined;
      resolved(input, result, version, false); return result;
    } catch (reason) {
      if (!current(version)) return undefined;
      setError(message(reason));
      // A preparation rejection does not cancel the durable accepted request.
      // Only a current original result or a server ABANDONED tombstone releases it.
      await lookup(input, version);
      throw reason;
    }
  }
  async function execute(draft: Omit<I, 'commandId'>): Promise<R | undefined> {
    if (locked.current || !mounted.current) return undefined;
    locked.current = true; const version = epoch.current; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const saved = store().prepare(draft); setPending(saved.input);
      return await write(saved.input, version);
    } catch (reason) { if (current(version)) setError(message(reason)); throw reason; }
    finally { if (current(version)) { locked.current = false; setBusy(false); } }
  }
  async function recover(): Promise<void> {
    if (locked.current || !mounted.current) return;
    locked.current = true; const version = epoch.current; setBusy(true);
    try { const input = store().read(); if (input) { setPending(input); await lookup(input, version); } }
    catch (reason) { if (current(version)) setError(message(reason)); }
    finally { if (current(version)) { locked.current = false; setBusy(false); } }
  }
  async function retry(): Promise<void> {
    if (locked.current || !mounted.current) return;
    locked.current = true; const version = epoch.current; setBusy(true); setError(undefined); setNotice(undefined);
    try { const input = store().read(); if (input) await write(input, version); }
    catch (reason) { if (current(version)) setError(message(reason)); }
    finally { if (current(version)) { locked.current = false; setBusy(false); } }
  }
  async function stop(): Promise<void> {
    if (locked.current || !mounted.current) return;
    locked.current = true; const version = epoch.current; setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const input = store().read(); if (!input) return;
      try {
        const record = await api.abandonPreparation(options.family, input.commandId);
        if (!current(version)) return;
        if (record.state === 'ABANDONED') stopped(input, version);
        else {
          setNotice('服务端已生成原结果，不能通过停止准备来撤销。正在查询原结果，请在对应确认卡中单独处理。');
          await lookup(input, version);
        }
      } catch (reason) {
        if (!current(version)) return;
        setError(message(reason));
        // A lost stop response is resolved by reads, never a second automatic POST.
        await lookup(input, version);
      }
    } catch (reason) { if (current(version)) setError(message(reason)); }
    finally { if (current(version)) { locked.current = false; setBusy(false); } }
  }
  useEffect(() => {
    mounted.current = true; locked.current = false; epoch.current += 1;
    void recover();
    return () => { mounted.current = false; epoch.current += 1; locked.current = false; };
    // Slots and owner are fixed for this mounted business page; callbacks are read from latest.
  }, []);
  return { pending, busy, error, notice, execute, recover, retry, stop };
}

type RecoveryNoticeProps = { recovery: { pending?: CommandInput; busy: boolean; error?: string; notice?: string; recover(): Promise<void>; retry(): Promise<void>; stop(): Promise<void> } };
export function commandSummary(input: CommandInput): string[] {
  const value = input as CommandInput & Record<string, unknown>;
  const spec = value.spec && typeof value.spec === 'object' ? value.spec as Record<string, unknown> : value;
  const kinds: Record<string, string> = { CONTACT_ALIAS_SAVE: '保存联系人称呼', CARD_REPORT_LOST: '卡片挂失', CARD_UNREPORT_LOST: '解除卡片挂失', SUBSCRIPTION_QUERY: '查询订阅', SUBSCRIPTION_CANCEL: '取消商户订阅', SUBSCRIPTION_BLOCK: '银行拦截订阅扣款' };
  const lines: string[] = [];
  if (typeof spec.kind === 'string') lines.push(`操作：${kinds[spec.kind] ?? spec.kind}`);
  for (const [key, label] of Object.entries({ title: '目标名称', alias: '新增称呼', targetDate: '目标完成日期', goalId: '原目标编号', payeeId: '收款人编号', accountId: '账户编号', cardId: '卡片编号', subscriptionId: '订阅编号', positionId: '持仓编号' })) {
    if (typeof spec[key] === 'string') lines.push(`${label}：${spec[key]}`);
  }
  if (typeof value.expectedPlanVersion === 'number') lines.push(`原目标计划版本：${value.expectedPlanVersion}`);
  if (typeof spec.expectedVersion === 'number') lines.push(`提交时的数据版本：${spec.expectedVersion}`);
  const amount = (minor: unknown) => typeof minor === 'string' && /^\d+$/.test(minor) ? `${BigInt(minor) / 100n}.${(BigInt(minor) % 100n).toString().padStart(2, '0')} 元` : undefined;
  const valueAmount = amount(spec.amountMinor); if (valueAmount) lines.push(`金额：${valueAmount}`);
  if (spec.funding && typeof spec.funding === 'object') {
    const funding = spec.funding as Record<string, unknown>, fundingAmount = amount(funding.redemptionAmountMinor);
    if (typeof funding.positionId === 'string') lines.push(`资金来源持仓：${funding.positionId}`);
    if (fundingAmount) lines.push(`计划赎回：${fundingAmount}`);
  }
  return lines;
}
export function CommandRecoveryNotice({ recovery }: RecoveryNoticeProps) {
  if (!recovery.pending && !recovery.error && !recovery.notice) return null;
  return <div className="notice notice-info command-recovery" role="region" aria-label="原请求恢复">
    {recovery.pending && <p>有一笔请求需要核实处理结果。请求编号：<code>{recovery.pending.commandId}</code></p>}
    {recovery.pending && <details><summary>核对原请求内容</summary><ul>{commandSummary(recovery.pending).map(line => <li key={line} style={{ overflowWrap: 'anywhere' }}>{line}</li>)}</ul></details>}
    {recovery.error && <p role="alert">{recovery.error}</p>}
    {recovery.notice && <p role="status">{recovery.notice}</p>}
    {recovery.pending && <><div><button type="button" className="button button-outline" disabled={recovery.busy} onClick={() => void recovery.recover()}>查询原请求</button>{' '}<button type="button" className="button button-outline" disabled={recovery.busy} onClick={() => void recovery.retry()}>按原内容重试</button>{' '}<button type="button" className="button button-outline" disabled={recovery.busy} onClick={() => void recovery.stop()}>停止准备原请求</button></div><p>停止准备仅在尚未生成候选时生效；已生成动作需在确认卡中单独取消。</p></>}
  </div>;
}
