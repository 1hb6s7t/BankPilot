import { withDatabaseClient, withTransaction } from '../../core/src/database.js';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Pool } from 'pg';

/**
 * G8B foundation: bind each PostgresSaver thread to one immutable command
 * attempt, then fence every checkpoint and pending-write transaction against
 * the command journal row. The production planner uses this path only when the
 * explicit checkpoint-recovery feature flag is enabled.
 */
export type CheckpointJournalIdentity = {
  userId: string;
  commandId: string;
  rootCommandId: string | null;
  revision: number;
  leaseToken: string;
  graphVersion: string;
  graphSchemaVersion: string;
  inputDigest: string;
};

export type CheckpointSchemaOptions = {
  /** Fixed application schema. Never derive this from a user or request. */
  checkpointSchema: string;
  /** Schema containing bp_plan_commands; fixed by the application. */
  journalSchema: string;
  /** Test-only lock barrier, used to make lease races reproducible. */
  testLockDelayMs?: number;
};

/** @internal Test-only pause point for proving transfer transaction crash atomicity. */
export type CheckpointTransferTestHooks = {
  beforePointerUpdate?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
};

const CHECKPOINT_FENCING_SCHEMA_VERSION = 5;

const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Unsafe PostgreSQL schema identifier');
  return `"${value}"`;
};

/** Resolve the unqualified journal table's schema using the same search_path as the API pool. */
export async function currentJournalSchema(pool: Pool): Promise<string> {
  const schema = (await pool.query<{ schema_name: string | null }>(`SELECT n.nspname AS schema_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.oid=to_regclass('bp_plan_commands') AND c.relkind IN ('r','p')`)).rows[0]?.schema_name;
  if (!schema) throw new Error('Could not resolve bp_plan_commands in the active PostgreSQL search_path; run pnpm setup');
  identifier(schema);
  return schema;
}

/** Fail closed at API startup when setup has not installed saver tables and journal-write fences. */
export async function assertCheckpointFencingReady(pool: Pool, options: CheckpointSchemaOptions): Promise<void> {
  const checkpointSchema = identifier(options.checkpointSchema);
  identifier(options.journalSchema);
  const row = (await pool.query<{
    journal_table: boolean; attempts_table: boolean; checkpoints_table: boolean;
    pending_writes_table: boolean; blobs_table: boolean; transfers_table: boolean; fencing_config_table: boolean;
    journal_columns: boolean; fence_function: boolean; fence_triggers: boolean; blob_write_function: boolean; blob_write_trigger: boolean;
    delete_function: boolean; delete_triggers: boolean; attempt_lease_index: boolean;
  }>(`
    SELECT
      to_regclass(format('%I.%I',$1::text,'bp_plan_commands')) IS NOT NULL AS journal_table,
      to_regclass(format('%I.%I',$2::text,'bp_checkpoint_attempts')) IS NOT NULL AS attempts_table,
      to_regclass(format('%I.%I',$2::text,'checkpoints')) IS NOT NULL AS checkpoints_table,
      to_regclass(format('%I.%I',$2::text,'checkpoint_writes')) IS NOT NULL AS pending_writes_table,
      to_regclass(format('%I.%I',$2::text,'checkpoint_blobs')) IS NOT NULL AS blobs_table,
      to_regclass(format('%I.%I',$2::text,'bp_checkpoint_transfers')) IS NOT NULL AS transfers_table,
      to_regclass(format('%I.%I',$2::text,'bp_checkpoint_fencing_config')) IS NOT NULL AS fencing_config_table,
      (SELECT count(*)=12 FROM pg_attribute a
        WHERE a.attrelid=to_regclass(format('%I.%I',$1::text,'bp_plan_commands')) AND NOT a.attisdropped
          AND a.attname::text=ANY(ARRAY['user_id','command_id','root_command_id','revision','lease_token','status','graph_version','graph_schema_version','graph_input_digest','graph_checkpoint_thread_id','graph_checkpoint_ns','graph_checkpoint_id']::text[])) AS journal_columns,
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$2::text AND p.proname='bp_fence_checkpoint_write'
          AND position($1::text in pg_get_functiondef(p.oid)) > 0
          AND position('bp_checkpoint_transfers' in pg_get_functiondef(p.oid)) > 0) AS fence_function,
      (SELECT count(*)=2 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
        WHERE n.nspname=$2::text AND pn.nspname=$2::text AND p.proname='bp_fence_checkpoint_write'
          AND t.tgenabled IN ('O','A') AND t.tgtype=23 AND NOT t.tgisinternal
          AND ((c.relname='checkpoints' AND t.tgname='bp_fence_checkpoint_write')
            OR (c.relname='checkpoint_writes' AND t.tgname='bp_fence_checkpoint_pending_write'))) AS fence_triggers,
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$2::text AND p.proname='bp_fence_checkpoint_blob_write'
          AND position(quote_literal($1::text) in pg_get_functiondef(p.oid)) > 0) AS blob_write_function,
      (SELECT count(*)=1 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
        WHERE n.nspname=$2::text AND pn.nspname=$2::text AND p.proname='bp_fence_checkpoint_blob_write'
          AND t.tgenabled IN ('O','A') AND t.tgtype=23 AND NOT t.tgisinternal
          AND c.relname='checkpoint_blobs' AND t.tgname='bp_fence_checkpoint_blob_write') AS blob_write_trigger,
      EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=$2::text AND p.proname='bp_block_checkpoint_delete'
          AND position('BP_CHECKPOINT_DELETE_DISABLED' in pg_get_functiondef(p.oid)) > 0
          AND position($1::text in pg_get_functiondef(p.oid)) > 0
          AND position('graph_checkpoint_thread_id' in pg_get_functiondef(p.oid)) > 0) AS delete_function,
      (SELECT count(*)=3 FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
        WHERE n.nspname=$2::text AND pn.nspname=$2::text AND p.proname='bp_block_checkpoint_delete'
          AND t.tgenabled IN ('O','A') AND t.tgtype=11 AND NOT t.tgisinternal
          AND ((c.relname='checkpoints' AND t.tgname='bp_block_checkpoint_delete')
            OR (c.relname='checkpoint_blobs' AND t.tgname='bp_block_checkpoint_blob_delete')
            OR (c.relname='checkpoint_writes' AND t.tgname='bp_block_checkpoint_write_delete'))) AS delete_triggers,
      EXISTS (SELECT 1 FROM pg_index i
        JOIN pg_class table_rel ON table_rel.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=table_rel.relnamespace
        JOIN pg_class index_rel ON index_rel.oid=i.indexrelid
        WHERE n.nspname=$2::text AND table_rel.relname='bp_checkpoint_attempts'
          AND index_rel.relname='bp_checkpoint_attempts_one_thread_per_lease'
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
          AND (SELECT array_agg(attribute.attname::text ORDER BY key.ordinality)
            FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
            JOIN pg_attribute attribute ON attribute.attrelid=i.indrelid AND attribute.attnum=key.attnum)
            = ARRAY['user_id','command_id','revision','lease_token']::text[]) AS attempt_lease_index
  `, [options.journalSchema, options.checkpointSchema])).rows[0];
  if (!row || Object.values(row).some(value => value !== true)) {
    throw new Error('Checkpoint fencing is not ready; run pnpm setup before starting the API');
  }
  const configMatches = (await pool.query(`SELECT EXISTS (SELECT 1 FROM ${checkpointSchema}.bp_checkpoint_fencing_config
    WHERE singleton AND journal_schema=$1 AND migration_version=$2) AS ready`, [options.journalSchema, CHECKPOINT_FENCING_SCHEMA_VERSION])).rows[0]?.ready;
  if (configMatches !== true) throw new Error('Checkpoint fencing is not ready; run pnpm setup before starting the API');
}

