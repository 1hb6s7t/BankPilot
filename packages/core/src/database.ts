import type { Pool, PoolClient } from 'pg';

/** A checked-out pg client emits socket errors separately from query rejection.
 * Own that listener only while borrowed, and discard a disconnected connection.
 * This helper never retries a transaction or guesses whether COMMIT succeeded. */
export async function withDatabaseClient<T>(pool: Pool, fn: (client: PoolClient, connection: {
  failure(): Error | undefined; discard(error: Error): void;
}) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let failure: Error | undefined;
  const onError = (error: Error) => { failure ??= error; };
  client.on('error', onError);
  try {
    const result = await fn(client, { failure: () => failure, discard: onError });
    if (failure) throw failure;
    return result;
  } finally {
    try { client.release(failure); }
    finally { client.removeListener('error', onError); }
  }
}

export function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
  return withDatabaseClient(pool, async (client, connection) => {
    try {
      await client.query(options.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      const result = await fn(client);
      if (connection.failure()) throw connection.failure();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!connection.failure()) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { connection.discard(rollbackError instanceof Error ? rollbackError : new Error('DATABASE_ROLLBACK_FAILED')); }
      }
      throw error;
    }
  });
}

const observedPools = new WeakSet<Pool>();
/** Idle-pool errors have no request promise to reject. Record only a bounded code;
 * pg already evicts the disconnected idle client. Query failures still propagate. */
export function observePoolErrors(pool: Pool, report: (code: string) => void = code => console.error('Database connection unavailable', code)): void {
  if (observedPools.has(pool)) return;
  observedPools.add(pool);
  pool.on('error', (error: Error & { code?: string }) => {
    const code = typeof error.code === 'string' && (/^[0-9A-Z]{5}$/.test(error.code) || ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE'].includes(error.code))
      ? error.code : 'DATABASE_CONNECTION_ERROR';
    report(code);
  });
}
