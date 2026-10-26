import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConversationService } from '../apps/api/src/conversations.js';
import { createSubscriptionContinuationStore, type SubscriptionContinuation } from '../apps/api/src/subscription-continuations.js';
import { recognizeSubscriptionPrerequisite } from '../packages/agents/src/subscription-prerequisite.js';

// Run only under the root's shared PostgreSQL integration-test lock. Merely
// typechecking this file neither connects to a database nor dispatches a model.
const url = process.env.TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const schema = `g9f_cont_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: url });
const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
const conversations = createConversationService(pool), store = createSubscriptionContinuationStore(pool);
const owner = { userId: 'continuation-owner' }, other = { userId: 'continuation-other' };
const text = '  取消青岚𠮷视频的订阅，银行阻止栖禾音乐扣款。  ';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const expires = () => new Date(Date.now() + 300_000).toISOString();
async function accepted(message = text, actor = owner) {
  const conversation = await conversations.create(actor);
  const value = await conversations.accept(actor, conversation.id, { clientMessageId: randomUUID(), text: message });
  return { ...value, queryActionId: randomUUID(), prerequisite: recognizeSubscriptionPrerequisite(message)! };
}
type Accepted = Awaited<ReturnType<typeof accepted>>;
async function finishSource(value: Accepted, actor = owner) {
  await pool.query("UPDATE bp_plan_commands SET status='complete',result=$3 WHERE user_id=$1 AND command_id=$2", [actor.userId, value.command.commandId,
    JSON.stringify({ actions: [], managementActions: [{ id: value.queryActionId, spec: { kind: 'SUBSCRIPTION_QUERY' } }] })]);
}
async function waiting(message = text) {
  const value = await accepted(message); await finishSource(value);
  const continuation = await store.registerWaiting(owner, { sourceCommandId: value.command.commandId, queryActionId: value.queryActionId, prerequisite: value.prerequisite });
  return { ...value, continuation };
}
function claim(row: SubscriptionContinuation, grantExpiresAt = expires()) {
  return store.claimGranted(owner, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, grantExpiresAt });
}
async function planning() {
  const value = await waiting(), continuation = (await claim(value.continuation))!;
  const created = await store.createSuccessor(owner, { sourceCommandId: continuation.sourceCommandId, leaseToken: continuation.leaseToken! });
  return { ...value, continuation: created.continuation, created };
}
async function finishChild(commandId: string, status = 'complete') {
  const lease = randomUUID();
  await pool.query('UPDATE bp_plan_commands SET status=$3,lease_token=$4 WHERE user_id=$1 AND command_id=$2', [owner.userId, commandId, status, lease]);
  return lease;
}
beforeAll(async () => { await admin.query(`CREATE SCHEMA "${schema}"`); await conversations.migrate(); await store.migrate(); });
beforeEach(async () => { await pool.query('TRUNCATE bp_subscription_continuations,bp_chat_messages,bp_clarifications,bp_plan_commands,bp_conversations CASCADE'); });
afterAll(async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); });

describe('G9F durable subscription continuation identity and atomic registration', () => {
  it('migrates idempotently and freezes an exact real user message, prerequisite and query id', async () => {
    await store.migrate();
    const value = await waiting(), row = value.continuation;
    expect(row).toMatchObject({ userId: owner.userId, conversationId: value.command.conversationId, sourceCommandId: value.command.commandId,
      sourceUserMessageId: value.message.id, rootCommandId: value.command.rootCommandId, grantCycle: 1, isCurrent: true, state: 'WAITING_QUERY',
      originalMessageSha256: digest(text), prerequisiteVersion: 1, prerequisite: value.prerequisite, queryActionId: value.queryActionId });
    expect(row.prerequisite.tasks.map(task => task.operation)).toEqual(['subscription_cancel', 'subscription_block']);
    expect(row.prerequisite.tasks.every(task => text.slice(task.source.start, task.source.end) === task.source.text)).toBe(true);
    expect((await pool.query('SELECT COUNT(*) FROM bp_chat_messages')).rows[0].count).toBe('1');
    expect(await store.get(owner, row.sourceCommandId)).toEqual(row);
  });
  it('registers the same source/query atomically under concurrent completion replay', async () => {
    const value = await accepted(); await finishSource(value);
    const input = { sourceCommandId: value.command.commandId, queryActionId: value.queryActionId, prerequisite: value.prerequisite };
    const results = await Promise.all([store.registerWaiting(owner, input), store.registerWaiting(owner, input)]);
    expect(results[0]).toEqual(results[1]);
    expect((await pool.query('SELECT COUNT(*) FROM bp_subscription_continuations')).rows[0].count).toBe('1');
  });
  it('registerWaitingTx rolls back with the source completion transaction', async () => {
    const value = await accepted(), tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("UPDATE bp_plan_commands SET status='complete',result=$3 WHERE user_id=$1 AND command_id=$2", [owner.userId, value.command.commandId,
        JSON.stringify({ managementActions: [{ id: value.queryActionId, spec: { kind: 'SUBSCRIPTION_QUERY' } }] })]);
      await store.registerWaitingTx(tx, owner, { sourceCommandId: value.command.commandId, queryActionId: value.queryActionId, prerequisite: value.prerequisite });
      await tx.query('ROLLBACK');
    } finally { tx.release(); }
    expect(await store.get(owner, value.command.commandId)).toBeUndefined();
    expect((await pool.query('SELECT status FROM bp_plan_commands')).rows[0].status).toBe('pending');
  });
  it('cannot register an unfinished source or a query id absent from its actual result', async () => {
    const value = await accepted(), input = { sourceCommandId: value.command.commandId, queryActionId: value.queryActionId, prerequisite: value.prerequisite };
    await expect(store.registerWaiting(owner, input)).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_SOURCE_INCOMPLETE' });
    await finishSource(value);
    await expect(store.registerWaiting(owner, { ...input, queryActionId: randomUUID() })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_QUERY_MISMATCH' });
    expect((await pool.query('SELECT COUNT(*) FROM bp_subscription_continuations')).rows[0].count).toBe('0');
  });
  it.each(['hash', 'original', 'planning-message', 'planning-original', 'user-text', 'user-role', 'user-command', 'user-owner'])('rejects a corrupted source binding: %s', async field => {
    const value = await accepted(); await finishSource(value);
    if (field === 'hash') await pool.query("UPDATE bp_plan_commands SET message_hash='changed'");
    if (field === 'original') await pool.query("UPDATE bp_plan_commands SET original_message='取消别的订阅'");
    if (field === 'planning-message') await pool.query("UPDATE bp_plan_commands SET planning_input=jsonb_set(planning_input,'{message}','\"另一个请求\"')");
    if (field === 'planning-original') await pool.query("UPDATE bp_plan_commands SET planning_input=jsonb_set(planning_input,'{originalMessage}','\"另一个请求\"')");
    if (field === 'user-text') await pool.query("UPDATE bp_chat_messages SET text='另一个请求'");
    if (field === 'user-role') await pool.query("UPDATE bp_chat_messages SET role='assistant'");
    if (field === 'user-command') await pool.query("UPDATE bp_chat_messages SET command_id='different-command'");
    if (field === 'user-owner') {
      const foreign = await accepted(text, other);
      await pool.query('UPDATE bp_plan_commands SET user_message_id=$2 WHERE command_id=$1', [value.command.commandId, foreign.message.id]);
    }
    await expect(store.registerWaiting(owner, { sourceCommandId: value.command.commandId, queryActionId: value.queryActionId, prerequisite: value.prerequisite })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_SOURCE_INVALID' });
  });
  it.each(['operation', 'offset', 'text', 'task-count', 'message'])('rejects a changed frozen prerequisite: %s', async field => {
    const value = await accepted(); await finishSource(value); const prerequisite = structuredClone(value.prerequisite);
    if (field === 'operation') prerequisite.tasks[0]!.operation = 'subscription_block';
    if (field === 'offset') prerequisite.tasks[0]!.source.start++;
    if (field === 'text') prerequisite.tasks[0]!.source.text = '取消不同商户订阅';
    if (field === 'task-count') prerequisite.tasks.pop();
    if (field === 'message') prerequisite.message = prerequisite.message.trim();
    await expect(store.registerWaiting(owner, { sourceCommandId: value.command.commandId, queryActionId: value.queryActionId, prerequisite })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_PREREQUISITE_INVALID' });
  });
  it('isolates all reads/writes by owner and lists all current states by default', async () => {
    const value = await waiting();
    expect(await store.get(other, value.command.commandId)).toBeUndefined(); expect(await store.listForUser(other)).toEqual([]);
    await expect(store.registerWaiting(other, { sourceCommandId: value.command.commandId, queryActionId: value.queryActionId, prerequisite: value.prerequisite })).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.stop(other, { sourceCommandId: value.command.commandId })).rejects.toMatchObject({ statusCode: 404 });
    await store.stop(owner, { sourceCommandId: value.command.commandId });
    expect((await store.listForUser(owner)).map(row => row.state)).toEqual(['STOPPED']);
    expect(await store.listForUser(owner, { states: ['WAITING_QUERY'] })).toEqual([]);
    expect(await store.listWaitingForUser(owner)).toEqual([]);
  });
});

describe('G9F exact grant CAS, leases and one child per grant cycle', () => {
  it('only one concurrent claim wins and wrong query/version cannot take a lease', async () => {
    const value = await waiting(), row = value.continuation, expiry = expires();
    expect(await store.claimGranted(owner, { sourceCommandId: row.sourceCommandId, queryActionId: randomUUID(), expectedStateVersion: row.stateVersion, grantExpiresAt: expiry })).toBeNull();
    const claims = await Promise.all([claim(row, expiry), claim(row, expiry)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ state: 'PLANNING', queryActionId: row.queryActionId, grantExpiresAt: expiry });
    expect(await claim(row, expiry)).toBeNull();
  });
  it('records expiration as reauthorization without creating a child or granting access', async () => {
    const value = await waiting(); expect(await claim(value.continuation, new Date(Date.now() - 1000).toISOString())).toBeNull();
    const row = (await store.get(owner, value.command.commandId))!;
    expect(row.state).toBe('NEEDS_QUERY_REAUTH'); expect(row.leaseToken).toBeUndefined(); expect(row.successorCommandId).toBeUndefined();
    expect(await claim(row)).toBeNull();
  });
  it('creates one child and one assistant event under concurrent repeated confirmation', async () => {
    const value = await waiting(), granted = (await claim(value.continuation))!;
    const input = { sourceCommandId: granted.sourceCommandId, leaseToken: granted.leaseToken! };
    const [one, two] = await Promise.all([store.createSuccessor(owner, input), store.createSuccessor(owner, input)]);
    expect(one.commandId).toBe(two.commandId); expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    const child = (await pool.query('SELECT * FROM bp_plan_commands WHERE command_id=$1', [one.commandId])).rows[0];
    expect(child).toMatchObject({ status: 'pending', user_id: owner.userId, conversation_id: value.command.conversationId,
      user_message_id: value.message.id, parent_command_id: value.command.commandId, root_command_id: value.command.rootCommandId, revision: 1,
      original_message: text, message_hash: digest(text), planning_input: value.command.planningInput });
    const messages = (await pool.query('SELECT * FROM bp_chat_messages ORDER BY sequence')).rows;
    expect(messages).toHaveLength(2); expect(messages.filter(row => row.role === 'user')).toHaveLength(1);
    expect(messages[1]).toMatchObject({ role: 'assistant', kind: 'result', command_id: one.commandId, response_key: 'continuation' });
    expect(messages[1].text).not.toContain('青岚'); expect(messages[1].text).not.toContain('栖禾');
    expect(await store.getBySuccessor(other, one.commandId)).toBeUndefined();
    expect((await store.getBySuccessor(owner, one.commandId))?.sourceUserMessageId).toBe(value.message.id);
  });
  it('requires a current lease and complete original command before child creation', async () => {
    const value = await waiting(), granted = (await claim(value.continuation))!;
    await expect(store.createSuccessor(owner, { sourceCommandId: granted.sourceCommandId, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_LEASE_LOST' });
    await pool.query("UPDATE bp_plan_commands SET status='running' WHERE command_id=$1", [value.command.commandId]);
    await expect(store.createSuccessor(owner, { sourceCommandId: granted.sourceCommandId, leaseToken: granted.leaseToken! })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_SOURCE_INCOMPLETE' });
    expect((await pool.query('SELECT COUNT(*) FROM bp_plan_commands')).rows[0].count).toBe('1');
  });
  it('persists grant expiry between claim and successor creation without an empty user message', async () => {
    const value = await waiting(), granted = (await claim(value.continuation))!;
    await pool.query("UPDATE bp_subscription_continuations SET grant_expires_at=clock_timestamp()-interval '1 second'");
    const result = await store.createSuccessor(owner, { sourceCommandId: granted.sourceCommandId, leaseToken: granted.leaseToken! });
    expect(result.commandId).toBe(''); expect(result.continuation.state).toBe('NEEDS_QUERY_REAUTH');
    expect((await pool.query('SELECT COUNT(*) FROM bp_chat_messages')).rows[0].count).toBe('1');
  });
  it('recovers an expired scheduler lease after restart while reusing the same child', async () => {
    const value = await planning(), restarted = createSubscriptionContinuationStore(pool);
    await pool.query("UPDATE bp_subscription_continuations SET lease_expires_at=clock_timestamp()-interval '1 second'");
    const row = (await restarted.get(owner, value.command.commandId))!;
    await expect(restarted.claimGranted(owner, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, grantExpiresAt: new Date(Date.parse(row.grantExpiresAt!) + 1000).toISOString() })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_QUERY_MISMATCH' });
    const reclaimed = (await restarted.claimGranted(owner, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, grantExpiresAt: row.grantExpiresAt! }))!;
    expect(reclaimed.leaseToken).not.toBe(value.continuation.leaseToken);
    await expect(restarted.createSuccessor(owner, { sourceCommandId: row.sourceCommandId, leaseToken: value.continuation.leaseToken! })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_LEASE_LOST' });
    const replay = await restarted.createSuccessor(owner, { sourceCommandId: row.sourceCommandId, leaseToken: reclaimed.leaseToken! });
    expect(replay.commandId).toBe(value.created.commandId); expect(replay.replayed).toBe(true);
    expect((await pool.query('SELECT COUNT(*) FROM bp_plan_commands')).rows[0].count).toBe('2');
  });
  it('stops waiting requests idempotently but honestly rejects stopping active planning', async () => {
    const value = await waiting(), stopped = await store.stop(owner, { sourceCommandId: value.command.commandId, expectedStateVersion: value.continuation.stateVersion });
    expect(await store.stop(owner, { sourceCommandId: value.command.commandId, expectedStateVersion: value.continuation.stateVersion })).toEqual(stopped);
    expect(await claim(stopped)).toBeNull();
    await expect(store.createSuccessor(owner, { sourceCommandId: stopped.sourceCommandId, leaseToken: randomUUID() })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_LEASE_LOST' });
    const active = await planning();
    await expect(store.stop(owner, { sourceCommandId: active.command.commandId })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_RUNNING' });
  });
  it('invalidates an unstarted expired child so the next query cycle cannot become stuck behind pending work', async () => {
    const value = await planning();
    await pool.query("UPDATE bp_subscription_continuations SET grant_expires_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second'");
    const row = (await store.get(owner, value.command.commandId))!;
    expect(await claim(row, row.grantExpiresAt!)).toBeNull();
    expect((await store.get(owner, row.sourceCommandId))?.state).toBe('NEEDS_QUERY_REAUTH');
    expect((await pool.query('SELECT status FROM bp_plan_commands WHERE command_id=$1', [value.created.commandId])).rows[0].status).toBe('failed');
    const next = await store.registerWaiting(owner, { sourceCommandId: row.sourceCommandId, queryActionId: randomUUID(), prerequisite: row.prerequisite });
    expect(next.grantCycle).toBe(2);
  });
});

describe('G9F fenced completion, explicit recovery and preserved authorization cycles', () => {
  it('completes in the child transaction, rolls back atomically, and repeats without state changes', async () => {
    const value = await planning(), token = await finishChild(value.created.commandId), tx = await pool.connect();
    try { await tx.query('BEGIN'); await store.completeTx(tx, owner, { successorCommandId: value.created.commandId, state: 'WRITE_PREPARED', commandLeaseToken: token }); await tx.query('ROLLBACK'); }
    finally { tx.release(); }
    expect((await store.get(owner, value.command.commandId))?.state).toBe('PLANNING');
    const done = await store.complete(owner, { successorCommandId: value.created.commandId, state: 'WRITE_PREPARED', commandLeaseToken: token });
    expect(done.state).toBe('WRITE_PREPARED'); expect(done.leaseToken).toBeUndefined();
    expect(await store.complete(owner, { successorCommandId: value.created.commandId, state: 'WRITE_PREPARED', commandLeaseToken: token })).toEqual(done);
    const stopped = await store.stop(owner, { sourceCommandId: value.command.commandId });
    expect(await store.complete(owner, { successorCommandId: value.created.commandId, state: 'WRITE_PREPARED' })).toEqual(stopped);
  });
  it('cannot complete a pending child or a different planning lease', async () => {
    const value = await planning();
    await expect(store.complete(owner, { successorCommandId: value.created.commandId, state: 'WRITE_PREPARED' })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_SUCCESSOR_INCOMPLETE' });
    await finishChild(value.created.commandId);
    await expect(store.complete(owner, { successorCommandId: value.created.commandId, state: 'WRITE_PREPARED', commandLeaseToken: randomUUID() })).rejects.toMatchObject({ code: 'PLAN_SUPERSEDED' });
  });
  it('makes failed scope checks explicit clarification and does not auto-scan recoverable failures', async () => {
    const one = await planning(); await finishChild(one.created.commandId, 'failed');
    expect((await store.complete(owner, { successorCommandId: one.created.commandId, state: 'NEEDS_CLARIFICATION', lastErrorCode: 'CONTINUATION_SCOPE_MISMATCH' })).state).toBe('NEEDS_CLARIFICATION');
    const value = await planning(); await finishChild(value.created.commandId, 'failed');
    const failed = await store.complete(owner, { successorCommandId: value.created.commandId, state: 'FAILED_RECOVERABLE', lastErrorCode: 'MODEL_TIMEOUT' });
    expect((await store.listWaitingForUser(owner)).some(row => row.sourceCommandId === failed.sourceCommandId)).toBe(false);
    const explicit = (await claim(failed, failed.grantExpiresAt!))!;
    const replay = await store.createSuccessor(owner, { sourceCommandId: explicit.sourceCommandId, leaseToken: explicit.leaseToken! });
    expect(replay.commandId).toBe(value.created.commandId); expect(replay.replayed).toBe(true);
  });
  it('expires a completed child conservatively and creates a distinct explicit query cycle without altering old bindings', async () => {
    const value = await planning(); await finishChild(value.created.commandId);
    await pool.query("UPDATE bp_subscription_continuations SET grant_expires_at=clock_timestamp()-interval '1 second'");
    const old = await store.complete(owner, { successorCommandId: value.created.commandId, state: 'WRITE_PREPARED' });
    expect(old.state).toBe('NEEDS_QUERY_REAUTH');
    const query2 = randomUUID(), next = await store.registerWaiting(owner, { sourceCommandId: old.sourceCommandId, queryActionId: query2, prerequisite: old.prerequisite });
    expect(next).toMatchObject({ grantCycle: 2, state: 'WAITING_QUERY', sourceUserMessageId: value.message.id, queryActionId: query2 });
    expect(await claim(next, new Date(Date.now() - 1000).toISOString())).toBeNull();
    const historical = (await store.getBySuccessor(owner, value.created.commandId))!;
    expect(historical).toMatchObject({ grantCycle: 1, isCurrent: false, state: 'NEEDS_QUERY_REAUTH', queryActionId: value.queryActionId });
    expect((await store.listForUser(owner))).toHaveLength(1);
    const query3 = randomUUID(), third = await store.registerWaiting(owner, { sourceCommandId: old.sourceCommandId, queryActionId: query3, prerequisite: old.prerequisite });
    const granted = (await claim(third))!, child2 = await store.createSuccessor(owner, { sourceCommandId: third.sourceCommandId, leaseToken: granted.leaseToken! });
    expect(child2.commandId).not.toBe(value.created.commandId);
    const child = (await pool.query('SELECT * FROM bp_plan_commands WHERE command_id=$1', [child2.commandId])).rows[0];
    expect(child.user_message_id).toBe(value.message.id); expect(child.revision).toBe(2); expect(child.original_message).toBe(text);
    expect((await pool.query("SELECT COUNT(*) FROM bp_chat_messages WHERE role='user'")).rows[0].count).toBe('1');
  });
  it('does not claim a permanently failed child and cannot create a second child while rejecting that resume', async () => {
    const value = await planning(); await finishChild(value.created.commandId, 'failed');
    const failed = await store.complete(owner, { successorCommandId: value.created.commandId, state: 'FAILED_RECOVERABLE', lastErrorCode: 'PLANNER_FAILURE' });
    await pool.query('UPDATE bp_plan_commands SET planning_failure=$2 WHERE command_id=$1', [value.created.commandId,
      JSON.stringify({ phase: 'planning', code: 'MODEL_SCHEMA_INVALID', retryable: false, message: '无法安全规划。', modelRuns: [] })]);
    expect(await claim(failed, failed.grantExpiresAt!)).toBeNull();
    expect((await store.get(owner, failed.sourceCommandId))?.state).toBe('NEEDS_CLARIFICATION');
    expect((await pool.query('SELECT COUNT(*) FROM bp_plan_commands')).rows[0].count).toBe('2');
    expect((await store.getBySuccessor(owner, value.created.commandId))?.successorCommandId).toBe(value.created.commandId);
  });
  it('does not bind the same query action to a second source or reactivate a stopped request', async () => {
    const one = await waiting(), two = await accepted(); two.queryActionId = one.queryActionId; await finishSource(two);
    await expect(store.registerWaiting(owner, { sourceCommandId: two.command.commandId, queryActionId: one.queryActionId, prerequisite: two.prerequisite })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_QUERY_MISMATCH' });
    await store.stop(owner, { sourceCommandId: one.command.commandId });
    await expect(store.registerWaiting(owner, { sourceCommandId: one.command.commandId, queryActionId: randomUUID(), prerequisite: one.prerequisite })).rejects.toMatchObject({ code: 'SUBSCRIPTION_CONTINUATION_CONFLICT' });
  });
  it('marks cancelled waiting queries through CAS and invalidates an unstarted child before reauthorization', async () => {
    const waitingValue = await waiting(), row = waitingValue.continuation;
    expect(await store.markNeedsQuery(owner, { sourceCommandId: row.sourceCommandId, queryActionId: randomUUID(), expectedStateVersion: row.stateVersion, lastErrorCode: 'QUERY_AUTHORIZATION_REQUIRED' })).toBeNull();
    expect((await store.markNeedsQuery(owner, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, lastErrorCode: 'QUERY_AUTHORIZATION_REQUIRED' }))?.state).toBe('NEEDS_QUERY_REAUTH');
    const value = await planning(), child = value.continuation;
    expect((await store.markNeedsQuery(owner, { sourceCommandId: child.sourceCommandId, queryActionId: child.queryActionId, expectedStateVersion: child.stateVersion, lastErrorCode: 'QUERY_ACCESS_EXPIRED' }))?.state).toBe('NEEDS_QUERY_REAUTH');
    expect((await pool.query('SELECT status,planning_failure FROM bp_plan_commands WHERE command_id=$1', [value.created.commandId])).rows[0]).toMatchObject({ status: 'failed', planning_failure: { retryable: false } });
    const next = await store.registerWaiting(owner, { sourceCommandId: child.sourceCommandId, queryActionId: randomUUID(), prerequisite: child.prerequisite });
    expect(next.grantCycle).toBe(2);
  });
  it('does not overwrite a running child when query expiration is observed by a scanner', async () => {
    const value = await planning(); await finishChild(value.created.commandId, 'running');
    const row = value.continuation;
    expect(await store.markNeedsQuery(owner, { sourceCommandId: row.sourceCommandId, queryActionId: row.queryActionId, expectedStateVersion: row.stateVersion, lastErrorCode: 'QUERY_ACCESS_EXPIRED' })).toBeNull();
    expect((await store.get(owner, row.sourceCommandId))?.state).toBe('PLANNING');
    expect((await pool.query('SELECT status FROM bp_plan_commands WHERE command_id=$1', [value.created.commandId])).rows[0].status).toBe('running');
  });
  it('moves an explicitly resumed recoverable failure to reauthorization and fences the old failed child', async () => {
    const value = await planning(); await finishChild(value.created.commandId, 'failed');
    await pool.query('UPDATE bp_plan_commands SET planning_failure=$2 WHERE command_id=$1', [value.created.commandId,
      JSON.stringify({ phase: 'planning', code: 'MODEL_TIMEOUT', retryable: true, message: '模型超时。', modelRuns: [] })]);
    const failed = await store.complete(owner, { successorCommandId: value.created.commandId, state: 'FAILED_RECOVERABLE', lastErrorCode: 'MODEL_TIMEOUT' });
    const reauth = await store.markNeedsQuery(owner, { sourceCommandId: failed.sourceCommandId, queryActionId: failed.queryActionId, expectedStateVersion: failed.stateVersion, lastErrorCode: 'QUERY_ACCESS_EXPIRED' });
    expect(reauth?.state).toBe('NEEDS_QUERY_REAUTH');
    const child = (await pool.query('SELECT status,planning_failure FROM bp_plan_commands WHERE command_id=$1', [value.created.commandId])).rows[0];
    expect(child).toMatchObject({ status: 'failed', planning_failure: { code: 'MODEL_TIMEOUT', retryable: false } });
    expect(await claim(reauth!)).toBeNull();
    const next = await store.registerWaiting(owner, { sourceCommandId: failed.sourceCommandId, queryActionId: randomUUID(), prerequisite: failed.prerequisite });
    expect(next.grantCycle).toBe(2);
  });
  it('advances source observation metadata without editing its text or original message row', async () => {
    const value = await waiting();
    const before = (await pool.query('SELECT state_version FROM bp_plan_commands WHERE command_id=$1', [value.command.commandId])).rows[0];
    await store.stop(owner, { sourceCommandId: value.command.commandId });
    const after = (await pool.query('SELECT * FROM bp_plan_commands WHERE command_id=$1', [value.command.commandId])).rows[0];
    expect(BigInt(after.state_version)).toBeGreaterThan(BigInt(before.state_version)); expect(after.original_message).toBe(text);
    expect((await pool.query('SELECT text FROM bp_chat_messages WHERE id=$1', [value.message.id])).rows[0].text).toBe(text);
  });
  it('filters active work in SQL so 100 terminal rows cannot hide waiting requests', async () => {
    const terminal = await Promise.all(Array.from({ length: 100 }, () => waiting()));
    await Promise.all(terminal.map(value => store.stop(owner, { sourceCommandId: value.command.commandId })));
    const active = await Promise.all(Array.from({ length: 3 }, () => waiting()));
    expect(await store.listForUser(owner, { states: ['WAITING_QUERY', 'PLANNING'], limit: 100, afterSourceCommandId: '' }))
      .toEqual(expect.arrayContaining(active.map(value => value.continuation)));
    const page = await store.listForUser(owner, { states: ['WAITING_QUERY', 'PLANNING'], limit: 100, afterSourceCommandId: '' });
    expect(page).toHaveLength(3); expect(page.every(row => row.state === 'WAITING_QUERY')).toBe(true);
    expect((await store.listForUser(owner, { limit: 100 })).every(row => row.state === 'STOPPED')).toBe(true);
  });
  it('pages 101 waiting requests without omission even when earlier rows change update order', async () => {
    const active = await Promise.all(Array.from({ length: 101 }, () => waiting()));
    const expectedIds = active.map(value => value.command.commandId).sort();
    const first = await store.listForUser(owner, { states: ['WAITING_QUERY'], limit: 100, afterSourceCommandId: '' });
    expect(first.map(row => row.sourceCommandId)).toEqual(expectedIds.slice(0, 100));
    await claim(first[0]!);
    const second = await store.listForUser(owner, { states: ['WAITING_QUERY'], limit: 100, afterSourceCommandId: first.at(-1)!.sourceCommandId });
    expect(second.map(row => row.sourceCommandId)).toEqual(expectedIds.slice(100));
    const allIds = [...first, ...second].map(row => row.sourceCommandId);
    expect(new Set(allIds).size).toBe(101); expect(allIds).toEqual(expectedIds);
    expect(await store.listForUser(owner, { states: ['WAITING_QUERY'], limit: 100, afterSourceCommandId: second.at(-1)!.sourceCommandId })).toEqual([]);
    expect(await store.listForUser(other, { states: ['WAITING_QUERY'], limit: 100, afterSourceCommandId: '' })).toEqual([]);
  });
});