function checkIdentity(identity: CheckpointJournalIdentity) {
  if (!identity.userId || !identity.commandId || !identity.leaseToken || !identity.graphVersion || !identity.graphSchemaVersion || !/^[a-f0-9]{64}$/.test(identity.inputDigest)) {
    throw new Error('Invalid checkpoint attempt identity');
  }
  if (!Number.isSafeInteger(identity.revision) || identity.revision < 0) throw new Error('Invalid checkpoint revision');
}

const checkpointSetupFlights = new WeakMap<Pool, Map<string, Promise<PostgresSaver>>>();
const checkpointSetupTails = new WeakMap<Pool, Promise<PostgresSaver>>();

/** Coalesce same-process setup calls before they can consume the pool connections needed by saver.setup(). */
export function setupCheckpointFencing(pool: Pool, options: CheckpointSchemaOptions): Promise<PostgresSaver> {
  const checkpointSchema = identifier(options.checkpointSchema);
  const journalSchema = identifier(options.journalSchema);
  const flightKey = `${checkpointSchema}:${journalSchema}:${options.testLockDelayMs ?? 0}`;
  let poolFlights = checkpointSetupFlights.get(pool);
  if (!poolFlights) {
    poolFlights = new Map();
    checkpointSetupFlights.set(pool, poolFlights);
  }
  const currentFlight = poolFlights.get(flightKey);
  if (currentFlight) return currentFlight;

  // Serialize all schemas on this pool: two different schema locks can otherwise
  // occupy a max:2 pool and leave neither saver.setup() a free connection.
  const previous = checkpointSetupTails.get(pool);
  const run = () => setupCheckpointFencingLocked(pool, options);
  const operation = previous ? previous.then(run, run) : Promise.resolve().then(run);
  const tracked = operation.finally(() => {
    if (poolFlights?.get(flightKey) === tracked) poolFlights.delete(flightKey);
    if (poolFlights?.size === 0) checkpointSetupFlights.delete(pool);
    if (checkpointSetupTails.get(pool) === tracked) checkpointSetupTails.delete(pool);
  });
  poolFlights.set(flightKey, tracked);
  checkpointSetupTails.set(pool, tracked);
  return tracked;
}

