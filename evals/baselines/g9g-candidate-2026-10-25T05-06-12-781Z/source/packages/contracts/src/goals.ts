import { z } from 'zod';
import type { ActionView, Actor, FundsPreview } from './index';
import type { InvestmentAction } from './investment';

export const goalDraftSchema = z.object({
  title: z.string().trim().min(1).max(80), accountId: z.string().min(1), payeeId: z.string().min(1),
  amountMinor: z.string().regex(/^[1-9]\d{0,11}$/), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  funding: z.object({ positionId: z.string().min(1), redemptionAmountMinor: z.string().regex(/^[1-9]\d{0,11}$/) }).strict().optional(),
}).strict();
export type GoalDraft = z.infer<typeof goalDraftSchema>;
export const createGoalInputSchema = goalDraftSchema.extend({ commandId: z.string().min(8).max(128) }).strict();
export type CreateGoalInput = z.infer<typeof createGoalInputSchema>;
export const replanGoalInputSchema = goalDraftSchema.extend({ commandId: z.string().min(8).max(128), expectedPlanVersion: z.number().int().positive() }).strict();
export type ReplanGoalInput = z.infer<typeof replanGoalInputSchema>;
export type GoalNode = {
  id: string; kind: 'REDEEM' | 'WAIT_SETTLEMENT' | 'TRANSFER'; dependsOn: string[]; specVersion: number;
  status: 'BLOCKED' | 'READY' | 'AWAITING_AUTH' | 'IN_PROGRESS' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
  actionRef?: { service: 'investment' | 'transfer'; actionId: string }; reason?: string; evidenceRefs: string[];
  investmentAction?: InvestmentAction; transferAction?: ActionView;
};
export type GoalView = GoalDraft & {
  id: string; planVersion: number; status: 'ACTIVE' | 'NEEDS_REPLAN' | 'SUCCEEDED';
  nodes: GoalNode[]; reasons: string[]; revisionDiff: string[]; fundsPreview?: FundsPreview;
  expectedSettlementAt?: string; createdAt: string; updatedAt: string;
};
export type GoalsService = {
  migrate(): Promise<void>; create(actor: Actor, input: CreateGoalInput): Promise<GoalView>;
  list(actor: Actor): Promise<GoalView[]>; get(actor: Actor, id: string, options?: { readOnly?: boolean }): Promise<GoalView>;
  getByCommand(actor: Actor, commandId: string): Promise<GoalView>;
  advance(actor: Actor, id: string): Promise<GoalView>;
  replan(actor: Actor, id: string, input: ReplanGoalInput): Promise<GoalView>;
};
