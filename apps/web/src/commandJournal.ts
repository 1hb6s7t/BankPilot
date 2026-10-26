export type CommandInput = { commandId: string };
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function canonicalCommand(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCommand).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalCommand(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Retain a preparation request before transport; identity is scoped to the signed-in owner and this tab. */
export class CommandJournal<I extends CommandInput> {
  readonly key: string;
  constructor(private storage: JournalStorage, owner: string, slot: string) {
    this.key = `bankpilot:command-recovery:v1:${encodeURIComponent(owner)}:${encodeURIComponent(slot)}`;
  }
  read(): I | undefined {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('commandId' in value) || typeof value.commandId !== 'string' || value.commandId.length < 8) throw new Error('原请求记录无法读取，请保留此页面并检查浏览器存储。');
    return value as I;
  }
  prepare(draft: Omit<I, 'commandId'>, makeId: () => string = () => crypto.randomUUID()): { input: I; existing: boolean } {
    const pending = this.read();
    if (pending) {
      const { commandId: _id, ...original } = pending;
      if (canonicalCommand(original) !== canonicalCommand(draft)) throw new Error('上一笔请求的结果尚未核实。请先查询原请求，或按原内容重试，再提交新的内容。');
      return { input: pending, existing: true };
    }
    const input = { ...draft, commandId: makeId() } as I;
    this.storage.removeItem(`${this.key}:first-rejection`);
    this.storage.setItem(this.key, JSON.stringify(input));
    // A storage adapter that silently discards writes must not allow an untracked POST.
    if (canonicalCommand(this.read()) !== canonicalCommand(input)) throw new Error('无法保存原请求编号，暂未提交。请检查浏览器存储。');
    return { input, existing: false };
  }
  resolve(commandId: string): void {
    if (this.read()?.commandId === commandId) {
      this.storage.removeItem(this.key);
      this.storage.removeItem(`${this.key}:first-rejection`);
    }
  }

}

let owner: string | undefined;
let generation = 0;
export function setCommandRecoveryOwner(value?: string): void {
  if (owner !== value) { owner = value; generation += 1; }
}
export function commandRecoverySession() { return { owner, generation }; }
export function isCommandRecoverySession(ticket: ReturnType<typeof commandRecoverySession>): boolean {
  return ticket.owner !== undefined && owner === ticket.owner && generation === ticket.generation;
}