/** Run once during application startup after journal migrations. */
async function setupCheckpointFencingLocked(pool: Pool, options: CheckpointSchemaOptions): Promise<PostgresSaver> {
  const checkpointSchema = identifier(options.checkpointSchema);
  const journalSchema = identifier(options.journalSchema);
  if (pool.options.max < 2) throw new Error('Checkpoint setup requires a PostgreSQL pool with max >= 2');
  const configTableExists = (await pool.query<{ exists: boolean }>(
    `SELECT to_regclass(format('%I.%I',$1::text,'bp_checkpoint_fencing_config')) IS NOT NULL AS exists`,
    [options.checkpointSchema],
  )).rows[0]?.exists;
  if (configTableExists) {
    const currentConfig = (await pool.query<{ migration_version: number; journal_schema: string }>(
      `SELECT migration_version,journal_schema FROM ${checkpointSchema}.bp_checkpoint_fencing_config WHERE singleton`,
    )).rows[0];
    if (currentConfig && currentConfig.journal_schema !== options.journalSchema) {
      throw new Error('BP_CHECKPOINT_JOURNAL_SCHEMA_MISMATCH');
    }
    if (currentConfig && currentConfig.migration_version > CHECKPOINT_FENCING_SCHEMA_VERSION) {
      throw new Error('BP_CHECKPOINT_SCHEMA_NEWER_THAN_CODE');
    }
  }
  const checkpointSchemaLiteral = `'${options.checkpointSchema}'`;
  const journalSchemaLiteral = `'${options.journalSchema}'`;
  const delay = options.testLockDelayMs ?? 0;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 1000) throw new Error('Invalid test lock delay');
  const testDelay = delay ? `PERFORM pg_sleep(${delay} / 1000.0);` : '';
  const saver = new PostgresSaver(pool, undefined, { schema: options.checkpointSchema });
  return withDatabaseClient(pool, async (migrationClient, connection) => {
  const migrationLockKey = `bankpilot_checkpoint_setup:${options.checkpointSchema}`;
  let migrationLockHeld = false;
  let migrationFailed = false;
  try {
    try {
      await migrationClient.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [migrationLockKey]);
    } catch (error) {
      // PostgreSQL may have acquired this session lock even when its reply was lost.
      // Discard the connection instead of returning a potentially locked session to the pool.
      connection.discard(error instanceof Error ? error : new Error('CHECKPOINT_MIGRATION_LOCK_FAILED'));
      throw error;
    }
    migrationLockHeld = true;
    const configNowExists = (await migrationClient.query<{ exists: boolean }>(
      `SELECT to_regclass(format('%I.%I',$1::text,'bp_checkpoint_fencing_config')) IS NOT NULL AS exists`,
      [options.checkpointSchema],
    )).rows[0]?.exists;
    if (configNowExists) {
      const currentConfig = (await migrationClient.query<{ migration_version: number; journal_schema: string }>(
        `SELECT migration_version,journal_schema FROM ${checkpointSchema}.bp_checkpoint_fencing_config WHERE singleton`,
      )).rows[0];
      if (currentConfig && currentConfig.journal_schema !== options.journalSchema) {
        throw new Error('BP_CHECKPOINT_JOURNAL_SCHEMA_MISMATCH');
      }
      if (currentConfig && currentConfig.migration_version > CHECKPOINT_FENCING_SCHEMA_VERSION) {
        throw new Error('BP_CHECKPOINT_SCHEMA_NEWER_THAN_CODE');
      }
    }
    // Serialize LangGraph's own read-version/create-tables/insert-version migrations as well as our fences.
    await saver.setup();
    await migrationClient.query(`
    CREATE TABLE IF NOT EXISTS ${checkpointSchema}.bp_checkpoint_fencing_config (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      journal_schema text NOT NULL,
      migration_version integer NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${checkpointSchema}.bp_checkpoint_attempts (
      thread_id text PRIMARY KEY,
      user_id text NOT NULL,
      command_id text NOT NULL,
      root_command_id text,
      revision integer NOT NULL,
      lease_token uuid NOT NULL,
      graph_version text NOT NULL,
      graph_schema_version text NOT NULL,
      input_digest text NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ${checkpointSchema}.bp_checkpoint_transfers (
      target_thread_id text PRIMARY KEY,
      source_thread_id text NOT NULL,
      source_checkpoint_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS bp_checkpoint_attempts_one_thread_per_lease
      ON ${checkpointSchema}.bp_checkpoint_attempts (user_id, command_id, revision, lease_token);

    CREATE OR REPLACE FUNCTION ${checkpointSchema}.bp_fence_checkpoint_write()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE
      attempt ${checkpointSchema}.bp_checkpoint_attempts%ROWTYPE;
      matched integer;
    BEGIN
      SELECT * INTO attempt
      FROM ${checkpointSchema}.bp_checkpoint_attempts
      WHERE thread_id = NEW.thread_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'BP_CHECKPOINT_ATTEMPT_UNKNOWN' USING ERRCODE = '40001';
      END IF;
      IF NEW.checkpoint_ns <> '' THEN
        RAISE EXCEPTION 'BP_CHECKPOINT_NAMESPACE_NOT_ALLOWED' USING ERRCODE = '40001';
      END IF;

      /*
       * This lock is held through the enclosing PostgresSaver put/putWrites
       * transaction. Lease takeover updates the same journal row, so whichever
       * operation gets the row lock first commits before the other may proceed.
       */
      EXECUTE format(
        'SELECT 1 FROM %I.bp_plan_commands WHERE user_id=$1 AND command_id=$2 AND root_command_id IS NOT DISTINCT FROM $3 AND revision=$4 AND lease_token=$5 AND status=''running'' AND graph_version=$6 AND graph_schema_version=$7 AND graph_input_digest=$8 FOR UPDATE',
        ${journalSchemaLiteral}
      ) INTO matched
      USING attempt.user_id, attempt.command_id, attempt.root_command_id, attempt.revision,
        attempt.lease_token, attempt.graph_version, attempt.graph_schema_version, attempt.input_digest;
      IF matched IS NULL THEN
        RAISE EXCEPTION 'BP_CHECKPOINT_FENCED' USING ERRCODE = '40001';
      END IF;
      ${testDelay}

      IF TG_TABLE_NAME = 'checkpoints' THEN
        /*
         * A transfer is an exact copy of a trusted ancestor chain into a fresh
         * attempt thread. It is authorized only while the command row still
         * points at the source head and this destination attempt owns the
         * current lease. The application performs the copy and pointer switch
         * in one transaction; ordinary saver writes continue through CAS.
         */
        IF TG_OP = 'INSERT' THEN
          EXECUTE format(
          'SELECT CASE WHEN EXISTS (
             SELECT 1 FROM %I.bp_checkpoint_transfers x
             JOIN %I.bp_plan_commands j ON j.user_id=$2 AND j.command_id=$3
               AND j.root_command_id IS NOT DISTINCT FROM $4 AND j.revision=$5 AND j.lease_token=$6
               AND j.status=''running'' AND j.graph_version=$7 AND j.graph_schema_version=$8 AND j.graph_input_digest=$9
               AND j.graph_checkpoint_thread_id=x.source_thread_id AND j.graph_checkpoint_ns='''' AND j.graph_checkpoint_id=x.source_checkpoint_id
             JOIN %I.checkpoints src ON src.thread_id=x.source_thread_id AND src.checkpoint_ns='''' AND src.checkpoint_id=$10
               AND src.parent_checkpoint_id IS NOT DISTINCT FROM $11 AND src.type IS NOT DISTINCT FROM $12
               AND src.checkpoint=$13 AND src.metadata=$14
             WHERE x.target_thread_id=$1
           ) THEN 1 ELSE 0 END',
          ${checkpointSchemaLiteral}, ${journalSchemaLiteral}, ${checkpointSchemaLiteral}
          ) INTO matched USING NEW.thread_id, attempt.user_id, attempt.command_id, attempt.root_command_id,
            attempt.revision, attempt.lease_token, attempt.graph_version, attempt.graph_schema_version,
            attempt.input_digest, NEW.checkpoint_id, NEW.parent_checkpoint_id, NEW.type, NEW.checkpoint, NEW.metadata;
          IF matched = 1 THEN
            RETURN NEW;
          END IF;
        END IF;

        EXECUTE format(
          'SELECT CASE WHEN EXISTS (SELECT 1 FROM %I.checkpoints c WHERE c.thread_id=$1 AND c.checkpoint_ns=$2 AND c.checkpoint_id=$3) AND NOT EXISTS (SELECT 1 FROM %I.bp_plan_commands j WHERE j.user_id=$4 AND j.command_id=$5 AND j.root_command_id IS NOT DISTINCT FROM $6 AND j.revision=$7 AND j.lease_token=$8 AND j.status=''running'' AND j.graph_version=$9 AND j.graph_schema_version=$10 AND j.graph_input_digest=$11 AND j.graph_checkpoint_thread_id=$1 AND j.graph_checkpoint_ns=$2 AND j.graph_checkpoint_id=$3) THEN 1 ELSE 0 END',
          ${checkpointSchemaLiteral}, ${journalSchemaLiteral}
        ) INTO matched USING NEW.thread_id, NEW.checkpoint_ns, NEW.checkpoint_id, attempt.user_id, attempt.command_id,
          attempt.root_command_id, attempt.revision, attempt.lease_token, attempt.graph_version,
          attempt.graph_schema_version, attempt.input_digest;
        IF matched = 1 THEN
          RAISE EXCEPTION 'BP_CHECKPOINT_LINEAGE_CONFLICT' USING ERRCODE = '40001';
        END IF;

        EXECUTE format(
          'SELECT CASE WHEN checkpoint=$4 AND metadata=$5 AND type IS NOT DISTINCT FROM $6 THEN 1 ELSE 0 END FROM %I.checkpoints WHERE thread_id=$1 AND checkpoint_ns=$2 AND checkpoint_id=$3',
          ${checkpointSchemaLiteral}
        ) INTO matched USING NEW.thread_id, NEW.checkpoint_ns, NEW.checkpoint_id, NEW.checkpoint, NEW.metadata, NEW.type;
        IF matched = 0 THEN
          RAISE EXCEPTION 'BP_CHECKPOINT_CONTENT_CONFLICT' USING ERRCODE = '40001';
        END IF;

        EXECUTE format(
          'UPDATE %I.bp_plan_commands SET graph_checkpoint_thread_id=$1, graph_checkpoint_ns=$2, graph_checkpoint_id=$3 WHERE user_id=$4 AND command_id=$5 AND root_command_id IS NOT DISTINCT FROM $6 AND revision=$7 AND lease_token=$8 AND status=''running'' AND graph_version=$9 AND graph_schema_version=$10 AND graph_input_digest=$11 AND ((graph_checkpoint_thread_id IS NULL AND graph_checkpoint_ns IS NULL AND graph_checkpoint_id IS NULL AND $12 IS NULL) OR (graph_checkpoint_thread_id=$1 AND graph_checkpoint_ns=$2 AND graph_checkpoint_id=$12 AND $3>$12) OR (graph_checkpoint_thread_id=$1 AND graph_checkpoint_ns=$2 AND graph_checkpoint_id=$3))',
          ${journalSchemaLiteral}
        ) USING NEW.thread_id, NEW.checkpoint_ns, NEW.checkpoint_id, attempt.user_id, attempt.command_id,
          attempt.root_command_id, attempt.revision, attempt.lease_token, attempt.graph_version,
          attempt.graph_schema_version, attempt.input_digest, NEW.parent_checkpoint_id;
        GET DIAGNOSTICS matched = ROW_COUNT;
        IF matched <> 1 THEN
          RAISE EXCEPTION 'BP_CHECKPOINT_LINEAGE_CONFLICT' USING ERRCODE = '40001';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE OR REPLACE FUNCTION ${checkpointSchema}.bp_block_checkpoint_delete()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF EXISTS (SELECT 1 FROM ${checkpointSchema}.bp_checkpoint_attempts WHERE thread_id=OLD.thread_id)
        OR EXISTS (SELECT 1 FROM ${journalSchema}.bp_plan_commands WHERE graph_checkpoint_thread_id=OLD.thread_id) THEN
        RAISE EXCEPTION 'BP_CHECKPOINT_DELETE_DISABLED' USING ERRCODE = '55000';
      END IF;
      RETURN OLD;
    END;
    $function$;

    CREATE OR REPLACE FUNCTION ${checkpointSchema}.bp_fence_checkpoint_blob_write()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    DECLARE
      attempt ${checkpointSchema}.bp_checkpoint_attempts%ROWTYPE;
      matched integer;
    BEGIN
      SELECT * INTO attempt FROM ${checkpointSchema}.bp_checkpoint_attempts WHERE thread_id=NEW.thread_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'BP_CHECKPOINT_ATTEMPT_UNKNOWN' USING ERRCODE = '40001';
      END IF;
      IF NEW.checkpoint_ns <> '' THEN
        RAISE EXCEPTION 'BP_CHECKPOINT_NAMESPACE_NOT_ALLOWED' USING ERRCODE = '40001';
      END IF;
      EXECUTE format(
        'SELECT 1 FROM %I.bp_plan_commands WHERE user_id=$1 AND command_id=$2 AND root_command_id IS NOT DISTINCT FROM $3 AND revision=$4 AND lease_token=$5 AND status=''running'' AND graph_version=$6 AND graph_schema_version=$7 AND graph_input_digest=$8 FOR UPDATE',
        ${journalSchemaLiteral}
      ) INTO matched USING attempt.user_id, attempt.command_id, attempt.root_command_id, attempt.revision,
        attempt.lease_token, attempt.graph_version, attempt.graph_schema_version, attempt.input_digest;
      IF matched IS NULL THEN
        RAISE EXCEPTION 'BP_CHECKPOINT_FENCED' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END;
    $function$;

    DROP TRIGGER IF EXISTS bp_fence_checkpoint_write ON ${checkpointSchema}.checkpoints;
    CREATE TRIGGER bp_fence_checkpoint_write
      BEFORE INSERT OR UPDATE ON ${checkpointSchema}.checkpoints
      FOR EACH ROW EXECUTE FUNCTION ${checkpointSchema}.bp_fence_checkpoint_write();

    DROP TRIGGER IF EXISTS bp_fence_checkpoint_pending_write ON ${checkpointSchema}.checkpoint_writes;
    CREATE TRIGGER bp_fence_checkpoint_pending_write
      BEFORE INSERT OR UPDATE ON ${checkpointSchema}.checkpoint_writes
      FOR EACH ROW EXECUTE FUNCTION ${checkpointSchema}.bp_fence_checkpoint_write();

    DROP TRIGGER IF EXISTS bp_fence_checkpoint_blob_write ON ${checkpointSchema}.checkpoint_blobs;
    CREATE TRIGGER bp_fence_checkpoint_blob_write
      BEFORE INSERT OR UPDATE ON ${checkpointSchema}.checkpoint_blobs
      FOR EACH ROW EXECUTE FUNCTION ${checkpointSchema}.bp_fence_checkpoint_blob_write();

    DROP TRIGGER IF EXISTS bp_block_checkpoint_delete ON ${checkpointSchema}.checkpoints;
    CREATE TRIGGER bp_block_checkpoint_delete
      BEFORE DELETE ON ${checkpointSchema}.checkpoints
      FOR EACH ROW EXECUTE FUNCTION ${checkpointSchema}.bp_block_checkpoint_delete();

    DROP TRIGGER IF EXISTS bp_block_checkpoint_blob_delete ON ${checkpointSchema}.checkpoint_blobs;
    CREATE TRIGGER bp_block_checkpoint_blob_delete
      BEFORE DELETE ON ${checkpointSchema}.checkpoint_blobs
      FOR EACH ROW EXECUTE FUNCTION ${checkpointSchema}.bp_block_checkpoint_delete();

    DROP TRIGGER IF EXISTS bp_block_checkpoint_write_delete ON ${checkpointSchema}.checkpoint_writes;
    CREATE TRIGGER bp_block_checkpoint_write_delete
      BEFORE DELETE ON ${checkpointSchema}.checkpoint_writes
      FOR EACH ROW EXECUTE FUNCTION ${checkpointSchema}.bp_block_checkpoint_delete();
    `);
    await migrationClient.query(`INSERT INTO ${checkpointSchema}.bp_checkpoint_fencing_config(singleton,journal_schema,migration_version)
    VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE
      SET migration_version=GREATEST(${checkpointSchema}.bp_checkpoint_fencing_config.migration_version,EXCLUDED.migration_version)`,
    [options.journalSchema, CHECKPOINT_FENCING_SCHEMA_VERSION]);
    return saver;
  } catch (error) {
    migrationFailed = true;
    throw error;
  } finally {
    if (migrationLockHeld && !connection.failure()) {
      try {
        await migrationClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [migrationLockKey]);
      } catch (error) {
        connection.discard(error instanceof Error ? error : new Error('CHECKPOINT_MIGRATION_UNLOCK_FAILED'));
        if (!migrationFailed) throw error;
      }
    }
  }
  });
}

