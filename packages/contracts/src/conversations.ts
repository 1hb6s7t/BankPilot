import { z } from 'zod';
import type { PlanResult, PlanningFailure, PlanningModelAttempt } from './index.js';

export type ClarificationSlot = 'payee' | 'amount' | 'targetDate';
export type FieldSource = { field: 'payeeId' | 'amountMinor' | 'targetDate' | 'memo'; messageId: string; text: string; start: number; end: number; kind: 'original' | 'answer' | 'selection' };
export type ClarificationValues = { payeeId?: string; amountMinor?: string; targetDate?: string; memo?: string };
export type ConversationPlanningInput = {
  version: 1; message: string; originalMessage: string;
  typed?: { operation: 'transfer' | 'goal_create'; slots: ClarificationValues; sources: FieldSource[] };
};
export type Conversation = { id: string; title: string; version: number; createdAt: string; updatedAt: string };
export type ChatMessage = { id: string; conversationId: string; sequence: number; role: 'user' | 'assistant'; text: string; kind: 'request' | 'answer' | 'result' | 'failure' | 'cancellation'; clientMessageId?: string; commandId?: string; rootCommandId?: string; revision?: number; createdAt: string };
export type ClarificationCandidate = { id: string; name: string; bank: string; maskedNumber: string };
export type Clarification = { id: string; conversationId: string; parentCommandId: string; rootCommandId: string; version: number; status: 'waiting' | 'resolved' | 'cancelled'; question: string; requestedSlots: ClarificationSlot[]; operation: 'transfer' | 'goal_create'; values: ClarificationValues; constraints?: { targetMonth: number; targetDay: number }; sources: FieldSource[]; candidates: ClarificationCandidate[]; resolvedByCommandId?: string; createdAt: string };
export type ConversationEnvelope = PlanResult & { actions?: unknown[]; managementActions?: unknown[]; investmentActions?: unknown[]; goal?: unknown };
export type ConversationCommand = { commandId: string; conversationId: string; rootCommandId: string; parentCommandId?: string; revision: number; requestSequence?: number; stateVersion?: string; originalMessage: string; planningInput: ConversationPlanningInput; status: 'pending' | 'running' | 'failed' | 'complete'; retryable: boolean; leaseExpiresAt?: string; lastErrorCode?: string; failure?: PlanningFailure; modelAttempts?: PlanningModelAttempt[]; result?: ConversationEnvelope; clarification?: Clarification; createdAt: string; updatedAt: string };
export type ConversationHistory = { conversation: Conversation; messages: ChatMessage[]; commands: ConversationCommand[]; clarifications: Clarification[]; nextBeforeSequence?: number; latestCommandId?: string };
/** Opaque, owner-bound keyset cursors. Pages are live snapshots, not a long-lived export snapshot. */
export type ConversationPage = { conversations: Conversation[]; nextCursor?: string };
export type ConversationRecoveryItem = {
  commandId: string; conversationId: string; rootCommandId: string; parentCommandId?: string;
  revision: number; requestSequence: number; stateVersion: string;
  status: ConversationCommand['status']; retryable: boolean; leaseExpiresAt?: string; lastErrorCode?: string;
  messagePreview: string; createdAt: string; updatedAt: string;
  clarification?: { id: string; version: number; question: string };
};
export type ConversationRecoveryPage = { items: ConversationRecoveryItem[]; nextCursor?: string };
export type ConversationPageInput = { cursor?: string; limit?: number };
export const clarificationAnswerSchema = z.object({ payeeId: z.string().min(1).max(200).optional(), payeeSuffix: z.string().regex(/^\d{4}$/).optional(), amount: z.string().min(1).max(100).optional(), targetDate: z.string().min(1).max(30).optional() }).strict();
export const conversationMessageSchema = z.object({ clientMessageId: z.string().min(8).max(128), text: z.string().min(1).max(2000).refine(value => value.trim().length > 0), clarificationId: z.string().uuid().optional(), expectedClarificationVersion: z.number().int().positive().optional(), answer: clarificationAnswerSchema.optional() }).strict().refine(value => value.clarificationId ? value.expectedClarificationVersion !== undefined : value.expectedClarificationVersion === undefined && value.answer === undefined, { message: 'Clarification identity and version are required together' });
export type ConversationMessageInput = z.infer<typeof conversationMessageSchema>;
export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;
export type AcceptedConversationMessage = { message: ChatMessage; command: ConversationCommand; replayed: boolean };
