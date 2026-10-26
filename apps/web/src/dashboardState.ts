import type { ActionView, Dashboard } from '../../../packages/contracts/src';

/** Same-session readers share one request; a newer observation requires a read begun after it. */
export class DashboardReadCoordinator<T> {
  private epoch = 0;
  private freshness = 0;
  private flight?: { epoch: number; promise: Promise<T | undefined> };

  invalidate(): void {
    this.epoch += 1;
    this.freshness = 0;
    this.flight = undefined;
  }

  markStale(): void { this.freshness += 1; }

  read(load: () => Promise<T>, apply: (value: T) => void, requireFresh = false): Promise<T | undefined> {
    if (requireFresh) this.markStale();
    if (this.flight) return this.flight.promise;
    const entry = { epoch: this.epoch, promise: undefined as unknown as Promise<T | undefined> };
    this.flight = entry;
    entry.promise = (async () => {
      try {
        while (entry.epoch === this.epoch) {
          const freshness = this.freshness;
          const value = await load();
          if (entry.epoch !== this.epoch) return undefined;
          // A detail response or successful write made a read begun earlier insufficient.
          if (freshness !== this.freshness) continue;
          apply(value);
          if (freshness === this.freshness) return value;
        }
        return undefined;
      } finally {
        if (this.flight === entry) this.flight = undefined;
      }
    })();
    return entry.promise;
  }
}

const terminal = new Set<ActionView['status']>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED']);
/** An action receipt cannot also certify the balances in a separate, older dashboard snapshot. */
export function dashboardRefreshKeys(snapshot: Pick<Dashboard, 'actions'> | undefined, details: ActionView[]): string[] {
  const actions = new Map(snapshot?.actions.map(action => [action.id, action]));
  return details.filter(action => {
    if (!terminal.has(action.status)) return false;
    const known = actions.get(action.id);
    return !known || known.status !== action.status || known.updatedAt < action.updatedAt;
  }).map(action => JSON.stringify([action.id, action.actionVersion, action.status, action.updatedAt]));
}

export function dashboardRequiresPolling(snapshot: Pick<Dashboard, 'actions'> | undefined, needsFreshSnapshot = false): boolean {
  return needsFreshSnapshot || Boolean(snapshot?.actions.some(action => ['UNKNOWN', 'SUBMITTING', 'AUTHORIZED'].includes(action.status)));
}

/** Display a fresh detail receipt without modifying the canonical account snapshot underneath it. */
export function dashboardActionViews(snapshot: Pick<Dashboard, 'actions'> | undefined, details: ActionView[]): ActionView[] {
  const actions = new Map(snapshot?.actions.map(action => [action.id, action]));
  for (const detail of details) {
    const known = actions.get(detail.id);
    if (!known || (terminal.has(detail.status) && !terminal.has(known.status))
      || ((!terminal.has(known.status) || terminal.has(detail.status)) && detail.updatedAt > known.updatedAt)) actions.set(detail.id, detail);
  }
  return [...actions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
