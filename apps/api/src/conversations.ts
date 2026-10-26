import { formatConversationResultText, presentStoredResultText, projectConversationResult, isConversationPresentationEnvelope } from './conversation-presentation.js';
import { createSubscriptionContinuationStore } from './subscription-continuations.js';
import { withTransaction } from '../../../packages/core/src/database.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Actor, PayeeView, PlannerInput } from '../../../packages/contracts/src/index.js';
import { conversationMessageSchema, type AcceptedConversationMessage, type ChatMessage, type Clarification, type Conversation, type ConversationCommand, type ConversationEnvelope, type ConversationHistory, type ConversationMessageInput, type ConversationPlanningInput, type ConversationPage, type ConversationPageInput, type ConversationRecoveryPage, type ConversationRecoveryItem } from '../../../packages/contracts/src/conversations.js';
import { CoreError } from '../../../packages/core/src/index.js';
import { buildClarification, hasPlannedActions, mergeClarification } from './clarification.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const notFound = (): never => { throw new CoreError('CONVERSATION_NOT_FOUND', '聊天或请求不存在', 404); };
const conflict = (message: string): never => { throw new CoreError('COMMAND_CONFLICT', message, 409); };
const iso = (value: Date | string) => new Date(value).toISOString();
const sequenceNumber = (value: unknown): number => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new CoreError('HISTORY_SEQUENCE_UNSUPPORTED', '聊天序号超出可安全读取范围，未返回不精确的分页结果', 409);
  return number;
};
const pageLimit = (value: number | undefined, fallback: number): number => {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CoreError('PAGINATION_INVALID', '分页数量必须在1到100之间', 400);
  return limit;
};
type PageCursor = { v: 1; kind: 'conversations' | 'recovery'; userId: string; conversationId?: string; anchorId: string };
const encodeCursor = (value: PageCursor): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const decodeCursor = (value: string | undefined, actor: Actor, kind: PageCursor['kind'], cid?: string): PageCursor | undefined => {
  if (value === undefined) return undefined;
  let cursor: PageCursor;
  try {
    if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const text = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(text).toString('base64url') !== value) throw new Error();
    cursor = JSON.parse(text);
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || cursor.v !== 1 || !['conversations','recovery'].includes(cursor.kind)
      || typeof cursor.userId !== 'string' || typeof cursor.anchorId !== 'string' || !cursor.anchorId || cursor.anchorId.length > 200
      || (cursor.conversationId !== undefined && typeof cursor.conversationId !== 'string')
      || Object.keys(cursor).some(key => !['v','kind','userId','conversationId','anchorId'].includes(key))) throw new Error();
  } catch { throw new CoreError('PAGINATION_CURSOR_INVALID', '分页游标无效，请刷新列表', 400); }
  if (cursor.userId !== actor.userId || cursor.kind !== kind || cursor.conversationId !== cid) notFound();
  return cursor;
};
const conversationView = (r: any): Conversation => ({ id: r.id, title: r.title, version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const messageView = (r: any): ChatMessage => ({ id: r.id, conversationId: r.conversation_id, sequence: sequenceNumber(r.sequence), role: r.role, text: r.text, kind: r.kind, ...(r.client_message_id ? { clientMessageId: r.client_message_id } : {}), ...(r.command_id ? { commandId: r.command_id, rootCommandId: r.root_command_id, revision: r.revision } : {}), createdAt: iso(r.created_at) });
const clarificationView = (r: any): Clarification => ({ ...r.payload, id: r.id, conversationId: r.conversation_id, parentCommandId: r.parent_command_id, rootCommandId: r.root_command_id, version: r.version, status: r.status, ...(r.resolved_by_command_id ? { resolvedByCommandId: r.resolved_by_command_id } : {}), createdAt: iso(r.created_at) });
export function createConversationService(pool: Pool, options: { getPayees?: (actor: Actor) => Promise<PayeeView[]> } = {}) {
  async function transaction<T>(run: (tx: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    return withTransaction(pool, run, { readOnly });
  }
  async function owned(tx: Pool | PoolClient, actor: Actor, cid: string, lock = false) {
    const row = (await tx.query(`SELECT * FROM bp_conversations WHERE user_id=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [actor.userId, cid])).rows[0];
    if (!row) notFound(); return row;
  }
  async function append(tx: PoolClient, actor: Actor, cid: string, value: { id?: string; role: ChatMessage['role']; text: string; kind: ChatMessage['kind']; commandId?: string; rootCommandId?: string; revision?: number; clientMessageId?: string; payloadHash?: string; responseKey?: string }) {
    await owned(tx, actor, cid, true);
    if (value.responseKey) {
      const previous = (await tx.query('SELECT * FROM bp_chat_messages WHERE user_id=$1 AND command_id=$2 AND response_key=$3', [actor.userId, value.commandId, value.responseKey])).rows[0];
      if (previous) return messageView(previous);
    }
    const seq = (await tx.query('UPDATE bp_conversations SET next_sequence=next_sequence+1,version=version+1,updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING next_sequence', [actor.userId, cid])).rows[0].next_sequence;
    const row = (await tx.query(`INSERT INTO bp_chat_messages(id,user_id,conversation_id,sequence,role,text,kind,command_id,root_command_id,revision,client_message_id,payload_hash,response_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [value.id ?? randomUUID(), actor.userId, cid, seq, value.role, value.text, value.kind, value.commandId ?? null, value.rootCommandId ?? null, value.revision ?? null, value.clientMessageId ?? null, value.payloadHash ?? null, value.responseKey ?? null])).rows[0];
    return messageView(row);
  }
  async function commandView(tx: Pool | PoolClient, actor: Actor, row: any, snapshot?: { clarification: any | undefined; requestSequence: unknown }): Promise<ConversationCommand> {
    if (!snapshot) {
      const metadata = (await tx.query(`SELECT m.sequence AS request_sequence,
        (SELECT to_jsonb(k) FROM bp_clarifications k WHERE k.user_id=c.user_id AND k.parent_command_id=c.command_id ORDER BY k.created_at DESC,k.id DESC LIMIT 1) AS clarification
        FROM bp_plan_commands c LEFT JOIN bp_chat_messages m ON m.user_id=c.user_id AND m.conversation_id=c.conversation_id AND m.id=c.user_message_id
        WHERE c.user_id=$1 AND c.command_id=$2`, [actor.userId, row.command_id])).rows[0];
      snapshot = { clarification: metadata?.clarification, requestSequence: metadata?.request_sequence };
    }
    const clarification = snapshot.clarification;
    const expiry = new Date(new Date(row.updated_at).valueOf() + 240_000);
    const result = row.result?.billAnswerReview?.status === 'withheld' && !isConversationPresentationEnvelope(row.result) ? undefined
      : row.result ? projectConversationResult(row.result) : undefined;
    return { commandId: row.command_id, conversationId: row.conversation_id, rootCommandId: row.root_command_id, ...(row.parent_command_id ? { parentCommandId: row.parent_command_id } : {}), revision: row.revision,
      ...(snapshot.requestSequence != null ? { requestSequence: sequenceNumber(snapshot.requestSequence) } : {}), ...(row.state_version != null ? { stateVersion: String(row.state_version) } : {}),
      originalMessage: row.original_message, planningInput: row.planning_input, status: row.status, retryable: row.status === 'pending' || (row.status === 'failed' && row.planning_failure?.retryable !== false) || (row.status === 'running' && expiry.valueOf() <= Date.now()), ...(row.status === 'running' ? { leaseExpiresAt: expiry.toISOString() } : {}), ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}), ...(result ? { result } : {}), ...(row.planning_failure ? { failure: row.planning_failure } : {}), ...(row.model_attempts?.length ? { modelAttempts: row.model_attempts } : {}), ...(clarification ? { clarification: clarificationView(clarification) } : {}), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
  }
  return {
    async migrate() {
      await pool.query(`CREATE TABLE IF NOT EXISTS bp_plan_commands(user_id text NOT NULL,command_id text NOT NULL,message_hash text NOT NULL,status text NOT NULL DEFAULT 'running',result jsonb,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,command_id));
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS proposal jsonb;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS lease_token uuid;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS conversation_id text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS user_message_id text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS original_message text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS planning_input jsonb;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS prepared_input jsonb;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS prepared_input_version integer;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_version text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_schema_version text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_input_digest text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_checkpoint_thread_id text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_checkpoint_ns text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_checkpoint_id text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS root_command_id text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS parent_command_id text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS last_error_code text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS state_version bigint NOT NULL DEFAULT 1;
        CREATE OR REPLACE FUNCTION bp_increment_command_state_version() RETURNS trigger LANGUAGE plpgsql AS $version$
          BEGIN NEW.state_version := OLD.state_version + 1; RETURN NEW; END;
        $version$;
        DO $trigger$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='bp_plan_commands'::regclass AND tgname='bp_command_state_version') THEN
            CREATE TRIGGER bp_command_state_version BEFORE UPDATE ON bp_plan_commands FOR EACH ROW EXECUTE FUNCTION bp_increment_command_state_version();
          END IF;
        END $trigger$;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS recognition_input jsonb;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS recognition_version integer;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS recognition_digest text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS recognition_graph_version text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS recognition_schema_version text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS recognition_semantic_version text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS semantic_result jsonb;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS semantic_digest text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS semantic_model_runs jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS model_output_reserved integer NOT NULL DEFAULT 0;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS model_attempts jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS planning_failure jsonb;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS planning_failures jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS stage_results jsonb NOT NULL DEFAULT '{}';
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS stage_history jsonb NOT NULL DEFAULT '[]';
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS stage_state_digest text;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_restart_required boolean NOT NULL DEFAULT false;
        ALTER TABLE bp_plan_commands ADD COLUMN IF NOT EXISTS graph_attempt_history jsonb NOT NULL DEFAULT '[]';
        CREATE INDEX IF NOT EXISTS bp_chat_command_unfinished_page ON bp_plan_commands(user_id,conversation_id,command_id) INCLUDE(user_message_id) WHERE status IN ('pending','running','failed');
        CREATE INDEX IF NOT EXISTS bp_chat_command_conversation ON bp_plan_commands(user_id,conversation_id,command_id);
        CREATE UNIQUE INDEX IF NOT EXISTS bp_chat_command_revision ON bp_plan_commands(user_id,root_command_id,revision) WHERE conversation_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS bp_conversations(id text NOT NULL,user_id text NOT NULL,title text NOT NULL,version integer NOT NULL DEFAULT 1,next_sequence bigint NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,id));
        CREATE TABLE IF NOT EXISTS bp_chat_messages(id text PRIMARY KEY,user_id text NOT NULL,conversation_id text NOT NULL,sequence bigint NOT NULL,role text NOT NULL,text text NOT NULL,kind text NOT NULL,command_id text,root_command_id text,revision integer,client_message_id text,payload_hash text,response_key text,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(user_id,conversation_id) REFERENCES bp_conversations(user_id,id),UNIQUE(user_id,conversation_id,sequence),UNIQUE(user_id,conversation_id,client_message_id),UNIQUE(user_id,command_id,response_key));
        CREATE TABLE IF NOT EXISTS bp_clarifications(id text PRIMARY KEY,user_id text NOT NULL,conversation_id text NOT NULL,parent_command_id text NOT NULL,root_command_id text NOT NULL,version integer NOT NULL DEFAULT 1,status text NOT NULL DEFAULT 'waiting',payload jsonb NOT NULL,resolved_by_command_id text,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(user_id,conversation_id) REFERENCES bp_conversations(user_id,id),UNIQUE(user_id,parent_command_id));
        CREATE INDEX IF NOT EXISTS bp_conversation_created_page ON bp_conversations(user_id,created_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS bp_chat_request_page ON bp_chat_messages(user_id,conversation_id,sequence DESC,command_id DESC) WHERE role='user' AND command_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS bp_clarification_waiting_page ON bp_clarifications(user_id,conversation_id,parent_command_id) WHERE status='waiting';`);
      await createSubscriptionContinuationStore(pool).migrate();
    },
    async create(actor: Actor, input: { title?: string } = {}): Promise<Conversation> {
      const title = input.title?.trim() || '新的聊天';
      if (title.length > 120) conflict('聊天标题过长');
      return conversationView((await pool.query('INSERT INTO bp_conversations(id,user_id,title) VALUES($1,$2,$3) RETURNING *', [randomUUID(), actor.userId, title])).rows[0]);
    },
    async list(actor: Actor, input: ConversationPageInput = {}): Promise<ConversationPage> {
      const limit = pageLimit(input.limit, 30), cursor = decodeCursor(input.cursor, actor, 'conversations');
      return transaction(async tx => {
        if (cursor && !(await tx.query('SELECT 1 FROM bp_conversations WHERE user_id=$1 AND id=$2', [actor.userId, cursor.anchorId])).rowCount) notFound();
        // The timestamp stays inside PostgreSQL: JS Date would truncate microseconds.
        const rows = (await tx.query(`SELECT * FROM bp_conversations WHERE user_id=$1
          AND ($2::text IS NULL OR (created_at,id)<(SELECT created_at,id FROM bp_conversations WHERE user_id=$1 AND id=$2))
          ORDER BY created_at DESC,id DESC LIMIT $3`, [actor.userId, cursor?.anchorId ?? null, limit + 1])).rows;
        const visible = rows.slice(0, limit);
        return { conversations: visible.map(conversationView), ...(rows.length > limit ? { nextCursor: encodeCursor({ v: 1, kind: 'conversations', userId: actor.userId, anchorId: visible.at(-1).id }) } : {}) };
      }, true);
    },
    async get(actor: Actor, cid: string): Promise<Conversation> { return conversationView(await owned(pool, actor, cid)); },
    async recovery(actor: Actor, cid: string, input: ConversationPageInput = {}): Promise<ConversationRecoveryPage> {
      const limit = pageLimit(input.limit, 20), cursor = decodeCursor(input.cursor, actor, 'recovery', cid);
      return transaction(async tx => {
        await owned(tx, actor, cid);
        // Start with indexed unfinished/waiting command IDs, not every completed message.
        // This bounds response size; it does not promise constant work for arbitrary histories.
        const eligible = `WITH eligible AS (
          SELECT command_id,user_message_id FROM bp_plan_commands WHERE user_id=$1 AND conversation_id=$2 AND status IN ('pending','running','failed')
          UNION
          SELECT c.command_id,c.user_message_id FROM bp_clarifications k JOIN bp_plan_commands c
            ON c.user_id=k.user_id AND c.conversation_id=k.conversation_id AND c.command_id=k.parent_command_id
            WHERE k.user_id=$1 AND k.conversation_id=$2 AND k.status='waiting'
        )`;
        const orphan = (await tx.query(`${eligible} SELECT e.command_id FROM eligible e LEFT JOIN bp_chat_messages m
          ON m.user_id=$1 AND m.conversation_id=$2 AND m.id=e.user_message_id AND (m.command_id=e.command_id OR EXISTS (SELECT 1 FROM bp_subscription_continuations sc WHERE sc.user_id=m.user_id AND sc.conversation_id=m.conversation_id AND sc.source_user_message_id=m.id AND sc.source_command_id=m.command_id AND sc.successor_command_id=e.command_id)) AND m.role='user'
          WHERE m.id IS NULL OR m.sequence<1 OR m.sequence>9007199254740991 LIMIT 1`, [actor.userId, cid])).rows[0];
        if (orphan) throw new CoreError('RECOVERY_REQUEST_SEQUENCE_UNAVAILABLE', `待恢复请求 ${String(orphan.command_id).slice(0, 200)} 缺少可验证的原始用户消息序号，请联系服务支持；系统未猜测序号或跳过该请求。`, 409);
        let anchorSequence: number | undefined;
        if (cursor) {
          const anchor = (await tx.query(`SELECT m.sequence FROM bp_plan_commands c JOIN bp_chat_messages m
            ON m.user_id=c.user_id AND m.conversation_id=c.conversation_id AND m.id=c.user_message_id
            WHERE c.user_id=$1 AND c.conversation_id=$2 AND c.command_id=$3 AND m.role='user'`, [actor.userId, cid, cursor.anchorId])).rows[0];
          if (!anchor) notFound(); anchorSequence = sequenceNumber(anchor.sequence);
        }
        const rows = (await tx.query(`${eligible} SELECT c.command_id,c.conversation_id,c.root_command_id,c.parent_command_id,c.revision,
          c.state_version,c.status,c.updated_at,c.created_at,c.last_error_code,
          c.planning_failure->'retryable' AS failure_retryable,left(c.original_message,240) AS message_preview,m.sequence,
          k.id AS clarification_id,k.version AS clarification_version,left(k.payload->>'question',500) AS question
          FROM eligible e JOIN bp_chat_messages m ON m.id=e.user_message_id JOIN bp_plan_commands c
            ON c.user_id=m.user_id AND c.conversation_id=m.conversation_id AND c.user_message_id=m.id AND c.command_id=e.command_id AND (c.command_id=m.command_id OR EXISTS (SELECT 1 FROM bp_subscription_continuations sc WHERE sc.user_id=m.user_id AND sc.conversation_id=m.conversation_id AND sc.source_user_message_id=m.id AND sc.source_command_id=m.command_id AND sc.successor_command_id=c.command_id))
          LEFT JOIN bp_clarifications k ON k.user_id=c.user_id AND k.conversation_id=c.conversation_id AND k.parent_command_id=c.command_id AND k.status='waiting'
          WHERE m.user_id=$1 AND m.conversation_id=$2 AND m.role='user' AND m.command_id IS NOT NULL
            AND ($3::bigint IS NULL OR (m.sequence,c.command_id)<($3,$4::text))
          ORDER BY m.sequence DESC,c.command_id DESC LIMIT $5`, [actor.userId, cid, anchorSequence ?? null, cursor?.anchorId ?? null, limit + 1])).rows;
        const visible = rows.slice(0, limit);
        const items: ConversationRecoveryItem[] = visible.map(row => {
          const expiry = new Date(new Date(row.updated_at).valueOf() + 240_000);
          return { commandId: row.command_id, conversationId: row.conversation_id, rootCommandId: row.root_command_id,
            ...(row.parent_command_id ? { parentCommandId: row.parent_command_id } : {}), revision: row.revision,
            requestSequence: sequenceNumber(row.sequence), stateVersion: String(row.state_version), status: row.status,
            retryable: row.status === 'pending' || (row.status === 'failed' && row.failure_retryable !== false) || (row.status === 'running' && expiry.valueOf() <= Date.now()),
            ...(row.status === 'running' ? { leaseExpiresAt: expiry.toISOString() } : {}), ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
            messagePreview: row.message_preview ?? '', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
            ...(row.clarification_id ? { clarification: { id: row.clarification_id, version: row.clarification_version, question: row.question ?? '' } } : {}) };
        });
        return { items, ...(rows.length > limit ? { nextCursor: encodeCursor({ v: 1, kind: 'recovery', userId: actor.userId, conversationId: cid, anchorId: visible.at(-1).command_id }) } : {}) };
      }, true);
    },
    async history(actor: Actor, cid: string, input: { beforeSequence?: number; limit?: number } = {}): Promise<ConversationHistory> {
      return transaction(async tx => {
      const conv = await owned(tx, actor, cid);
      const limit = pageLimit(input.limit, 50);
      if (!Number.isSafeInteger(limit) || (input.beforeSequence !== undefined && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1))) throw new CoreError('PAGINATION_INVALID', '分页参数不合法', 400);
      const rows = (await tx.query('SELECT * FROM bp_chat_messages WHERE user_id=$1 AND conversation_id=$2 AND ($3::bigint IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4', [actor.userId, cid, input.beforeSequence ?? null, limit + 1])).rows;
      const hasMore = rows.length > limit, visible = rows.slice(0, limit).reverse();
      const commands = (await tx.query(`SELECT c.*,m.sequence AS request_sequence FROM bp_plan_commands c
        LEFT JOIN bp_chat_messages m ON m.user_id=c.user_id AND m.conversation_id=c.conversation_id AND m.id=c.user_message_id
        WHERE c.user_id=$1 AND c.conversation_id=$2 AND c.command_id=ANY($3::text[]) ORDER BY m.sequence NULLS LAST,c.created_at,c.command_id`, [actor.userId, cid, [...new Set(visible.map(row => row.command_id).filter(Boolean))]])).rows;
      const clarifications = (await tx.query('SELECT * FROM bp_clarifications WHERE user_id=$1 AND conversation_id=$2 AND parent_command_id=ANY($3::text[]) ORDER BY created_at,id', [actor.userId, cid, commands.map(row => row.command_id)])).rows;
      const views: ConversationCommand[] = [];
      const clarificationByCommand = new Map(clarifications.map(row => [row.parent_command_id, row]));
      for (const row of commands) views.push(await commandView(tx, actor, row, { clarification: clarificationByCommand.get(row.command_id), requestSequence: row.request_sequence }));
      const commandRows = new Map(commands.map(row => [row.command_id, row]));
      const latestCommandId = (await tx.query(`SELECT c.command_id FROM bp_plan_commands c JOIN bp_chat_messages m ON m.user_id=c.user_id AND m.conversation_id=c.conversation_id AND m.id=c.user_message_id WHERE c.user_id=$1 AND c.conversation_id=$2 AND m.role='user' AND (c.command_id=m.command_id OR EXISTS (SELECT 1 FROM bp_subscription_continuations sc WHERE sc.user_id=m.user_id AND sc.source_user_message_id=m.id AND sc.source_command_id=m.command_id AND sc.successor_command_id=c.command_id)) ORDER BY m.sequence DESC,c.revision DESC,c.created_at DESC LIMIT 1`, [actor.userId, cid])).rows[0]?.command_id;
      return { conversation: conversationView(conv), ...(latestCommandId ? { latestCommandId } : {}), messages: visible.map(row => ({ ...messageView(row), text: presentStoredResultText(row, commandRows.get(row.command_id), actor.userId) })), commands: views, clarifications: clarifications.map(clarificationView), ...(hasMore ? { nextBeforeSequence: sequenceNumber(visible[0].sequence) } : {}) };
      }, true);
    },
    async getCommand(actor: Actor, cid: string, commandId: string): Promise<ConversationCommand> {
      return transaction(async tx => {
        await owned(tx, actor, cid);
        const row = (await tx.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND conversation_id=$2 AND command_id=$3', [actor.userId, cid, commandId])).rows[0];
        if (!row) notFound(); return commandView(tx, actor, row);
      }, true);
    },
    async accept(actor: Actor, cid: string, raw: ConversationMessageInput): Promise<AcceptedConversationMessage> {
      const input = conversationMessageSchema.parse(raw), payloadHash = digest(stable(input));
      await owned(pool, actor, cid);
      const saved = (await pool.query('SELECT * FROM bp_chat_messages WHERE user_id=$1 AND conversation_id=$2 AND client_message_id=$3', [actor.userId, cid, input.clientMessageId])).rows[0];
      if (saved) {
        if (saved.payload_hash !== payloadHash) conflict('同一消息编号不能用于不同内容');
        const command = (await pool.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND conversation_id=$2 AND command_id=$3', [actor.userId, cid, saved.command_id])).rows[0];
        if (!command) notFound(); return { message: messageView(saved), command: await commandView(pool, actor, command), replayed: true };
      }
      // Fetch authoritative candidates outside the transaction; never hold a DB
      // row lock across a service/model call. Recheck candidate IDs when merging.
      const payees = input.clarificationId ? await options.getPayees?.(actor) : undefined;
      return transaction(async tx => {
        await owned(tx, actor, cid, true);
        const previous = (await tx.query('SELECT * FROM bp_chat_messages WHERE user_id=$1 AND conversation_id=$2 AND client_message_id=$3', [actor.userId, cid, input.clientMessageId])).rows[0];
        if (previous) {
          if (previous.payload_hash !== payloadHash) conflict('同一消息编号不能用于不同内容');
          const command = (await tx.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND conversation_id=$2 AND command_id=$3', [actor.userId, cid, previous.command_id])).rows[0];
          if (!command) notFound(); return { message: messageView(previous), command: await commandView(tx, actor, command), replayed: true };
        }
        const commandId = randomUUID(), messageId = randomUUID();
        let rootCommandId = commandId, revision = 0, parentCommandId: string | undefined;
        let planningInput: ConversationPlanningInput = { version: 1, message: input.text, originalMessage: input.text };
        if (input.clarificationId) {
          const row = (await tx.query('SELECT * FROM bp_clarifications WHERE user_id=$1 AND conversation_id=$2 AND id=$3 FOR UPDATE', [actor.userId, cid, input.clarificationId])).rows[0];
          if (!row) notFound();
          if (row.status !== 'waiting' || row.version !== input.expectedClarificationVersion) conflict('澄清已更新或关闭，请加载当前请求');
          const parent = (await tx.query('SELECT * FROM bp_plan_commands WHERE user_id=$1 AND conversation_id=$2 AND command_id=$3', [actor.userId, cid, row.parent_command_id])).rows[0];
          if (!parent || parent.status !== 'complete' || hasPlannedActions(parent.result) || hasPlannedActions(parent.proposal)) conflict('已有动作或尚未完成的请求不能通过澄清生成新版本');
          if (!payees) throw new CoreError('CLARIFICATION_UNAVAILABLE', '当前无法核对有效收款人', 503);
          planningInput = mergeClarification(clarificationView(row), input.answer, input.text, messageId, payees, parent.original_message);
          rootCommandId = parent.root_command_id; revision = parent.revision + 1; parentCommandId = parent.command_id;
          const updated = await tx.query("UPDATE bp_clarifications SET status='resolved',version=version+1,resolved_by_command_id=$5 WHERE user_id=$1 AND conversation_id=$2 AND id=$3 AND version=$4 AND status='waiting' RETURNING id", [actor.userId, cid, row.id, input.expectedClarificationVersion, commandId]);
          if (!updated.rowCount) conflict('澄清已由其他回答完成');
          // The trigger advances the parent observation version. Do not renew updated_at/lease.
          await tx.query('UPDATE bp_plan_commands SET state_version=state_version WHERE user_id=$1 AND conversation_id=$2 AND command_id=$3', [actor.userId, cid, parent.command_id]);
        }
        const message = await append(tx, actor, cid, { id: messageId, role: 'user', text: input.text, kind: parentCommandId ? 'answer' : 'request', commandId, rootCommandId, revision, clientMessageId: input.clientMessageId, payloadHash });
        const command = (await tx.query(`INSERT INTO bp_plan_commands(user_id,command_id,message_hash,status,conversation_id,user_message_id,original_message,planning_input,root_command_id,parent_command_id,revision) VALUES($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [actor.userId, commandId, digest(planningInput.message), cid, messageId, planningInput.originalMessage, JSON.stringify(planningInput), rootCommandId, parentCommandId ?? null, revision])).rows[0];
        return { message, command: await commandView(tx, actor, command), replayed: false };
      });
    },
    async cancelClarification(actor: Actor, cid: string, id: string, expectedVersion: number): Promise<Clarification> {
      return transaction(async tx => {
        await owned(tx, actor, cid, true);
        const row = (await tx.query('SELECT * FROM bp_clarifications WHERE user_id=$1 AND conversation_id=$2 AND id=$3 FOR UPDATE', [actor.userId, cid, id])).rows[0];
        if (!row) notFound();
        if (row.status === 'cancelled' && row.version === expectedVersion + 1) return clarificationView(row);
        if (row.status !== 'waiting' || row.version !== expectedVersion) conflict('澄清已更新或关闭');
        const updated = (await tx.query("UPDATE bp_clarifications SET status='cancelled',version=version+1 WHERE user_id=$1 AND id=$2 RETURNING *", [actor.userId, id])).rows[0];
        // Clarification and its parent evidence become newer atomically, without lease renewal.
        await tx.query('UPDATE bp_plan_commands SET state_version=state_version WHERE user_id=$1 AND conversation_id=$2 AND command_id=$3', [actor.userId, cid, row.parent_command_id]);
        await append(tx, actor, cid, { role: 'assistant', text: '已关闭这次字段补充；没有取消或授权任何银行动作。', kind: 'cancellation', commandId: row.parent_command_id, rootCommandId: row.root_command_id, responseKey: `cancel:${id}` });
        return clarificationView(updated);
      });
    },
    async onComplete(tx: PoolClient, actor: Actor, commandId: string, leaseToken: string, envelope: ConversationEnvelope, preparedInput?: PlannerInput) {
      const row = (await tx.query("SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2 AND lease_token=$3 AND status='complete'", [actor.userId, commandId, leaseToken])).rows[0];
      if (!row) throw new CoreError('PLAN_SUPERSEDED', '此规划已被其他恢复请求接管', 409);
      if (!row.conversation_id) return;
      await owned(tx, actor, row.conversation_id, true);
      const seed = preparedInput ? buildClarification(preparedInput, envelope, row.user_message_id) : undefined;
      if (seed) await tx.query('INSERT INTO bp_clarifications(id,user_id,conversation_id,parent_command_id,root_command_id,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,parent_command_id) DO NOTHING', [randomUUID(), actor.userId, row.conversation_id, commandId, row.root_command_id, JSON.stringify(seed)]);
      if (envelope.clarification && !seed && !hasPlannedActions(envelope)) {
        const note = '此类请求请完整重述，不能用简短字段续接。';
        if (!envelope.clarification.includes(note)) envelope.clarification += ` ${note}`;
        await tx.query('UPDATE bp_plan_commands SET result=$4 WHERE user_id=$1 AND command_id=$2 AND lease_token=$3', [actor.userId, commandId, leaseToken, JSON.stringify(envelope)]);
      }
      await append(tx, actor, row.conversation_id, { role: 'assistant', text: formatConversationResultText(envelope), kind: 'result', commandId, rootCommandId: row.root_command_id, revision: row.revision, responseKey: 'final' });
    },
    async onFailure(tx: PoolClient, actor: Actor, commandId: string, leaseToken: string, errorCode: string) {
      const row = (await tx.query("SELECT * FROM bp_plan_commands WHERE user_id=$1 AND command_id=$2 AND lease_token=$3 AND status='failed'", [actor.userId, commandId, leaseToken])).rows[0];
      if (!row || !row.conversation_id) return;
      const safeCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode) ? errorCode : 'PLAN_FAILED';
      await tx.query('UPDATE bp_plan_commands SET last_error_code=$3 WHERE user_id=$1 AND command_id=$2 AND lease_token=$4', [actor.userId, commandId, safeCode, leaseToken]);
      await append(tx, actor, row.conversation_id, { role: 'assistant', text: row.planning_failure?.message ?? '这次规划未完成，可以重试原请求。尚未授权或执行任何新动作。', kind: 'failure', commandId, rootCommandId: row.root_command_id, revision: row.revision, responseKey: `failure:${leaseToken}` });
    },
  };
}
export type ConversationService = ReturnType<typeof createConversationService>;
