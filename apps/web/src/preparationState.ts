import type { PreparationRequest } from '../../../packages/contracts/src/preparations';

type PreparationObservation = { request: PreparationRequest; requiresRead: boolean };

/** Preparing a result and stopping preparation are irreversible, mutually exclusive outcomes. */
export function mergePreparationRequest(current: PreparationRequest, incoming: PreparationRequest): PreparationObservation {
  if (current.family !== incoming.family || current.commandId !== incoming.commandId) return { request: current, requiresRead: true };
  if (current.state !== 'PENDING') {
    if (incoming.state === 'PENDING') return { request: current, requiresRead: false };
    if (incoming.state !== current.state || (current.resultId && incoming.resultId && current.resultId !== incoming.resultId)) return { request: current, requiresRead: true };
  }
  if (current.state === 'PENDING' && incoming.state !== 'PENDING') return { request: incoming, requiresRead: false };
  const latest = incoming.updatedAt > current.updatedAt ? incoming : current;
  // A result lookup may add its ID without changing the registry timestamp.
  const resultId = current.resultId ?? incoming.resultId;
  return { request: resultId && !latest.resultId ? { ...latest, resultId } : latest, requiresRead: false };
}
