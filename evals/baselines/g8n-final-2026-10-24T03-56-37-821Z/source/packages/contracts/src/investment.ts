import { z } from 'zod';
import type { Actor, ActionStatus, AuthorizationProof, FaultMode } from './index';

export const redemptionSpecSchema = z.object({
  positionId: z.string().min(1), amountMinor: z.string().regex(/^[1-9]\d{0,11}$/),
  expectedVersion: z.number().int().positive(),
}).strict();
export type RedemptionSpec = z.infer<typeof redemptionSpecSchema>;
export const redemptionInputSchema = redemptionSpecSchema.extend({ commandId: z.string().min(8).max(128), taskId: z.string().optional() }).strict();
export type RedemptionInput = z.infer<typeof redemptionInputSchema>;
export type InvestmentActionStatus = ActionStatus | 'SETTLING';
export type InvestmentProduct = {
  id: string; name: string; redemptionBusinessDays: number; calendar: 'DEMO_WEEKDAYS_V1'; description: string;
};
/** Shared immutable definitions for the built-in synthetic products. */
export const syntheticInvestmentProducts: readonly Readonly<InvestmentProduct>[] = Object.freeze([
  Object.freeze({
    id: 'synthetic-t0', name: '合成即时赎回产品 T+0', redemptionBusinessDays: 0, calendar: 'DEMO_WEEKDAYS_V1' as const,
    description: '演示固定面值持仓，零费用、无收益预测；业务日即时到账，非业务日顺延。',
  }),
  Object.freeze({
    id: 'synthetic-t2', name: '合成延时赎回产品 T+2', redemptionBusinessDays: 2, calendar: 'DEMO_WEEKDAYS_V1' as const,
    description: '演示固定面值持仓，零费用、无收益预测；受理业务日起两个工作日到账。',
  }),
]);
export type InvestmentPosition = {
  id: string; accountId: string; productId: string; productName: string;
  principalMinor: string; reservedMinor: string; availableMinor: string; version: number;
  redemptionBusinessDays: number; calendar: 'DEMO_WEEKDAYS_V1';
};
export type InvestmentReceipt = {
  providerRequestId: string; providerTransactionId: string; positionId: string; accountId: string;
  amountMinor: string; currency: 'CNY'; settledAt: string;
};
export type InvestmentAction = {
  id: string; taskId: string; positionId: string; accountId: string; productId: string; productName: string;
  amountMinor: string; feeMinor: '0'; netAmountMinor: string; tier: 'RED'; status: InvestmentActionStatus;
  expectedVersion: number; actionVersion: number; actionHash: string; expiresAt: string;
  expectedSettlementAt: string; calendar: 'DEMO_WEEKDAYS_V1'; createdAt: string; updatedAt: string;
  acceptedAt?: string; receipt?: InvestmentReceipt; failureReason?: string;
};
export type InvestmentDashboard = { businessDate: string; calendar: 'DEMO_WEEKDAYS_V1'; products: InvestmentProduct[]; positions: InvestmentPosition[]; actions: InvestmentAction[] };
export type FundsTimeline = {
  asOf: string; timezone: 'Asia/Shanghai'; calendar: 'DEMO_WEEKDAYS_V1'; accountId: string;
  balanceMinor: string; reservedTransferMinor: string; minimumBalanceMinor: string; spendableNowMinor: string;
  days: { date: string; expectedInMinor: string; obligationsDueMinor: string; projectedCashMinor: string;
    conservativeCashMinor: string; protectedHeadroomMinor: string;
    events: { id: string; kind: 'REDEMPTION_EXPECTED' | 'OBLIGATION' | 'UNCERTAIN_REDEMPTION'; amountMinor: string; sourceId: string; title: string; certainty: 'EXPECTED' | 'UNCERTAIN' }[];
  }[]; warnings: string[];
};
export type InvestmentService = {
  migrate(): Promise<void>; seedDemo(actor: Actor): Promise<void>;
  dashboard(actor: Actor): Promise<InvestmentDashboard>;
  prepare(actor: Actor, input: RedemptionInput): Promise<InvestmentAction>;
  getAction(actor: Actor, id: string, options?: { readOnly?: boolean }): Promise<InvestmentAction>;
  getByCommand(actor: Actor, commandId: string): Promise<InvestmentAction>;
  authorize(actor: Actor, id: string, proof: AuthorizationProof): Promise<InvestmentAction>;
  cancel(actor: Actor, id: string): Promise<InvestmentAction>;
  execute(id: string): Promise<InvestmentAction>;
  reconcile(id: string): Promise<InvestmentAction>;
  processDue(): Promise<void>;
  timeline(actor: Actor, input?: { accountId?: string; days?: number }): Promise<FundsTimeline>;
  setNextFault(actor: Actor, mode: FaultMode): Promise<void>;
};
