import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Annotation, Command, END, START, StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createPersistenceProbe, runPersistenceProbe, resumePersistenceProbe } from '../packages/agents/src/index';

const connectionString = process.env.BANKPILOT_TEST_DATABASE_URL ?? 'postgres://bankpilot:bankpilot-local@127.0.0.1:55432/bankpilot';
const pool = new pg.Pool({ connectionString });
const schema = `bankpilot_agents_g1_${process.pid}`;
const options = { pool, schema };

describe('G1 real PostgresSaver interrupt/resume and failure recovery', () => {
  beforeAll(async () => { await pool.query('SELECT 1'); }, 30000);
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); });

  it('persists parallel results and pending interrupt, then resumes using a completely new graph/saver/pool instance', async () => {
    const threadId = randomUUID();
    const pending = await runPersistenceProbe(options, { threadId, planVersion: 1, actionVersion: 3, actionHash: 'action-intent-stable' });
    expect(pending.branches.sort()).toEqual(['bills', 'transfer']); expect(pending.finished).toBe(false); expect('__interrupt__' in pending ? pending.__interrupt__ : []).toHaveLength(1);
    const secondPool = new pg.Pool({ connectionString });
    try {
      const restored = await createPersistenceProbe({ pool: secondPool, schema });
      const snapshot = await restored.graph.getState({ configurable: { thread_id: threadId } });
      expect(snapshot.values.actionHash).toBe('action-intent-stable'); expect(snapshot.next).toContain('approvalProbe');
      const completed = await restored.graph.invoke(new Command({ resume: { approved: true, actionVersion: 3, actionHash: 'action-intent-stable' } }), { configurable: { thread_id: threadId }, durability: 'sync' });
      expect(completed.finished).toBe(true); expect(completed.branches.sort()).toEqual(['bills', 'transfer']);
    } finally { await secondPool.end(); }
  });

  it('after a failure following approval, a fresh graph resumes persisted decision without asking for approval again', async () => {
    const threadId = randomUUID();
    await runPersistenceProbe(options, { threadId, planVersion: 1, actionVersion: 1, actionHash: 'unchanged-action' });
    await expect(resumePersistenceProbe({ ...options, failAfterResume: true }, threadId, { approved: true, actionVersion: 1, actionHash: 'unchanged-action' })).rejects.toThrow('INJECTED_WORKER_FAILURE');
    const restarted = await createPersistenceProbe(options);
    const before = await restarted.graph.getState({ configurable: { thread_id: threadId } });
    expect(before.values.decision.approved).toBe(true); expect(before.next).toContain('finishProbe');
    const result = await restarted.graph.invoke(null, { configurable: { thread_id: threadId }, durability: 'sync' });
    expect(result.finished).toBe(true); expect('__interrupt__' in result ? result.__interrupt__ : []).toHaveLength(0);
  });

  it('rejects stale action approval even though the graph can be resumed', async () => {
    const threadId = randomUUID();
    await runPersistenceProbe(options, { threadId, planVersion: 7, actionVersion: 2, actionHash: 'new-action' });
    await expect(resumePersistenceProbe(options, threadId, { approved: true, actionVersion: 1, actionHash: 'old-action' })).rejects.toThrow('STALE_ACTION_APPROVAL');
    const { graph } = await createPersistenceProbe(options);
    const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
    expect(snapshot.values.finished).toBe(false); expect(snapshot.values.decision).toBeUndefined();
  });

  it('a failed parallel sibling is safely rerun after recreation without node errorHandler (#3078 avoidance)', async () => {
    const Local = Annotation.Root({ a: Annotation<boolean>(), b: Annotation<boolean>() });
    let fail = true;
    const saver = new PostgresSaver(pool, undefined, { schema }); await saver.setup();
    const build = () => new StateGraph(Local)
      .addNode('A', async () => { await new Promise(r => setTimeout(r, 5)); if (fail) { fail = false; throw new Error('branch-A-failed'); } return { a: true }; })
      .addNode('B', async () => { await new Promise(r => setTimeout(r, 35)); return { b: true }; })
      .addNode('join', () => ({})).addEdge(START, 'A').addEdge(START, 'B').addEdge(['A', 'B'], 'join').addEdge('join', END).compile({ checkpointer: saver });
    const config = { configurable: { thread_id: randomUUID() }, durability: 'sync' as const };
    await expect(build().invoke({}, config)).rejects.toThrow('branch-A-failed');
    await new Promise(r => setTimeout(r, 60));
    const completed = await build().invoke(null, config);
    expect(completed).toMatchObject({ a: true, b: true });
  });
});
