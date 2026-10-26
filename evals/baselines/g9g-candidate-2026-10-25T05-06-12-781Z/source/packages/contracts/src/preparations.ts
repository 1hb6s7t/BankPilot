import type { Actor } from './index';
import type { ManagementAction } from './management';
import type { InvestmentAction } from './investment';
import type { GoalView } from './goals';

export type PreparationFamily = 'management' | 'investment' | 'goal';
export type PreparationOperation = 'management' | 'redemption' | 'goal-create' | 'goal-replan';
/** Exact validated input is retained for an explicit retry, never model output or a resource snapshot. */
export type PreparationRequest = {
  family: PreparationFamily; commandId: string; operation: PreparationOperation | null;
  input: Record<string, unknown> | null; state: 'PENDING' | 'PREPARED' | 'ABANDONED';
  createdAt: string; updatedAt: string; resultId?: string;
  lastError?: { code: string; message: string };
};
export type PreparationRequestPage = { requests: PreparationRequest[]; nextCursor?: string };
export type PreparationResult = { family: 'management'; result: ManagementAction }
  | { family: 'investment'; result: InvestmentAction } | { family: 'goal'; result: GoalView };
export type PreparationService = {
  migrate(): Promise<void>; assertReady(): Promise<void>;
  accept(actor: Actor, request: { family: PreparationFamily; operation: PreparationOperation; input: Record<string, unknown> }): Promise<PreparationRequest>;
  get(actor: Actor, family: PreparationFamily, commandId: string): Promise<PreparationRequest>;
  list(actor: Actor, options?: { limit?: number; cursor?: string }): Promise<PreparationRequestPage>;
  abandon(actor: Actor, family: PreparationFamily, commandId: string): Promise<PreparationRequest>;
  recordFailure(actor: Actor, family: PreparationFamily, commandId: string, error: { code: string; message: string }): Promise<void>;
};
