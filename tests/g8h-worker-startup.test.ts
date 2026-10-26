import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
const mock=vi.hoisted(()=>({phase:'',failure:new Error('INITIALIZATION_FAILED'),stopFailure:false,rollbackFailure:false,instances:[] as any[]}));
vi.mock('pg-boss',()=>({PgBoss:class {
  on=vi.fn();start=vi.fn(async()=>{if(mock.phase==='start')throw mock.failure;});
  createQueue=vi.fn(async(name:string)=>{if(mock.phase===`queue:${name}`)throw mock.failure;});
  work=vi.fn(async(name:string)=>{if(mock.phase===`work:${name}`)throw mock.failure;});
  send=vi.fn(async()=>{if(mock.phase==='send')throw mock.failure;});
  stop=vi.fn(async()=>{if(mock.stopFailure)throw new Error('SECONDARY_STOP_FAILURE');});
  constructor(){mock.instances.push(this);}
}}));
import { createCore,createInvestment,startWorker } from '../packages/core/src/index';
function services(){
 const tx=Object.assign(new EventEmitter(),{release:vi.fn(),query:vi.fn(async(sql:string)=>{if(sql==='ROLLBACK'&&mock.rollbackFailure)throw new Error('ROLLBACK_FAILED');if(sql.includes('SELECT *')&&mock.phase==='select')throw mock.failure;return{rows:mock.phase==='send'&&sql.includes('SELECT *')?[{id:1,action_id:'action',kind:'execute'}]:[]};})});
 const pool={options:{},connect:vi.fn(async()=>{if(mock.phase==='connect')throw mock.failure;return tx;})} as unknown as Pool;
 const core=createCore(pool,{schema:'g8h_startup_unit'}),investment=createInvestment(pool,{schema:'g8h_startup_unit'});
 vi.spyOn(investment,'processDue').mockImplementation(async()=>{if(mock.phase==='processDue')throw mock.failure;});
 return{pool,core,investment,tx};
}
beforeEach(()=>{vi.useFakeTimers();mock.phase='';mock.failure=new Error('INITIALIZATION_FAILED');mock.stopFailure=false;mock.rollbackFailure=false;mock.instances=[];});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('G8H Worker partially initialized lifecycle',()=>{
 it.each(['start','queue:bankpilot-actions','work:bankpilot-actions','queue:bankpilot-investments','work:bankpilot-investments','processDue','connect','select','send'])('stops partial initialization at %s and permits a fresh worker',async phase=>{
  mock.phase=phase;const {pool,core,investment,tx}=services();
  await expect(startWorker(pool,core,investment)).rejects.toBe(mock.failure);
  expect(mock.instances[0].stop).toHaveBeenCalledExactlyOnceWith({graceful:true,timeout:10_000});
  expect(vi.getTimerCount()).toBe(0);
  if(['select','send'].includes(phase)){expect(tx.query).toHaveBeenCalledWith('ROLLBACK');expect(tx.release).toHaveBeenCalledTimes(1);}
  const calls=(pool.connect as any).mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  if(calls!==undefined)expect((pool.connect as any).mock.calls.length).toBe(calls);
  mock.phase='';const handle=await startWorker(pool,core,investment);expect(vi.getTimerCount()).toBe(1);
  await handle.stop();expect(vi.getTimerCount()).toBe(0);expect(mock.instances[1].stop).toHaveBeenCalledTimes(1);
 });
 it('preserves the original initialization error when stopping also fails',async()=>{
  mock.phase='queue:bankpilot-actions';mock.stopFailure=true;const {pool,core}=services();
  await expect(startWorker(pool,core)).rejects.toBe(mock.failure);expect(mock.instances[0].stop).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('preserves the first-flush failure when rollback also fails',async()=>{
  mock.phase='select';mock.rollbackFailure=true;const {pool,core,tx}=services();
  await expect(startWorker(pool,core)).rejects.toBe(mock.failure);expect(tx.release).toHaveBeenCalledTimes(1);expect(mock.instances[0].stop).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 });
 it('does not allocate a boss for incompatible services',async()=>{
  const {pool,core}=services(),investment=createInvestment(pool,{schema:'other_startup_unit'});
  await expect(startWorker(pool,core,investment)).rejects.toThrow('same core schema');expect(mock.instances).toHaveLength(0);expect(vi.getTimerCount()).toBe(0);
 });
});
