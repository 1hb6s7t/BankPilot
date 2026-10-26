import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../../../packages/contracts/src/index.js';
import type { ConversationPlanningInput } from '../../../packages/contracts/src/conversations.js';
import { recognizeSubscriptionPrerequisite, type SubscriptionPrerequisite } from '../../../packages/agents/src/subscription-prerequisite.js';
import { withTransaction } from '../../../packages/core/src/database.js';
import { CoreError } from '../../../packages/core/src/errors.js';

export type SubscriptionContinuationState = 'WAITING_QUERY' | 'PLANNING' | 'WRITE_PREPARED' | 'NEEDS_QUERY_REAUTH' | 'NEEDS_CLARIFICATION' | 'UNSUPPORTED' | 'FAILED_RECOVERABLE' | 'STOPPED';
export type SubscriptionContinuation = {
  userId: string; conversationId: string; sourceCommandId: string; sourceUserMessageId: string; rootCommandId: string;
  originalMessageSha256: string; prerequisiteVersion: 1; prerequisiteDigest: string; prerequisite: SubscriptionPrerequisite;
  queryActionId: string; grantCycle: number; isCurrent: boolean; state: SubscriptionContinuationState; stateVersion: string;
  successorCommandId?: string; grantExpiresAt?: string; leaseToken?: string; leaseExpiresAt?: string; lastErrorCode?: string;
  createdAt: string; updatedAt: string;
};
export type RegisterSubscriptionWaiting = { sourceCommandId: string; queryActionId: string; prerequisite: SubscriptionPrerequisite };
export type ClaimSubscriptionGranted = {
  sourceCommandId: string; queryActionId: string; expectedStateVersion: string;
  /** Only a server-side caller that just checked management.subscriptions(actor, queryActionId) may supply this. */
  grantExpiresAt: string; leaseMs?: number;
};
export type CompleteSubscriptionContinuation = {
  successorCommandId: string; state: Exclude<SubscriptionContinuationState, 'WAITING_QUERY' | 'PLANNING' | 'STOPPED'>;
  commandLeaseToken?: string; lastErrorCode?: string;
};
type Row = Record<string, any>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const conflict = (code = 'SUBSCRIPTION_CONTINUATION_CONFLICT'): never => { throw new CoreError(code, '订阅接续状态已变化，请刷新后重试。', 409); };
function notFound(): never { throw new CoreError('SUBSCRIPTION_CONTINUATION_NOT_FOUND', '原请求或接续记录不存在。', 404); }
const iso = (value: string | Date) => new Date(value).toISOString();
const view = (row: Row): SubscriptionContinuation => ({
  userId: row.user_id, conversationId: row.conversation_id, sourceCommandId: row.source_command_id,
  sourceUserMessageId: row.source_user_message_id, rootCommandId: row.root_command_id,
  originalMessageSha256: row.original_message_sha256, prerequisiteVersion: row.prerequisite_version,
  prerequisiteDigest: row.prerequisite_digest, prerequisite: row.prerequisite,
  queryActionId: row.query_action_id, grantCycle: row.grant_cycle, isCurrent: row.is_current,
  state: row.state, stateVersion: String(row.state_version),
  ...(row.successor_command_id ? { successorCommandId: row.successor_command_id } : {}),
  ...(row.grant_expires_at ? { grantExpiresAt: iso(row.grant_expires_at) } : {}),
  ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
  ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
  ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});
function boundedLimit(value = 100) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) conflict('SUBSCRIPTION_CONTINUATION_LIMIT_INVALID');
  return value;
}

/** Server-only durable scheduling metadata. This store never obtains a grant,
 * chooses a subscription, authorizes an action, or logs source/request data.
 * Migrate conversations first. Public routes must project these internal rows. */
