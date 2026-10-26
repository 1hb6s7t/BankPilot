import { z } from 'zod';
import type { Actor, ActionStatus, AuthorizationProof, PayeeView, RiskTier } from './index';

export const managementSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CONTACT_ALIAS_SAVE'), payeeId: z.string().min(1), alias: z.string().trim().min(1).max(40) }).strict(),
  z.object({ kind: z.literal('CARD_REPORT_LOST'), cardId: z.string().min(1), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('CARD_UNREPORT_LOST'), cardId: z.string().min(1), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('SUBSCRIPTION_QUERY') }).strict(),
  z.object({ kind: z.literal('SUBSCRIPTION_CANCEL'), subscriptionId: z.string().min(1), expectedVersion: z.number().int().positive(), queryActionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('SUBSCRIPTION_BLOCK'), subscriptionId: z.string().min(1), expectedVersion: z.number().int().positive(), queryActionId: z.string().min(1) }).strict(),
]);
export type ManagementSpec = z.infer<typeof managementSpecSchema>;
export const managementInputSchema = z.object({ commandId: z.string().min(8).max(128), taskId: z.string().optional(), spec: managementSpecSchema }).strict();
export type ManagementInput = z.infer<typeof managementInputSchema>;
export type CardView = { id: string; accountId: string; name: string; maskedNumber: string; status: 'ACTIVE' | 'LOST'; version: number; updatedAt: string };
export type SubscriptionView = {
  id: string; merchant: string; amountMinor: string; currency: 'CNY'; nextChargeDate: string; cardId: string;
  merchantStatus: 'ACTIVE' | 'CANCELLED'; bankStatus: 'ALLOWED' | 'BLOCKED';
  collectionStatus: 'ENABLED' | 'BLOCKED_BY_CARD' | 'BLOCKED_BY_BANK' | 'MERCHANT_CANCELLED';
  version: number; cancellationSupported: boolean; source: 'SYNTHETIC_MERCHANT';
};
export type SubscriptionSnapshot = { items: SubscriptionView[]; queriedAt: string; queryActionId: string; accessExpiresAt: string };
export type ManagementReceipt = {
  operationId: string; completedAt: string; summary: string; balanceDeltaMinor: '0';
  card?: CardView; subscription?: SubscriptionView; subscriptions?: SubscriptionSnapshot; payee?: PayeeView;
};
export type ManagementAction = {
  id: string; taskId: string; spec: ManagementSpec; title: string; details: string[];
  status: ActionStatus; tier: RiskTier; actionVersion: number; actionHash: string;
  expiresAt: string; createdAt: string; updatedAt: string; receipt?: ManagementReceipt; failureReason?: string;
  /** Present for subscription mutations; disclosure follows the original query grant. */
  detailsRedacted?: boolean; detailsAccessExpiresAt?: string;
};
export type ManagementDashboard = { cards: CardView[]; actions: ManagementAction[]; subscriptionQueryActionId?: string };
export type ManagementContext = { cards: CardView[]; subscriptions?: SubscriptionSnapshot };
export type ManagementService = {
  migrate(): Promise<void>; seedDemo(actor: Actor): Promise<void>;
  contacts(actor: Actor): Promise<PayeeView[]>;
  dashboard(actor: Actor): Promise<ManagementDashboard>;
  prepare(actor: Actor, input: ManagementInput): Promise<ManagementAction>;
  /** Atomically prepare 1–8 distinct subscription cancel/block commands. */
  prepareBatch(actor: Actor, inputs: ManagementInput[]): Promise<ManagementAction[]>;
  getAction(actor: Actor, id: string): Promise<ManagementAction>;
  getByCommand(actor: Actor, commandId: string): Promise<ManagementAction>;
  authorize(actor: Actor, id: string, proof: AuthorizationProof): Promise<ManagementAction>;
  cancel(actor: Actor, id: string): Promise<ManagementAction>;
  subscriptions(actor: Actor, queryActionId: string): Promise<SubscriptionSnapshot>;
};
