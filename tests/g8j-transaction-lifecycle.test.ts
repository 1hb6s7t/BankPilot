import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { expect,it,vi } from 'vitest';
import { withTransaction } from '../packages/core/src/database.js';

it('read-only conversation snapshots retain repeatable-read isolation and commit normally',async()=>{
 const client=Object.assign(new EventEmitter(),{query:vi.fn(async(_sql:string)=>({rows:[]})),release:vi.fn()});
 const value=await withTransaction({connect:async()=>client} as unknown as Pool,async tx=>{await tx.query('SELECT 1');return 7;},{readOnly:true});
 expect(value).toBe(7);expect(client.query.mock.calls).toEqual([['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],['SELECT 1'],['COMMIT']]);expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);expect(client.listenerCount('error')).toBe(0);
});
it('snapshot read failure remains original when rollback also fails',async()=>{
 const original=new Error('ORIGINAL_SNAPSHOT_READ_FAILURE'),secondary=new Error('ROLLBACK_CONNECTION_FAILURE');
 const client=Object.assign(new EventEmitter(),{query:vi.fn(async(sql:string)=>{if(sql==='ROLLBACK')throw secondary;return{rows:[]};}),release:vi.fn()});
 await expect(withTransaction({connect:async()=>client} as unknown as Pool,async()=>{throw original;},{readOnly:true})).rejects.toBe(original);
 expect(client.query.mock.calls).toEqual([['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],['ROLLBACK']]);expect(client.release).toHaveBeenCalledExactlyOnceWith(secondary);expect(client.listenerCount('error')).toBe(0);
});
it('checkout rejection remains original and never enters transaction work',async()=>{
 const original=new Error('DATABASE_CHECKOUT_FAILURE'),work=vi.fn();
 await expect(withTransaction({connect:async()=>{throw original;}} as unknown as Pool,work)).rejects.toBe(original);expect(work).not.toHaveBeenCalled();
});
