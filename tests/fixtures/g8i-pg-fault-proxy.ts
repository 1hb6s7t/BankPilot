import { createServer, createConnection, type Socket } from 'node:net';
import type { Pool } from 'pg';
export type G8iFaultMode='terminate_before_commit'|'drop_committed_response';
export type G8iFaultEvidence={mode:G8iFaultMode;backendPid:number;commitForwarded:boolean;commitObserved:boolean;terminationConfirmed:boolean;responseBytesWithheld:number;connectionClosed:boolean};
type Arm={mode:G8iFaultMode;marker:string;committed:()=>Promise<boolean>;resolve:(e:G8iFaultEvidence)=>void;reject:(e:Error)=>void};
/** Plaintext local PG wire proxy: no query result is fabricated and no SQL is logged. */
export async function startG8iPgFaultProxy(upstreamPort:number,admin:Pool,database:string){
 if(upstreamPort===55432||upstreamPort===5432)throw new Error('G8I_PROXY_TARGET_NOT_ISOLATED');
 const sockets=new Set<Socket>();let armed:Arm|undefined;
 const server=createServer(client=>{
  const upstream=createConnection({host:'127.0.0.1',port:upstreamPort});sockets.add(client);sockets.add(upstream);
  let startup=true,front=Buffer.alloc(0),back=Buffer.alloc(0),pid:number|undefined,marked=false,holding=false,triggered=false;
  let evidence:G8iFaultEvidence|undefined;
  const close=()=>{client.destroy();upstream.destroy();sockets.delete(client);sockets.delete(upstream);};
  client.on('error',close);upstream.on('error',close);client.on('close',close);upstream.on('close',close);
  const inject=async(current:Arm,frame:Buffer)=>{
   evidence={mode:current.mode,backendPid:pid!,commitForwarded:false,commitObserved:false,terminationConfirmed:false,responseBytesWithheld:0,connectionClosed:false};
   try{
    const identity=await admin.query('SELECT datname,application_name FROM pg_stat_activity WHERE pid=$1',[pid]);
    if(identity.rows[0]?.datname!==database||!String(identity.rows[0]?.application_name).startsWith('g8i_fault_'))throw new Error('G8I_BACKEND_OWNER_MISMATCH');
    if(current.mode==='terminate_before_commit'){
     const killed=await admin.query('SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND application_name LIKE $3',[pid,database,'g8i_fault_%']);
     evidence.terminationConfirmed=killed.rows[0]?.terminated===true;if(!evidence.terminationConfirmed)throw new Error('G8I_BACKEND_NOT_TERMINATED');
    }else{
     // Commit reaches the actual database, but its CommandComplete/ReadyForQuery
     // response never reaches node-postgres. An independent connection proves durability.
     holding=true;upstream.write(frame);evidence.commitForwarded=true;
     for(let n=0;n<100;n++){if(await current.committed()){evidence.commitObserved=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
     if(!evidence.commitObserved)throw new Error('G8I_COMMIT_NOT_OBSERVED');
    }
    close();evidence.connectionClosed=true;current.resolve(evidence);
   }catch{close();current.reject(new Error('G8I_FAULT_INJECTION_FAILED'));}
  };
  client.on('data',chunk=>{
   front=Buffer.concat([front,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
   while(front.length){
    if(startup){if(front.length<4)return;const length=front.readInt32BE(0);if(front.length<length)return;upstream.write(front.subarray(0,length));front=front.subarray(length);startup=false;continue;}
    if(front.length<5)return;const length=front.readInt32BE(1)+1;if(front.length<length)return;
    const frame=front.subarray(0,length);front=front.subarray(length);const tag=String.fromCharCode(frame[0]!);
    let sql='';if(tag==='Q')sql=frame.subarray(5,-1).toString();else if(tag==='P'){const end=frame.indexOf(0,5);if(end>=0)sql=frame.subarray(end+1,frame.indexOf(0,end+1)).toString();}
    if(sql==='BEGIN')marked=false;
    if(armed&&sql.includes(armed.marker))marked=true;
    if(armed&&!triggered&&marked&&sql==='COMMIT'){
     const current=armed;armed=undefined;triggered=true;
     if(!pid){close();current.reject(new Error('G8I_BACKEND_PID_MISSING'));return;}
     void inject(current,frame);return;
    }
    upstream.write(frame);
   }
  });
  upstream.on('data',chunk=>{
   back=Buffer.concat([back,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
   while(back.length>=5){const length=back.readInt32BE(1)+1;if(back.length<length)break;const frame=back.subarray(0,length);back=back.subarray(length);if(frame[0]===75)pid=frame.readInt32BE(5);if(holding){if(evidence)evidence.responseBytesWithheld+=frame.length;}else client.write(frame);}
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const address=server.address();if(!address||typeof address==='string')throw new Error('G8I_PROXY_LISTEN_FAILED');
 return{port:address.port,arm(mode:G8iFaultMode,marker:string,committed:()=>Promise<boolean>){if(armed)throw new Error('G8I_FAULT_ALREADY_ARMED');return new Promise<G8iFaultEvidence>((resolve,reject)=>{armed={mode,marker,committed,resolve,reject};});},async close(){if(armed){armed.reject(new Error('G8I_PROXY_CLOSED_WHILE_ARMED'));armed=undefined;}for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