export function createSubscriptionContinuationStore(pool: Pool) {
  const transaction = <T>(fn: (tx: PoolClient) => Promise<T>) => withTransaction(pool, fn);
  async function lockConversation(tx: PoolClient, actor: Actor, cid: string) {
    if (!(await tx.query('SELECT id FROM bp_conversations WHERE user_id=$1 AND id=$2 FOR UPDATE', [actor.userId, cid])).rowCount) notFound();
  }
  async function source(tx: Pool | PoolClient, actor: Actor, commandId: string): Promise<Row> {
    const row = (await tx.query(`SELECT c.*,m.text AS source_user_text,m.role AS source_user_role,m.command_id AS source_user_command_id
      FROM bp_plan_commands c LEFT JOIN bp_chat_messages m
        ON m.user_id=c.user_id AND m.conversation_id=c.conversation_id AND m.id=c.user_message_id
      WHERE c.user_id=$1 AND c.command_id=$2`, [actor.userId, commandId])).rows[0];
    if (!row) notFound();
    const original = row.original_message, planning = row.planning_input;
    if (!row.conversation_id || !row.user_message_id || !row.root_command_id || row.source_user_role !== 'user'
      || row.source_user_command_id !== row.command_id || typeof original !== 'string' || row.source_user_text !== original
      || planning?.version !== 1 || planning.message !== original || planning.originalMessage !== original || planning.typed
      || hash(original) !== row.message_hash) conflict('SUBSCRIPTION_CONTINUATION_SOURCE_INVALID');
    return row;
  }
  function assertPrerequisite(original: string, prerequisite: SubscriptionPrerequisite) {
    const recognized = recognizeSubscriptionPrerequisite(original);
    if (!recognized || stable(recognized) !== stable(prerequisite)) conflict('SUBSCRIPTION_CONTINUATION_PREREQUISITE_INVALID');
  }
  function assertSaved(row: Row, command: Row) {
    assertPrerequisite(command.original_message, row.prerequisite);
    if (row.conversation_id !== command.conversation_id || row.source_user_message_id !== command.user_message_id
      || row.root_command_id !== command.root_command_id || row.original_message_sha256 !== hash(command.original_message)
      || row.prerequisite_version !== 1 || row.prerequisite_digest !== hash(stable(row.prerequisite))) conflict('SUBSCRIPTION_CONTINUATION_SOURCE_INVALID');
  }
  async function current(tx: Pool | PoolClient, actor: Actor, sourceCommandId: string, lock = false): Promise<Row | undefined> {
    return (await tx.query(`SELECT * FROM bp_subscription_continuations WHERE user_id=$1 AND source_command_id=$2 AND is_current${lock ? ' FOR UPDATE' : ''}`, [actor.userId, sourceCommandId])).rows[0];
  }
  async function touch(tx: PoolClient, row: Row) {
    await tx.query("UPDATE bp_plan_commands SET updated_at=now() WHERE user_id=$1 AND command_id=$2 AND status='complete'", [row.user_id, row.source_command_id]);
  }
  async function fenceInactiveChild(tx: PoolClient, row: Row): Promise<boolean> {
    if (row.successor_command_id) {
      const child = await successor(tx, { userId: row.user_id }, row);
      if (child.status === 'running') return false;
      if (child.status === 'pending' || child.status === 'failed') {
        const stopped = await tx.query(`UPDATE bp_plan_commands SET status='failed',last_error_code='QUERY_AUTHORIZATION_REQUIRED',
          planning_failure=CASE WHEN planning_failure IS NULL THEN $3::jsonb ELSE jsonb_set(planning_failure,'{retryable}','false') END,
          updated_at=now() WHERE user_id=$1 AND command_id=$2 AND status IN ('pending','failed') RETURNING command_id`,
        [row.user_id, child.command_id, JSON.stringify({ phase: 'semantic_intent', code: 'QUERY_AUTHORIZATION_REQUIRED', retryable: false, message: '查询权限已失效，请重新确认查询。', modelRuns: [] })]);
        if (!stopped.rowCount) return false;
      }
    }
    return true;
  }
  async function markExpired(tx: PoolClient, row: Row): Promise<Row> {
    if (!await fenceInactiveChild(tx, row)) return row;
    const result = (await tx.query(`UPDATE bp_subscription_continuations SET state='NEEDS_QUERY_REAUTH',state_version=state_version+1,
      lease_token=NULL,lease_expires_at=NULL,last_error_code='SUBSCRIPTION_QUERY_EXPIRED',updated_at=now()
      WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3 RETURNING *`, [row.user_id, row.source_command_id, row.grant_cycle])).rows[0];
    await touch(tx, row); return result;
  }
  async function successor(tx: Pool | PoolClient, actor: Actor, row: Row): Promise<Row> {
    const child = (await tx.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2', [actor.userId, row.successor_command_id])).rows[0];
    if (!child || child.conversation_id !== row.conversation_id || child.user_message_id !== row.source_user_message_id
      || child.parent_command_id !== row.source_command_id || child.root_command_id !== row.root_command_id
      || child.original_message !== row.prerequisite.message || child.planning_input?.version !== 1 || child.planning_input?.typed || child.planning_input?.message !== row.prerequisite.message
      || child.planning_input?.originalMessage !== row.prerequisite.message || child.message_hash !== row.original_message_sha256
      || !Number.isSafeInteger(child.revision) || child.revision < 1) conflict('SUBSCRIPTION_CONTINUATION_SUCCESSOR_INVALID');
    return child;
  }
  async function registerWaitingTx(tx: PoolClient, actor: Actor, input: RegisterSubscriptionWaiting): Promise<SubscriptionContinuation> {
    let command = await source(tx, actor, input.sourceCommandId);
    await lockConversation(tx, actor, command.conversation_id);
    command = await source(tx, actor, input.sourceCommandId);
    if (command.status !== 'complete') conflict('SUBSCRIPTION_CONTINUATION_SOURCE_INCOMPLETE');
    assertPrerequisite(command.original_message, input.prerequisite);
    if (typeof input.queryActionId !== 'string' || !input.queryActionId || input.queryActionId.length > 200) conflict();
    const previous = await current(tx, actor, input.sourceCommandId, true);
    if (previous) {
      assertSaved(previous, command);
      if (previous.query_action_id === input.queryActionId) {
        if (previous.prerequisite_digest !== hash(stable(input.prerequisite))) conflict();
        return view(previous);
      }
      if (previous.state !== 'NEEDS_QUERY_REAUTH') conflict();
      if (previous.successor_command_id) {
        const child = await successor(tx, actor, previous);
        if (!['complete', 'failed'].includes(child.status)) conflict('SUBSCRIPTION_CONTINUATION_RUNNING');
      }
    } else {
      // The first query binding must be the only action actually committed by
      // the source plan. Later reauthorization is a distinct server operation;
      // Core validates that new exact query id before this method is called.
      const actions = command.result?.managementActions;
      if (!Array.isArray(actions) || actions.length !== 1 || actions[0]?.id !== input.queryActionId || actions[0]?.spec?.kind !== 'SUBSCRIPTION_QUERY'
        || command.result?.actions?.length || command.result?.investmentActions?.length || command.result?.goal) conflict('SUBSCRIPTION_CONTINUATION_QUERY_MISMATCH');
    }
    if ((await tx.query('SELECT 1 FROM bp_subscription_continuations WHERE query_action_id=$1', [input.queryActionId])).rowCount) conflict('SUBSCRIPTION_CONTINUATION_QUERY_MISMATCH');
    if (previous) await tx.query('UPDATE bp_subscription_continuations SET is_current=false,state_version=state_version+1,updated_at=now() WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3', [actor.userId, input.sourceCommandId, previous.grant_cycle]);
    const row = (await tx.query(`INSERT INTO bp_subscription_continuations(user_id,conversation_id,source_command_id,source_user_message_id,root_command_id,
      original_message_sha256,prerequisite_version,prerequisite_digest,prerequisite,query_action_id,grant_cycle)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING *`, [actor.userId, command.conversation_id, input.sourceCommandId, command.user_message_id,
      command.root_command_id, hash(command.original_message), hash(stable(input.prerequisite)), JSON.stringify(input.prerequisite), input.queryActionId, (previous?.grant_cycle ?? 0) + 1])).rows[0];
    if (!row) conflict('SUBSCRIPTION_CONTINUATION_QUERY_MISMATCH');
    await touch(tx, row); return view(row);
  }
  async function completeTx(tx: PoolClient, actor: Actor, input: CompleteSubscriptionContinuation): Promise<SubscriptionContinuation> {
    const found = (await tx.query('SELECT * FROM bp_subscription_continuations WHERE user_id=$1 AND successor_command_id=$2', [actor.userId, input.successorCommandId])).rows[0];
    if (!found) notFound();
    await lockConversation(tx, actor, found.conversation_id);
    const row = (await tx.query('SELECT *,grant_expires_at>clock_timestamp() AS grant_valid FROM bp_subscription_continuations WHERE user_id=$1 AND successor_command_id=$2 FOR UPDATE', [actor.userId, input.successorCommandId])).rows[0];
    if (!row) notFound();
    if (row.state === 'STOPPED' || row.state === input.state) return view(row);
    if (row.state !== 'PLANNING' || !row.is_current) conflict();
    const command = await source(tx, actor, row.source_command_id); assertSaved(row, command);
    const child = await successor(tx, actor, row);
    if (input.commandLeaseToken && child.lease_token !== input.commandLeaseToken) conflict('PLAN_SUPERSEDED');
    const expected = input.state === 'WRITE_PREPARED' ? ['complete'] : input.state === 'FAILED_RECOVERABLE' ? ['failed'] : ['complete', 'failed'];
    if (!expected.includes(child.status)) conflict('SUBSCRIPTION_CONTINUATION_SUCCESSOR_INCOMPLETE');
    if (!row.grant_valid) return view(await markExpired(tx, row));
    const safeCode = input.lastErrorCode && /^[A-Z][A-Z0-9_]{0,79}$/.test(input.lastErrorCode) ? input.lastErrorCode : null;
    const updated = (await tx.query(`UPDATE bp_subscription_continuations SET state=$4,state_version=state_version+1,
      lease_token=NULL,lease_expires_at=NULL,last_error_code=$5,updated_at=now() WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3 RETURNING *`,
    [actor.userId, row.source_command_id, row.grant_cycle, input.state, safeCode])).rows[0];
    await touch(tx, row); return view(updated);
  }
  return {
    async migrate() {
      await pool.query(`CREATE TABLE IF NOT EXISTS bp_subscription_continuations(
        user_id text NOT NULL,conversation_id text NOT NULL,source_command_id text NOT NULL,source_user_message_id text NOT NULL,root_command_id text NOT NULL,
        original_message_sha256 text NOT NULL,prerequisite_version integer NOT NULL CHECK(prerequisite_version=1),prerequisite_digest text NOT NULL,prerequisite jsonb NOT NULL,
        query_action_id text NOT NULL UNIQUE,grant_cycle integer NOT NULL CHECK(grant_cycle>0),is_current boolean NOT NULL DEFAULT true,
        state text NOT NULL DEFAULT 'WAITING_QUERY' CHECK(state IN ('WAITING_QUERY','PLANNING','WRITE_PREPARED','NEEDS_QUERY_REAUTH','NEEDS_CLARIFICATION','UNSUPPORTED','FAILED_RECOVERABLE','STOPPED')),
        state_version bigint NOT NULL DEFAULT 1,successor_command_id text UNIQUE,grant_expires_at timestamptz,lease_token uuid,lease_expires_at timestamptz,last_error_code text,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,source_command_id,grant_cycle),
        FOREIGN KEY(user_id,conversation_id) REFERENCES bp_conversations(user_id,id),
        FOREIGN KEY(user_id,source_command_id) REFERENCES bp_plan_commands(user_id,command_id),
        FOREIGN KEY(source_user_message_id) REFERENCES bp_chat_messages(id),
        FOREIGN KEY(user_id,successor_command_id) REFERENCES bp_plan_commands(user_id,command_id));
        CREATE UNIQUE INDEX IF NOT EXISTS bp_subscription_continuation_current ON bp_subscription_continuations(user_id,source_command_id) WHERE is_current;
        CREATE INDEX IF NOT EXISTS bp_subscription_continuation_scan ON bp_subscription_continuations(user_id,updated_at,source_command_id) WHERE is_current;`);
    },
    registerWaitingTx,
    registerWaiting: (actor: Actor, input: RegisterSubscriptionWaiting) => transaction(tx => registerWaitingTx(tx, actor, input)),
    async get(actor: Actor, sourceCommandId: string): Promise<SubscriptionContinuation | undefined> {
      const row = await current(pool, actor, sourceCommandId); return row ? view(row) : undefined;
    },
    async getBySuccessor(actor: Actor, commandId: string): Promise<SubscriptionContinuation | undefined> {
      const row = (await pool.query('SELECT * FROM bp_subscription_continuations WHERE user_id=$1 AND successor_command_id=$2', [actor.userId, commandId])).rows[0];
      return row ? view(row) : undefined;
    },
    async listForUser(actor: Actor, input: { states?: SubscriptionContinuationState[]; limit?: number; afterSourceCommandId?: string } = {}): Promise<SubscriptionContinuation[]> {
      if (input.afterSourceCommandId !== undefined) {
        if (typeof input.afterSourceCommandId !== 'string' || input.afterSourceCommandId.length > 200) conflict('SUBSCRIPTION_CONTINUATION_CURSOR_INVALID');
        // Background scans explicitly start at ''. Stable source IDs, unlike
        // updated_at, cannot move across the cursor when a row is claimed.
        const rows = (await pool.query(`SELECT * FROM bp_subscription_continuations WHERE user_id=$1 AND is_current
          AND ($2::text[] IS NULL OR state=ANY($2::text[])) AND source_command_id>$3
          ORDER BY source_command_id LIMIT $4`, [actor.userId, input.states ?? null, input.afterSourceCommandId, boundedLimit(input.limit)])).rows;
        return rows.map(view);
      }
      const rows = (await pool.query(`SELECT * FROM bp_subscription_continuations WHERE user_id=$1 AND is_current
        AND ($2::text[] IS NULL OR state=ANY($2::text[])) ORDER BY updated_at,source_command_id LIMIT $3`, [actor.userId, input.states ?? null, boundedLimit(input.limit)])).rows;
      return rows.map(view);
    },
    listWaitingForUser: async (actor: Actor, input: { limit?: number } = {}): Promise<SubscriptionContinuation[]> => {
      const rows = (await pool.query(`SELECT * FROM bp_subscription_continuations WHERE user_id=$1 AND is_current AND state IN ('WAITING_QUERY','PLANNING')
        ORDER BY updated_at,source_command_id LIMIT $2`, [actor.userId, boundedLimit(input.limit)])).rows;
      return rows.map(view);
    },
    async claimGranted(actor: Actor, input: ClaimSubscriptionGranted): Promise<SubscriptionContinuation | null> {
      const expires = new Date(input.grantExpiresAt), leaseMs = input.leaseMs ?? 240_000;
      if (!Number.isFinite(expires.valueOf()) || !/^[1-9][0-9]*$/.test(input.expectedStateVersion) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 240_000) conflict();
      return transaction(async tx => {
        const command = await source(tx, actor, input.sourceCommandId); await lockConversation(tx, actor, command.conversation_id);
        const row = await current(tx, actor, input.sourceCommandId, true);
        if (!row || row.query_action_id !== input.queryActionId || String(row.state_version) !== input.expectedStateVersion) return null;
        assertSaved(row, command);
        if (command.status !== 'complete') conflict('SUBSCRIPTION_CONTINUATION_SOURCE_INCOMPLETE');
        const clock = (await tx.query('SELECT clock_timestamp() AS now')).rows[0].now;
        const eligible = row.state === 'WAITING_QUERY' || row.state === 'FAILED_RECOVERABLE'
          || (row.state === 'PLANNING' && row.lease_expires_at && new Date(row.lease_expires_at).valueOf() <= new Date(clock).valueOf());
        if (!eligible) return null;
        if (row.successor_command_id) {
          const child = await successor(tx, actor, row);
          // The normal runner refuses permanent failures before entering its
          // failure callback. Do not acquire a scheduler lease it cannot finish.
          if (child.status === 'failed' && child.planning_failure?.retryable === false) {
            await tx.query(`UPDATE bp_subscription_continuations SET state='NEEDS_CLARIFICATION',state_version=state_version+1,
              lease_token=NULL,lease_expires_at=NULL,last_error_code='CONTINUATION_CHILD_NOT_RETRYABLE',updated_at=now()
              WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3`, [actor.userId, input.sourceCommandId, row.grant_cycle]);
            await touch(tx, row); return null;
          }
        }
        if (row.grant_expires_at && iso(row.grant_expires_at) !== expires.toISOString()) conflict('SUBSCRIPTION_CONTINUATION_QUERY_MISMATCH');
        if (expires.valueOf() <= new Date(clock).valueOf()) { await markExpired(tx, row); return null; }
        const updated = (await tx.query(`UPDATE bp_subscription_continuations SET state='PLANNING',state_version=state_version+1,
          grant_expires_at=$5,lease_token=$6,lease_expires_at=clock_timestamp()+($7::integer*interval '1 millisecond'),last_error_code=NULL,updated_at=now()
          WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3 AND state_version=$4 RETURNING *`,
        [actor.userId, input.sourceCommandId, row.grant_cycle, input.expectedStateVersion, expires.toISOString(), randomUUID(), leaseMs])).rows[0];
        await touch(tx, row); return updated ? view(updated) : null;
      });
    },
    async createSuccessor(actor: Actor, input: { sourceCommandId: string; leaseToken: string }): Promise<{ continuation: SubscriptionContinuation; commandId: string; replayed: boolean }> {
      return transaction(async tx => {
        const command = await source(tx, actor, input.sourceCommandId); await lockConversation(tx, actor, command.conversation_id);
        const row = (await tx.query(`SELECT *,lease_expires_at>clock_timestamp() AS lease_valid,grant_expires_at>clock_timestamp() AS grant_valid
          FROM bp_subscription_continuations WHERE user_id=$1 AND source_command_id=$2 AND is_current FOR UPDATE`, [actor.userId, input.sourceCommandId])).rows[0];
        if (!row) notFound(); assertSaved(row, command);
        if (row.state !== 'PLANNING' || row.lease_token !== input.leaseToken || !row.lease_valid) conflict('SUBSCRIPTION_CONTINUATION_LEASE_LOST');
        if (!row.grant_valid) { await markExpired(tx, row); return { continuation: view(await current(tx, actor, input.sourceCommandId) as Row), commandId: '', replayed: false }; }
        if (command.status !== 'complete') conflict('SUBSCRIPTION_CONTINUATION_SOURCE_INCOMPLETE');
        if (row.successor_command_id) {
          await successor(tx, actor, row); return { continuation: view(row), commandId: row.successor_command_id, replayed: true };
        }
        const revision = Number((await tx.query('SELECT COALESCE(MAX(revision),-1)+1 AS revision FROM bp_plan_commands WHERE user_id=$1 AND root_command_id=$2', [actor.userId, command.root_command_id])).rows[0].revision);
        if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) conflict();
        const commandId = randomUUID(), planningInput: ConversationPlanningInput = command.planning_input;
        await tx.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,status,conversation_id,user_message_id,original_message,planning_input,root_command_id,parent_command_id,revision)
          VALUES($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10)`, [actor.userId, commandId, command.message_hash, command.conversation_id, command.user_message_id,
          command.original_message, JSON.stringify(planningInput), command.root_command_id, command.command_id, revision]);
        const sequence = (await tx.query('UPDATE bp_conversations SET next_sequence=next_sequence+1,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING next_sequence', [actor.userId, command.conversation_id])).rows[0].next_sequence;
        await tx.query(`INSERT INTO bp_chat_messages(id,user_id,conversation_id,sequence,role,text,kind,command_id,root_command_id,revision,response_key)
          VALUES($1,$2,$3,$4,'assistant','查询已获授权，正在按原请求核对；后续操作仍须分别确认。','result',$5,$6,$7,'continuation')`, [randomUUID(), actor.userId, command.conversation_id, sequence, commandId, command.root_command_id, revision]);
        const updated = (await tx.query(`UPDATE bp_subscription_continuations SET successor_command_id=$4,state_version=state_version+1,updated_at=now()
          WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3 RETURNING *`, [actor.userId, input.sourceCommandId, row.grant_cycle, commandId])).rows[0];
        await touch(tx, row); return { continuation: view(updated), commandId, replayed: false };
      });
    },
    completeTx,
    complete: (actor: Actor, input: CompleteSubscriptionContinuation) => transaction(tx => completeTx(tx, actor, input)),
    async markNeedsQuery(actor: Actor, input: { sourceCommandId: string; queryActionId: string; expectedStateVersion: string; lastErrorCode: string }): Promise<SubscriptionContinuation | null> {
      return transaction(async tx => {
        const command = await source(tx, actor, input.sourceCommandId); await lockConversation(tx, actor, command.conversation_id);
        const row = await current(tx, actor, input.sourceCommandId, true);
        if (!row || row.query_action_id !== input.queryActionId || String(row.state_version) !== input.expectedStateVersion) return null;
        assertSaved(row, command);
        if (!['WAITING_QUERY', 'PLANNING', 'FAILED_RECOVERABLE'].includes(row.state)) return null;
        // Obsolete pending/failed work must not reenter ordinary command
        // recovery; a running child is never stopped by a background scanner.
        if (!await fenceInactiveChild(tx, row)) return null;
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(input.lastErrorCode) ? input.lastErrorCode : 'QUERY_AUTHORIZATION_REQUIRED';
        const updated = (await tx.query(`UPDATE bp_subscription_continuations SET state='NEEDS_QUERY_REAUTH',state_version=state_version+1,
          lease_token=NULL,lease_expires_at=NULL,last_error_code=$4,updated_at=now() WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3 RETURNING *`,
        [actor.userId, input.sourceCommandId, row.grant_cycle, code])).rows[0];
        await touch(tx, row); return view(updated);
      });
    },
    async stop(actor: Actor, input: { sourceCommandId: string; expectedStateVersion?: string }): Promise<SubscriptionContinuation> {
      return transaction(async tx => {
        const command = await source(tx, actor, input.sourceCommandId); await lockConversation(tx, actor, command.conversation_id);
        const row = await current(tx, actor, input.sourceCommandId, true); if (!row) notFound(); assertSaved(row, command);
        if (row.state === 'STOPPED') return view(row);
        // No stop acknowledgement can race a still-dispatched planner or its
        // external candidate preparation. Waiting requests can be stopped;
        // running requests need to finish before their cards are cancelled.
        if (row.state === 'PLANNING') conflict('SUBSCRIPTION_CONTINUATION_RUNNING');
        if (input.expectedStateVersion !== undefined && input.expectedStateVersion !== String(row.state_version)) conflict();
        const updated = (await tx.query(`UPDATE bp_subscription_continuations SET state='STOPPED',state_version=state_version+1,
          lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE user_id=$1 AND source_command_id=$2 AND grant_cycle=$3 RETURNING *`, [actor.userId, input.sourceCommandId, row.grant_cycle])).rows[0];
        await touch(tx, row); return view(updated);
      });
    },
  };
}
export type SubscriptionContinuationStore = ReturnType<typeof createSubscriptionContinuationStore>;
