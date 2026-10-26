import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Pool } from 'pg';
import { z } from 'zod';

const ResumeDecision = z.object({ approved: z.boolean(), actionVersion: z.number().int().positive(), actionHash: z.string().min(1) }).strict();
const ProbeState = Annotation.Root({
  planVersion: Annotation<number>(),
  actionVersion: Annotation<number>(),
  actionHash: Annotation<string>(),
  branches: Annotation<string[]>({ reducer: (a, b) => [...new Set([...a, ...b])], default: () => [] }),
  decision: Annotation<z.infer<typeof ResumeDecision> | undefined>(),
  finished: Annotation<boolean>(),
});
export type PersistenceProbeOptions = {
  pool: Pool;
  schema: string;
  /** Infrastructure fault injection; never wraps a real bank operation. */
  failAfterResume?: boolean;
};

/** Real graph/checkpointer integration PoC, separate from the application authorization boundary. */
export async function createPersistenceProbe(options: PersistenceProbeOptions) {
  if (!/^bankpilot_agents_[a-z0-9_]+$/.test(options.schema)) throw new Error('PoC schema 必须使用 bankpilot_agents_ 隔离前缀');
  const saver = new PostgresSaver(options.pool, undefined, { schema: options.schema });
  await saver.setup();
  let shouldFail = options.failAfterResume ?? false;
  const graph = new StateGraph(ProbeState)
    .addNode('transferProbe', async () => { await new Promise(r => setTimeout(r, 20)); return { branches: ['transfer'] }; })
    .addNode('billsProbe', async () => { await new Promise(r => setTimeout(r, 20)); return { branches: ['bills'] }; })
    .addNode('approvalProbe', state => {
      const decision = interrupt({ kind: 'infrastructure-probe-only', actionVersion: state.actionVersion, actionHash: state.actionHash }, { responseSchema: ResumeDecision });
      if (decision.actionVersion !== state.actionVersion || decision.actionHash !== state.actionHash) throw new Error('STALE_ACTION_APPROVAL');
      return { decision };
    })
    .addNode('finishProbe', state => {
      if (shouldFail) { shouldFail = false; throw new Error('INJECTED_WORKER_FAILURE_AFTER_APPROVAL'); }
      return { finished: !!state.decision?.approved };
    })
    .addEdge(START, 'transferProbe').addEdge(START, 'billsProbe')
    .addEdge(['transferProbe', 'billsProbe'], 'approvalProbe')
    .addEdge('approvalProbe', 'finishProbe').addEdge('finishProbe', END)
    .compile({ checkpointer: saver });
  return { graph, saver };
}

export async function runPersistenceProbe(options: PersistenceProbeOptions, input: { threadId: string; planVersion: number; actionVersion: number; actionHash: string }) {
  const { graph } = await createPersistenceProbe(options);
  return graph.invoke({ planVersion: input.planVersion, actionVersion: input.actionVersion, actionHash: input.actionHash, branches: [], finished: false }, { configurable: { thread_id: input.threadId }, durability: 'sync' });
}

export async function resumePersistenceProbe(options: PersistenceProbeOptions, threadId: string, decision?: z.infer<typeof ResumeDecision>) {
  const { graph } = await createPersistenceProbe(options);
  return graph.invoke(decision ? new Command({ resume: ResumeDecision.parse(decision) }) : null, { configurable: { thread_id: threadId }, durability: 'sync' });
}
