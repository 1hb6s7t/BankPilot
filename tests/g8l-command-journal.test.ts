import { describe, expect, it } from 'vitest';
import { CommandJournal, commandRecoverySession, isCommandRecoverySession, setCommandRecoveryOwner, type JournalStorage } from '../apps/web/src/commandJournal';

function storage(): JournalStorage {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}
type Input = { commandId: string; spec: { kind: string; amount: string; expectedVersion: number } };
const draft = { spec: { kind: 'PREPARE', amount: '30000', expectedVersion: 1 } };

describe('durable preparation identity', () => {
  it('persists before transport and restores the exact payload across remounts', () => {
    const backing = storage(), first = new CommandJournal<Input>(backing, 'alice', 'preparation');
    const saved = first.prepare(draft, () => 'original-command');
    expect(saved.existing).toBe(false);
    const remount = new CommandJournal<Input>(backing, 'alice', 'preparation');
    expect(remount.read()).toEqual(saved.input);
    expect(remount.prepare(draft, () => { throw new Error('must not allocate'); })).toEqual({ input: saved.input, existing: true });
  });
  it('refuses changed contents while the original result is unknown', () => {
    const journal = new CommandJournal<Input>(storage(), 'alice', 'preparation');
    const original = journal.prepare(draft, () => 'original-command').input;
    expect(() => journal.prepare({ spec: { ...draft.spec, amount: '40000' } })).toThrow('上一笔请求');
    expect(journal.read()).toEqual(original);
  });
  it('compares semantic object keys independently of insertion order', () => {
    const journal = new CommandJournal<Input>(storage(), 'alice', 'preparation');
    journal.prepare(draft, () => 'original-command');
    expect(journal.prepare({ spec: { expectedVersion: 1, amount: '30000', kind: 'PREPARE' } }).existing).toBe(true);
  });
  it('isolates owner, slot, and ambiguous owner/slot concatenations', () => {
    const backing = storage(); new CommandJournal<Input>(backing, 'alice', 'preparation').prepare(draft, () => 'original-command');
    expect(new CommandJournal<Input>(backing, 'bob', 'preparation').read()).toBeUndefined();
    expect(new CommandJournal<Input>(backing, 'alice', 'other').read()).toBeUndefined();
    expect(new CommandJournal(backing, 'a:b', 'c').key).not.toBe(new CommandJournal(backing, 'a', 'b:c').key);
  });
  it('only clears the matching command, permitting a later explicit new request', () => {
    const journal = new CommandJournal<Input>(storage(), 'alice', 'preparation');
    journal.prepare(draft, () => 'original-command'); journal.resolve('wrong-command');
    expect(journal.read()?.commandId).toBe('original-command');
    journal.resolve('original-command'); expect(journal.read()).toBeUndefined();
    expect(journal.prepare(draft, () => 'new-command').input.commandId).toBe('new-command');
  });
  it('cleans obsolete local rejection metadata only when resolving the matching command', () => {
    const backing = storage(), journal = new CommandJournal<Input>(backing, 'alice', 'prepare');
    journal.prepare(draft, () => 'original-command');
    backing.setItem(`${journal.key}:first-rejection`, JSON.stringify({ commandId: 'original-command', status: 409 }));
    journal.resolve('wrong-command'); expect(backing.getItem(`${journal.key}:first-rejection`)).not.toBeNull();
    journal.resolve('original-command'); expect(backing.getItem(`${journal.key}:first-rejection`)).toBeNull();
  });
  it('fails closed on unavailable or silently discarded storage', () => {
    const unavailable: JournalStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(() => new CommandJournal<Input>(unavailable, 'alice', 'prepare').prepare(draft)).toThrow('quota');
    unavailable.setItem = () => {};
    expect(() => new CommandJournal<Input>(unavailable, 'alice', 'prepare').prepare(draft)).toThrow('无法保存');
  });
  it.each(['not json', 'null', '[]', '{}', '{"commandId":12}', '{"commandId":"short"}'])('does not discard corrupt recovery records: %s', raw => {
    const backing = storage(), journal = new CommandJournal<Input>(backing, 'alice', 'preparation');
    backing.setItem(journal.key, raw);
    expect(() => journal.prepare(draft)).toThrow(); expect(backing.getItem(journal.key)).toBe(raw);
  });
  it('rejects old continuation after logout and same-owner relogin', () => {
    setCommandRecoveryOwner('alice'); const original = commandRecoverySession();
    expect(isCommandRecoverySession(original)).toBe(true);
    setCommandRecoveryOwner(undefined); expect(isCommandRecoverySession(original)).toBe(false);
    setCommandRecoveryOwner('alice'); expect(isCommandRecoverySession(original)).toBe(false);
    setCommandRecoveryOwner('bob'); expect(isCommandRecoverySession(original)).toBe(false);
    setCommandRecoveryOwner(undefined);
  });
});