/** Register an attempt only after the server has claimed its journal lease. */
export async function registerCheckpointAttempt(
  pool: Pool,
  options: CheckpointSchemaOptions,
  threadId: string,
  identity: CheckpointJournalIdentity,
): Promise<void> {
  const checkpointSchema = identifier(options.checkpointSchema);
  const journalSchema = identifier(options.journalSchema);
  checkIdentity(identity);
  if (!threadId || threadId.length > 200) throw new Error('Invalid server-generated checkpoint thread id');
  return withTransaction(pool, async client => {
    const current = await client.query(
      `SELECT 1 FROM ${journalSchema}.bp_plan_commands
       WHERE user_id=$1 AND command_id=$2 AND root_command_id IS NOT DISTINCT FROM $3
         AND revision=$4 AND lease_token=$5 AND status='running'
         AND graph_version=$6 AND graph_schema_version=$7 AND graph_input_digest=$8
       FOR UPDATE`,
      [identity.userId, identity.commandId, identity.rootCommandId, identity.revision,
        identity.leaseToken, identity.graphVersion, identity.graphSchemaVersion, identity.inputDigest],
    );
    if (!current.rowCount) throw new Error('BP_CHECKPOINT_ATTEMPT_NOT_CURRENT');
    await client.query(
      `INSERT INTO ${checkpointSchema}.bp_checkpoint_attempts
       (thread_id,user_id,command_id,root_command_id,revision,lease_token,graph_version,graph_schema_version,input_digest)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [threadId, identity.userId, identity.commandId, identity.rootCommandId, identity.revision,
        identity.leaseToken, identity.graphVersion, identity.graphSchemaVersion, identity.inputDigest],
    );
  });
}

/**
 * Copy the exact trusted checkpoint ancestry into a fresh attempt thread.
 * Public getTuple/putWrites APIs intentionally are not used: their public
 * pending-write tuples omit task_path and stored idx, which are required to
 * preserve LangGraph's scheduling order.
 *
 * This remains an infrastructure primitive. Production graph resume must
 * stay disabled until the real planner's recovery and process tests pass.
 */
export async function transferCheckpointAttempt(
  pool: Pool,
  options: CheckpointSchemaOptions,
  targetThreadId: string,
  identity: CheckpointJournalIdentity,
  testHooks?: CheckpointTransferTestHooks,
): Promise<string | undefined> {
  const checkpointSchema = identifier(options.checkpointSchema);
  const journalSchema = identifier(options.journalSchema);
  checkIdentity(identity);
  if (!targetThreadId || targetThreadId.length > 200) throw new Error('Invalid destination checkpoint thread id');

  return withTransaction(pool, async client => {
    const currentResult = await client.query<{
      graph_checkpoint_thread_id: string | null;
      graph_checkpoint_ns: string | null;
      graph_checkpoint_id: string | null;
    }>(`SELECT graph_checkpoint_thread_id,graph_checkpoint_ns,graph_checkpoint_id
      FROM ${journalSchema}.bp_plan_commands
      WHERE user_id=$1 AND command_id=$2 AND root_command_id IS NOT DISTINCT FROM $3
        AND revision=$4 AND lease_token=$5 AND status='running'
        AND graph_version=$6 AND graph_schema_version=$7 AND graph_input_digest=$8
      FOR UPDATE`, [identity.userId, identity.commandId, identity.rootCommandId, identity.revision,
      identity.leaseToken, identity.graphVersion, identity.graphSchemaVersion, identity.inputDigest]);
    const current = currentResult.rows[0];
    if (!current) throw new Error('BP_CHECKPOINT_ATTEMPT_NOT_CURRENT');
    const hasAnyPointer = current.graph_checkpoint_thread_id !== null || current.graph_checkpoint_ns !== null || current.graph_checkpoint_id !== null;
    if (!hasAnyPointer) {
      return undefined;
    }
    if (!current.graph_checkpoint_thread_id || current.graph_checkpoint_ns !== '' || !current.graph_checkpoint_id
      || current.graph_checkpoint_thread_id === targetThreadId) {
      throw new Error('BP_CHECKPOINT_TRANSFER_POINTER_INVALID');
    }
    const sourceThreadId = current.graph_checkpoint_thread_id;
    const headId = current.graph_checkpoint_id;

    const attempts = await client.query(`SELECT
        EXISTS (SELECT 1 FROM ${checkpointSchema}.bp_checkpoint_attempts a
          WHERE a.thread_id=$1 AND a.user_id=$2 AND a.command_id=$3
            AND a.root_command_id IS NOT DISTINCT FROM $4 AND a.revision=$5
            AND a.graph_version=$6 AND a.graph_schema_version=$7 AND a.input_digest=$8) AS source_matches,
        EXISTS (SELECT 1 FROM ${checkpointSchema}.bp_checkpoint_attempts a
          WHERE a.thread_id=$9 AND a.user_id=$2 AND a.command_id=$3 AND a.root_command_id IS NOT DISTINCT FROM $4
            AND a.revision=$5 AND a.lease_token=$10 AND a.graph_version=$6 AND a.graph_schema_version=$7 AND a.input_digest=$8) AS target_matches,
        EXISTS (SELECT 1 FROM ${checkpointSchema}.checkpoints c WHERE c.thread_id=$9)
          OR EXISTS (SELECT 1 FROM ${checkpointSchema}.checkpoint_blobs b WHERE b.thread_id=$9)
          OR EXISTS (SELECT 1 FROM ${checkpointSchema}.checkpoint_writes w WHERE w.thread_id=$9) AS target_has_data`,
      [sourceThreadId, identity.userId, identity.commandId, identity.rootCommandId, identity.revision,
        identity.graphVersion, identity.graphSchemaVersion, identity.inputDigest, targetThreadId, identity.leaseToken]);
    const validation = attempts.rows[0];
    if (!validation?.source_matches) throw new Error('BP_CHECKPOINT_TRANSFER_SOURCE_MISMATCH');
    if (!validation?.target_matches) throw new Error('BP_CHECKPOINT_TRANSFER_TARGET_MISMATCH');
    if (validation.target_has_data) throw new Error('BP_CHECKPOINT_TRANSFER_TARGET_NOT_EMPTY');

    const unsupportedNamespaces = await client.query(`SELECT
        EXISTS (SELECT 1 FROM ${checkpointSchema}.checkpoints WHERE thread_id=$1 AND checkpoint_ns<>'')
        OR EXISTS (SELECT 1 FROM ${checkpointSchema}.checkpoint_blobs WHERE thread_id=$1 AND checkpoint_ns<>'')
        OR EXISTS (SELECT 1 FROM ${checkpointSchema}.checkpoint_writes WHERE thread_id=$1 AND checkpoint_ns<>'') AS present`, [sourceThreadId]);
    if (unsupportedNamespaces.rows[0]?.present) throw new Error('BP_CHECKPOINT_TRANSFER_NAMESPACE_UNSUPPORTED');

    const lineage = await client.query<{ checkpoint_id: string; parent_checkpoint_id: string | null; depth: number; cycle: boolean }>(
      `WITH RECURSIVE lineage AS (
         SELECT c.checkpoint_id,c.parent_checkpoint_id,0 AS depth,ARRAY[c.checkpoint_id]::text[] AS path,false AS cycle
         FROM ${checkpointSchema}.checkpoints c
         WHERE c.thread_id=$1 AND c.checkpoint_ns='' AND c.checkpoint_id=$2
         UNION ALL
         SELECT parent.checkpoint_id,parent.parent_checkpoint_id,lineage.depth+1,lineage.path || parent.checkpoint_id,
           parent.checkpoint_id=ANY(lineage.path)
         FROM lineage
         JOIN ${checkpointSchema}.checkpoints parent
           ON parent.thread_id=$1 AND parent.checkpoint_ns='' AND parent.checkpoint_id=lineage.parent_checkpoint_id
         WHERE NOT lineage.cycle AND lineage.depth<1000
       ) SELECT checkpoint_id,parent_checkpoint_id,depth,cycle FROM lineage ORDER BY depth`, [sourceThreadId, headId]);
    const chain = lineage.rows;
    if (!chain.length || chain[0]?.checkpoint_id !== headId || chain.some(row => row.cycle)
      || chain.at(-1)?.parent_checkpoint_id !== null || new Set(chain.map(row => row.checkpoint_id)).size !== chain.length) {
      throw new Error('BP_CHECKPOINT_TRANSFER_LINEAGE_INVALID');
    }
    const ids = chain.map(row => row.checkpoint_id);
    if (headId !== ids.reduce((max, id) => id > max ? id : max, ids[0]!)) {
      throw new Error('BP_CHECKPOINT_TRANSFER_HEAD_ORDER_INVALID');
    }

    const missingBlobs = await client.query(`SELECT count(*)::int AS count
      FROM ${checkpointSchema}.checkpoints c
      CROSS JOIN LATERAL jsonb_each_text(c.checkpoint->'channel_versions') AS version(channel,version)
      LEFT JOIN ${checkpointSchema}.checkpoint_blobs b
        ON b.thread_id=c.thread_id AND b.checkpoint_ns=c.checkpoint_ns
          AND b.channel=version.channel AND b.version=version.version
      WHERE c.thread_id=$1 AND c.checkpoint_ns='' AND c.checkpoint_id=ANY($2::text[]) AND b.channel IS NULL`, [sourceThreadId, ids]);
    if (missingBlobs.rows[0]?.count !== 0) throw new Error('BP_CHECKPOINT_TRANSFER_BLOB_MISSING');
    const sourceBlobCount = await client.query(`SELECT count(DISTINCT (version.channel,version.version))::int AS count
      FROM ${checkpointSchema}.checkpoints c
      CROSS JOIN LATERAL jsonb_each_text(c.checkpoint->'channel_versions') AS version(channel,version)
      WHERE c.thread_id=$1 AND c.checkpoint_ns='' AND c.checkpoint_id=ANY($2::text[])`, [sourceThreadId, ids]);
    const sourceWriteCount = await client.query(`SELECT count(*)::int AS count FROM ${checkpointSchema}.checkpoint_writes
      WHERE thread_id=$1 AND checkpoint_ns='' AND checkpoint_id=ANY($2::text[])`, [sourceThreadId, ids]);

    await client.query(`INSERT INTO ${checkpointSchema}.bp_checkpoint_transfers(target_thread_id,source_thread_id,source_checkpoint_id)
      VALUES($1,$2,$3)`, [targetThreadId, sourceThreadId, headId]);
    const copiedBlobs = await client.query(`INSERT INTO ${checkpointSchema}.checkpoint_blobs(thread_id,checkpoint_ns,channel,version,type,blob)
      SELECT $1,b.checkpoint_ns,b.channel,b.version,b.type,b.blob
      FROM ${checkpointSchema}.checkpoint_blobs b
      WHERE b.thread_id=$2 AND b.checkpoint_ns=''
        AND EXISTS (SELECT 1 FROM ${checkpointSchema}.checkpoints c
          CROSS JOIN LATERAL jsonb_each_text(c.checkpoint->'channel_versions') AS version(channel,version)
          WHERE c.thread_id=$2 AND c.checkpoint_ns='' AND c.checkpoint_id=ANY($3::text[])
            AND version.channel=b.channel AND version.version=b.version)
      ON CONFLICT(thread_id,checkpoint_ns,channel,version) DO NOTHING`, [targetThreadId, sourceThreadId, ids]);
    if (copiedBlobs.rowCount !== sourceBlobCount.rows[0]?.count) throw new Error('BP_CHECKPOINT_TRANSFER_BLOB_COUNT_MISMATCH');
    const copiedCheckpoints = await client.query(`INSERT INTO ${checkpointSchema}.checkpoints(thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,type,checkpoint,metadata)
      SELECT $1,checkpoint_ns,checkpoint_id,parent_checkpoint_id,type,checkpoint,metadata
      FROM ${checkpointSchema}.checkpoints
      WHERE thread_id=$2 AND checkpoint_ns='' AND checkpoint_id=ANY($3::text[])
      ORDER BY checkpoint_id`, [targetThreadId, sourceThreadId, ids]);
    if (copiedCheckpoints.rowCount !== ids.length) throw new Error('BP_CHECKPOINT_TRANSFER_CHECKPOINT_COUNT_MISMATCH');
    const copiedWrites = await client.query(`INSERT INTO ${checkpointSchema}.checkpoint_writes(thread_id,checkpoint_ns,checkpoint_id,task_id,task_path,idx,channel,type,blob)
      SELECT $1,checkpoint_ns,checkpoint_id,task_id,task_path,idx,channel,type,blob
      FROM ${checkpointSchema}.checkpoint_writes
      WHERE thread_id=$2 AND checkpoint_ns='' AND checkpoint_id=ANY($3::text[])
      ORDER BY checkpoint_id,task_path,task_id,idx`, [targetThreadId, sourceThreadId, ids]);
    if (copiedWrites.rowCount !== sourceWriteCount.rows[0]?.count) throw new Error('BP_CHECKPOINT_TRANSFER_WRITE_COUNT_MISMATCH');
    const copyMismatch = await client.query(`WITH
      src_cp AS (SELECT checkpoint_id,parent_checkpoint_id,type,checkpoint,metadata FROM ${checkpointSchema}.checkpoints
        WHERE thread_id=$2 AND checkpoint_ns='' AND checkpoint_id=ANY($3::text[])),
      dst_cp AS (SELECT checkpoint_id,parent_checkpoint_id,type,checkpoint,metadata FROM ${checkpointSchema}.checkpoints
        WHERE thread_id=$1 AND checkpoint_ns='' AND checkpoint_id=ANY($3::text[])),
      needed_blobs AS (SELECT DISTINCT version.channel,version.version
        FROM ${checkpointSchema}.checkpoints c
        CROSS JOIN LATERAL jsonb_each_text(c.checkpoint->'channel_versions') AS version(channel,version)
        WHERE c.thread_id=$2 AND c.checkpoint_ns='' AND c.checkpoint_id=ANY($3::text[])),
      src_blobs AS (SELECT b.checkpoint_ns,b.channel,b.version,b.type,b.blob FROM ${checkpointSchema}.checkpoint_blobs b
        JOIN needed_blobs n USING(channel,version) WHERE b.thread_id=$2 AND b.checkpoint_ns=''),
      dst_blobs AS (SELECT b.checkpoint_ns,b.channel,b.version,b.type,b.blob FROM ${checkpointSchema}.checkpoint_blobs b
        JOIN needed_blobs n USING(channel,version) WHERE b.thread_id=$1 AND b.checkpoint_ns=''),
      src_writes AS (SELECT checkpoint_ns,checkpoint_id,task_id,task_path,idx,channel,type,blob
        FROM ${checkpointSchema}.checkpoint_writes WHERE thread_id=$2 AND checkpoint_ns='' AND checkpoint_id=ANY($3::text[])),
      dst_writes AS (SELECT checkpoint_ns,checkpoint_id,task_id,task_path,idx,channel,type,blob
        FROM ${checkpointSchema}.checkpoint_writes WHERE thread_id=$1 AND checkpoint_ns='' AND checkpoint_id=ANY($3::text[]))
      SELECT
        EXISTS(SELECT * FROM src_cp EXCEPT ALL SELECT * FROM dst_cp)
          OR EXISTS(SELECT * FROM dst_cp EXCEPT ALL SELECT * FROM src_cp) AS checkpoints,
        EXISTS(SELECT * FROM src_blobs EXCEPT ALL SELECT * FROM dst_blobs)
          OR EXISTS(SELECT * FROM dst_blobs EXCEPT ALL SELECT * FROM src_blobs) AS blobs,
        EXISTS(SELECT * FROM src_writes EXCEPT ALL SELECT * FROM dst_writes)
          OR EXISTS(SELECT * FROM dst_writes EXCEPT ALL SELECT * FROM src_writes) AS writes`,
    [targetThreadId, sourceThreadId, ids]);
    const mismatch = copyMismatch.rows[0];
    if (mismatch?.checkpoints || mismatch?.blobs || mismatch?.writes) throw new Error('BP_CHECKPOINT_TRANSFER_COPY_MISMATCH');
    await testHooks?.beforePointerUpdate?.();
    const switched = await client.query(`UPDATE ${journalSchema}.bp_plan_commands
      SET graph_checkpoint_thread_id=$1,graph_checkpoint_ns='',graph_checkpoint_id=$2
      WHERE user_id=$3 AND command_id=$4 AND root_command_id IS NOT DISTINCT FROM $5
        AND revision=$6 AND lease_token=$7 AND status='running'
        AND graph_version=$8 AND graph_schema_version=$9 AND graph_input_digest=$10
        AND graph_checkpoint_thread_id=$11 AND graph_checkpoint_ns='' AND graph_checkpoint_id=$2`,
    [targetThreadId, headId, identity.userId, identity.commandId, identity.rootCommandId, identity.revision,
      identity.leaseToken, identity.graphVersion, identity.graphSchemaVersion, identity.inputDigest, sourceThreadId]);
    if (switched.rowCount !== 1) throw new Error('BP_CHECKPOINT_TRANSFER_POINTER_RACE');
    await client.query(`DELETE FROM ${checkpointSchema}.bp_checkpoint_transfers WHERE target_thread_id=$1`, [targetThreadId]);
    await testHooks?.beforeCommit?.();
    return headId;
  });
}
