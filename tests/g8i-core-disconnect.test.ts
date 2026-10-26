import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { expect,it,vi } from 'vitest';
import { observePoolErrors,withDatabaseClient,withTransaction } from '../packages/core/src/database.js';
import { createCore } from '../packages/core/src/index.js';
function fixture(mode:'success'|'disconnect'|'rollback-failure'){
 const original=Object.assign(new Error('CONTROLLED_TRANSACTION_FAILURE'),{code:'08006'});
 const client=Object.assign(new EventEmitter(),{query:vi.fn(),release:vi.fn()});
 const existing=vi.fn();client.on('error',existing);
 client.query.mockImplementation(async(sql:string)=>{
  if(sql==='COMMIT'&&mode!=='success'){
   if(mode==='disconnect'){expect(client.listenerCount('error')).toBe(2);client.emit('error',original);}
   throw original;
  }
  if(sql==='ROLLBACK'&&mode==='rollback-failure')throw new Error('SECONDARY_ROLLBACK_FAILURE');
  return{rows:[]};
 });
 const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
 return{core:createCore(pool,{schema:'g8i_unit'}),client,original,existing};
}
it('handles checked-out connection errors, preserves failure and discards only the failed connection',async()=>{
 const {core,client,original,existing}=fixture('disconnect');
 await expect(core.setNextFault({userId:'unit-owner'},'NORMAL')).rejects.toBe(original);
 expect(existing).toHaveBeenCalledExactlyOnceWith(original);expect(client.release).toHaveBeenCalledExactlyOnceWith(original);
 expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');expect(client.listenerCount('error')).toBe(1);expect(client.listeners('error')[0]).toBe(existing);
});
it('does not replace a failed COMMIT with a failed best-effort rollback',async()=>{
 const {core,client,original}=fixture('rollback-failure');
 await expect(core.setNextFault({userId:'unit-owner'},'NORMAL')).rejects.toBe(original);
 expect(client.release).toHaveBeenCalledTimes(1);expect(client.listenerCount('error')).toBe(1);
});
it('removes its temporary error listener and returns healthy connections normally',async()=>{
 const {core,client}=fixture('success');await core.setNextFault({userId:'unit-owner'},'NORMAL');
 expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);expect(client.listenerCount('error')).toBe(1);expect(client.query).toHaveBeenCalledWith('COMMIT');
});

it('idle-pool observation emits only safe codes and installs once',()=>{
 const pool=new EventEmitter() as Pool,report=vi.fn();observePoolErrors(pool,report);observePoolErrors(pool,report);
 pool.emit('error',Object.assign(new Error('postgres://private:secret@host/database SQL payload'),{code:'57P01',client:{password:'SECRET_CANARY'}}));
 pool.emit('error',Object.assign(new Error('SQL payload'),{code:'secret token'}));
 expect(report.mock.calls).toEqual([['57P01'],['DATABASE_CONNECTION_ERROR']]);expect(pool.listenerCount('error')).toBe(1);
});
it('a connection lost while transaction work resolves cannot silently COMMIT',async()=>{
 const client=Object.assign(new EventEmitter(),{query:vi.fn(async(_sql:string)=>({rows:[]})),release:vi.fn()});
 const pool={connect:async()=>client} as unknown as Pool,error=new Error('LOST_SESSION');
 await expect(withTransaction(pool,async()=>{client.emit('error',error);return 'not committed';})).rejects.toBe(error);
 expect(client.query.mock.calls).toEqual([['BEGIN']]);expect(client.release).toHaveBeenCalledExactlyOnceWith(error);
});
it('session-lock work fails when its checked-out connection is lost even if nested work returns',async()=>{
 const client=Object.assign(new EventEmitter(),{release:vi.fn()}),error=new Error('LOST_LOCK_CONNECTION');
 await expect(withDatabaseClient({connect:async()=>client} as unknown as Pool,async()=>{client.emit('error',error);return 'unsafe success';})).rejects.toBe(error);
 expect(client.release).toHaveBeenCalledExactlyOnceWith(error);expect(client.listenerCount('error')).toBe(0);
});
