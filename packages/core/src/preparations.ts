import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { createGoalInputSchema, managementInputSchema, redemptionInputSchema, replanGoalInputSchema,
  type Actor, type PreparationFamily, type PreparationOperation, type PreparationRequest, type PreparationService } from '../../contracts/src/index.js';
import { CoreError } from './errors.js';
import { withTransaction } from './database.js';

type Options = { schema?: string; clock?: () => Date };
type Row = Record<string, any>;
const schemaName = (options: Options) => {
  const schema = options.schema ?? 'bankpilot_core';
  if (!/^[a-z_][a-z0-9_]{0,47}$/.test(schema)) throw new Error('Invalid preparation schema');
  return `"${schema}"`;
};
const owner = (actor: Actor) => {
  if (!actor?.userId || typeof actor.userId !== 'string') throw new CoreError('UNAUTHENTICATED', '请先登录', 401);
  return actor.userId;
};
export const preparationFamilySchema = z.enum(['management', 'investment', 'goal']);
const commandSchema = z.string().min(8).max(128);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
export function normalizedPreparationInput(operation: PreparationOperation, input: unknown): Record<string, unknown> {
  if (operation === 'management') {
    const data = managementInputSchema.parse(input);
    if (data.spec.kind === 'CONTACT_ALIAS_SAVE') {
      data.spec.alias = data.spec.alias.normalize('NFKC').trim();
      if (!data.spec.alias || data.spec.alias.length > 40 || /\p{C}/u.test(data.spec.alias)) throw new CoreError('INVALID_INPUT', '别名格式无效', 400);
    }
    return data;
  }
  if (operation === 'redemption') return redemptionInputSchema.parse(input);
  if (operation === 'goal-create') return createGoalInputSchema.parse(input);
  const { goalId, ...rest } = z.object({ goalId: z.string().min(1) }).passthrough().parse(input);
  return { goalId, ...replanGoalInputSchema.parse(rest) };
}
const familyFor = (operation: PreparationOperation): PreparationFamily => operation === 'management' ? 'management' : operation === 'redemption' ? 'investment' : 'goal';
const view = (row: Row): PreparationRequest => ({
  family: row.family, commandId: row.command_id, operation: row.operation, input: row.input, state: row.state,
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  ...(row.result_id ? { resultId: row.result_id } : {}), ...(row.last_error ? { lastError: row.last_error } : {}),
});
export function preparationRequestsMigration(schema = 'bankpilot_core'): string {
  const s = schemaName({ schema });
  return `CREATE TABLE IF NOT EXISTS ${s}.preparation_requests(
    id text PRIMARY KEY,user_id text NOT NULL,family text NOT NULL CHECK(family IN ('management','investment','goal')),
    command_id text NOT NULL,operation text CHECK(operation IN ('management','redemption','goal-create','goal-replan')),
    input jsonb,input_hash text,state text NOT NULL CHECK(state IN ('PENDING','PREPARED','ABANDONED')),
    result_id text,last_error jsonb,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
    UNIQUE(user_id,family,command_id),CHECK((operation IS NULL AND input IS NULL AND input_hash IS NULL) OR (operation IS NOT NULL AND input IS NOT NULL AND input_hash IS NOT NULL)),
    CHECK(state<>'PREPARED' OR result_id IS NOT NULL));
    CREATE INDEX IF NOT EXISTS preparation_requests_owner_page_idx ON ${s}.preparation_requests(user_id,created_at DESC,id DESC);`;
}
export async function migratePreparationRequests(pool: Pool, options: Options = {}): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName(options)};${preparationRequestsMigration(options.schema)}`);
}
export async function assertPreparationRequestsReady(pool: Pool, options: Options = {}): Promise<void> {
  try { await pool.query(`SELECT id,user_id,family,command_id,operation,input,input_hash,state,result_id,last_error,created_at,updated_at FROM ${schemaName(options)}.preparation_requests LIMIT 0`); }
  catch { throw new CoreError('PREPARATIONS_NOT_MIGRATED', '准备请求登记尚未初始化，请先运行数据库迁移', 503); }
}
/** The caller's business transaction holds this row through its candidate commit.
 * A session/API lock on another connection cannot provide this crash-safe fence. */
export async function lockPreparationRequest(tx: PoolClient, schema: string, userId: string, family: PreparationFamily, operation: PreparationOperation, raw: unknown, at: Date): Promise<void> {
  const s = schemaName({ schema }), input = normalizedPreparationInput(operation, raw), commandId = commandSchema.parse(input.commandId);
  if (familyFor(operation) !== family) throw new CoreError('INVALID_INPUT', '准备请求类型不匹配', 400);
  await tx.query(`INSERT INTO ${s}.preparation_requests(id,user_id,family,command_id,operation,input,input_hash,state,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$8) ON CONFLICT(user_id,family,command_id) DO NOTHING`,
  [randomUUID(), userId, family, commandId, operation, JSON.stringify(input), fingerprint({ operation, input }), at]);
  const row = (await tx.query(`SELECT * FROM ${s}.preparation_requests WHERE user_id=$1 AND family=$2 AND command_id=$3 FOR UPDATE`, [userId, family, commandId])).rows[0];
  if (row.state === 'ABANDONED') throw new CoreError('PREPARATION_ABANDONED', '此准备请求已放弃，请使用新的指令编号', 409);
  if (row.input_hash !== null && row.input_hash !== fingerprint({ operation, input })) throw new CoreError('IDEMPOTENCY_CONFLICT', '相同指令编号不能修改准备参数', 409);
  // Validate legacy mappings before accepting a new payload. Otherwise a changed
  // payload could be retained as PENDING and later masquerade as the old result.
  const table = family === 'management' ? 'management_actions' : family === 'investment' ? 'investment_actions' : 'goal_commands';
  const relation = (await tx.query('SELECT to_regclass($1) AS relation', [`${s}.${table}`])).rows[0].relation;
  const legacy = relation ? (await tx.query(`SELECT input_hash,${family === 'goal' ? 'goal_id' : 'id'} AS result_id FROM ${s}.${table} WHERE user_id=$1 AND command_id=$2`, [userId, commandId])).rows[0] : undefined;
  if (legacy) {
    const { goalId, ...replan } = input;
    const legacyHash = fingerprint(operation === 'management' ? { spec: input.spec, taskId: input.taskId ?? null }
      : operation === 'goal-replan' ? { id: goalId, ...replan } : input);
    if (legacy.input_hash !== legacyHash) throw new CoreError('IDEMPOTENCY_CONFLICT', '相同指令编号不能修改原准备参数', 409);
    if (row.input_hash === null) await tx.query(`UPDATE ${s}.preparation_requests SET operation=$4,input=$5,input_hash=$6 WHERE user_id=$1 AND family=$2 AND command_id=$3`,
      [userId, family, commandId, operation, JSON.stringify(input), fingerprint({ operation, input })]);
    if (row.state !== 'PREPARED') await markPreparationPrepared(tx, schema, userId, family, commandId, legacy.result_id, at);
  } else if (row.input_hash === null) throw new CoreError('IDEMPOTENCY_CONFLICT', '原准备请求缺少可核验参数', 409);
}
export async function markPreparationPrepared(tx: PoolClient, schema: string, userId: string, family: PreparationFamily, commandId: string, resultId: string, at: Date): Promise<void> {
  const s = schemaName({ schema });
  const row = (await tx.query(`SELECT state,result_id FROM ${s}.preparation_requests WHERE user_id=$1 AND family=$2 AND command_id=$3 FOR UPDATE`, [userId, family, commandId])).rows[0];
  if (!row || row.state === 'ABANDONED') throw new CoreError('PREPARATION_ABANDONED', '此准备请求已放弃', 409);
  if (row.result_id && row.result_id !== resultId) throw new CoreError('IDEMPOTENCY_CONFLICT', '原准备请求不能绑定其他结果', 409);
  // Replaying the same committed mapping is a read. In particular, time passing
  // must not change its timestamp, error state, or recovery ordering.
  if (row.state === 'PREPARED') return;
  await tx.query(`UPDATE ${s}.preparation_requests SET state='PREPARED',result_id=$4,last_error=NULL,updated_at=$5
    WHERE user_id=$1 AND family=$2 AND command_id=$3`, [userId, family, commandId, resultId, at]);
}
export function createPreparations(pool: Pool, options: Options = {}): PreparationService {
  const s = schemaName(options), schema = options.schema ?? 'bankpilot_core', clock = options.clock ?? (() => new Date());
  const read = async (db: Pool | PoolClient, userId: string, family: PreparationFamily, commandId: string, lock = false) => {
    preparationFamilySchema.parse(family); commandSchema.parse(commandId);
    const row = (await db.query(`SELECT * FROM ${s}.preparation_requests WHERE user_id=$1 AND family=$2 AND command_id=$3${lock ? ' FOR UPDATE' : ''}`, [userId, family, commandId])).rows[0];
    if (!row) throw new CoreError('PREPARATION_NOT_FOUND', '准备请求不存在', 404);
    return row;
  };
  return {
    migrate: () => migratePreparationRequests(pool, options), assertReady: () => assertPreparationRequestsReady(pool, options),
    async accept(actor, request) {
      const userId = owner(actor);
      return withTransaction(pool, async tx => {
        await lockPreparationRequest(tx, schema, userId, request.family, request.operation, request.input, clock());
        return view(await read(tx, userId, request.family, String(request.input.commandId)));
      });
    },
    async get(actor, family, commandId) { return view(await read(pool, owner(actor), family, commandId)); },
    async list(actor, options = {}) {
      const userId = owner(actor), limit = z.number().int().min(1).max(100).parse(options.limit ?? 20);
      let cursor: { owner: string; at: string; id: string } | undefined;
      if (options.cursor) {
        try {
          cursor = z.object({ owner: z.string(), at: z.iso.datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')));
          if (cursor.owner !== userId) throw new Error('owner');
        } catch { throw new CoreError('INVALID_CURSOR', '准备请求分页游标无效', 400); }
      }
      const rows = (await pool.query(`SELECT * FROM ${s}.preparation_requests WHERE user_id=$1${cursor ? ' AND (created_at,id)<($3::timestamptz,$4)' : ''} ORDER BY created_at DESC,id DESC LIMIT $2`,
        cursor ? [userId, limit + 1, cursor.at, cursor.id] : [userId, limit + 1])).rows;
      const hasMore = rows.length > limit, selected = rows.slice(0, limit), last = selected.at(-1);
      return { requests: selected.map(view), ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ owner: userId, at: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url') } : {}) };
    },
    async abandon(actor, family, commandId) {
      const userId = owner(actor); preparationFamilySchema.parse(family); commandSchema.parse(commandId);
      return withTransaction(pool, async tx => {
        await tx.query(`INSERT INTO ${s}.preparation_requests(id,user_id,family,command_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,'ABANDONED',$5,$5) ON CONFLICT(user_id,family,command_id) DO NOTHING`, [randomUUID(), userId, family, commandId, clock()]);
        const row = await read(tx, userId, family, commandId, true);
        // The mapping check adopts commands prepared before this additive ledger existed.
        // The same row lock excludes every new candidate commit while this decision is made.
        const table = family === 'management' ? 'management_actions' : family === 'investment' ? 'investment_actions' : 'goal_commands';
        const exists = await tx.query('SELECT to_regclass($1) AS relation', [`${s}.${table}`]);
        const domain = exists.rows[0].relation ? (await tx.query(`SELECT ${family === 'goal' ? 'goal_id' : 'id'} AS result_id FROM ${s}.${table} WHERE user_id=$1 AND command_id=$2`, [userId, commandId])).rows[0] : undefined;
        if (domain) {
          await tx.query(`UPDATE ${s}.preparation_requests SET state='PREPARED',result_id=$4,last_error=NULL,updated_at=$5 WHERE user_id=$1 AND family=$2 AND command_id=$3`, [userId, family, commandId, domain.result_id, clock()]);
        } else if (row.state !== 'PREPARED') {
          await tx.query(`UPDATE ${s}.preparation_requests SET state='ABANDONED',updated_at=$4 WHERE user_id=$1 AND family=$2 AND command_id=$3`, [userId, family, commandId, clock()]);
        }
        return view(await read(tx, userId, family, commandId));
      });
    },
    async recordFailure(actor, family, commandId, error) {
      // Do not let an earlier failing request overwrite a concurrent successful or abandoned outcome.
      await pool.query(`UPDATE ${s}.preparation_requests SET last_error=$4,updated_at=$5 WHERE user_id=$1 AND family=$2 AND command_id=$3 AND state='PENDING'`,
        [owner(actor), family, commandId, JSON.stringify({ code: error.code.slice(0, 80), message: error.message.slice(0, 240) }), clock()]);
    },
  };
}
