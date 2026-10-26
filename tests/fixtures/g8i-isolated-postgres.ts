import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { promisify } from 'node:util';
import { Pool } from 'pg';
const exec=promisify(execFile);
export const G8I_POSTGRES_IMAGE='postgres:17-bookworm@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27';
const docker=async(args:string[])=>exec('docker',args,{timeout:30_000,maxBuffer:128*1024});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function dynamicPort(){const server=createServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('G8I_DYNAMIC_PORT_FAILED');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;}
async function closedPort(port:number){return new Promise<boolean>(resolve=>{const socket=createConnection({host:'127.0.0.1',port});const end=(ok:boolean)=>{socket.destroy();resolve(ok);};socket.once('connect',()=>end(false));socket.once('error',e=>end((e as NodeJS.ErrnoException).code==='ECONNREFUSED'));socket.setTimeout(1000,()=>end(false));});}
/** Never reads DATABASE_URL or invokes compose; only this returned container is owned. */
export async function startG8iPostgres(){
 const suffix=randomUUID().replaceAll('-',''),name=`bankpilot-g8i-fault-${suffix}`,label=`bankpilot.g8i.owner=${suffix}`;
 const database=`g8i_${suffix.slice(0,16)}`,user='g8i_owner',password=randomBytes(24).toString('hex');
 await docker(['image','inspect',G8I_POSTGRES_IMAGE,'--format','{{.Id}}']);
 const volumeName=`bankpilot-g8i-data-${suffix}`;let volumeCreated=false;
 let containerId:string|undefined,port:number|undefined,admin:Pool|undefined;
 let closePromise:Promise<{containerRemoved:boolean;volumeRemoved:boolean;portClosed:boolean;errors:string[]}>|undefined;
 const close=()=>closePromise??=(async()=>{
  const errors:string[]=[];let containerRemoved=!containerId,volumeRemoved=!volumeCreated,portClosed=port===undefined;
  try{await admin?.end();}catch{errors.push('ADMIN_POOL_CLOSE_FAILED');}
  if(containerId){
   try{
    const owner=(await docker(['inspect','--format','{{index .Config.Labels "bankpilot.g8i.owner"}}',containerId])).stdout.trim();
    if(owner!==suffix)throw new Error('OWNER_MISMATCH');
    await docker(['rm','--force','--volumes',containerId]);
    const present=(await docker(['ps','-a','--filter',`id=${containerId}`,'--format','{{.ID}}'])).stdout.trim();containerRemoved=present==='';
   }catch{errors.push('OWNED_CONTAINER_REMOVE_FAILED');}
  }
  if(volumeCreated){try{const owner=(await docker(['volume','inspect','--format','{{index .Labels "bankpilot.g8i.owner"}}',volumeName])).stdout.trim();if(owner!==suffix)throw new Error('OWNER_MISMATCH');await docker(['volume','rm',volumeName]);volumeRemoved=(await docker(['volume','ls','--filter',`name=${volumeName}`,'--format','{{.Name}}'])).stdout.trim()==='';}catch{errors.push('OWNED_VOLUME_REMOVE_FAILED');}}
  if(port!==undefined){for(let n=0;n<20;n++){portClosed=await closedPort(port);if(portClosed)break;await sleep(100);}}
  if(!portClosed)errors.push('OWNED_PORT_REMAINS');return{containerRemoved,volumeRemoved,portClosed,errors};
 })();
 try{
  await docker(['volume','create','--label',label,volumeName]);volumeCreated=true;
  const assignedPort=await dynamicPort();
  containerId=(await docker(['run','--detach','--pull=never','--name',name,'--label',label,'--publish',`127.0.0.1:${assignedPort}:5432`,'--mount',`type=volume,source=${volumeName},destination=/var/lib/postgresql/data`,'--env',`POSTGRES_DB=${database}`,'--env',`POSTGRES_USER=${user}`,'--env',`POSTGRES_PASSWORD=${password}`,G8I_POSTGRES_IMAGE])).stdout.trim();
  if(!/^[a-f0-9]{64}$/.test(containerId))throw new Error('G8I_CONTAINER_ID_INVALID');
  const mapping=JSON.parse((await docker(['inspect','--format','{{json .NetworkSettings.Ports}}',containerId])).stdout);
  const binding=mapping['5432/tcp'];if(binding?.length!==1||binding[0].HostIp!=='127.0.0.1')throw new Error('G8I_PORT_NOT_LOOPBACK');
  port=Number(binding[0].HostPort);if(!Number.isInteger(port)||port===55432||port===5432)throw new Error('G8I_PORT_NOT_ISOLATED');
  const connectionString=`postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
  admin=new Pool({connectionString,application_name:`g8i_admin_${suffix}`,max:4,connectionTimeoutMillis:1000});
  admin.on('error',()=>{});
  const waitForDatabase=async()=>{let ready=false;for(let n=0;n<60;n++){try{await admin!.query('SELECT 1');ready=true;break;}catch{await sleep(200);}}
  if(!ready)throw new Error('G8I_CONTAINER_NOT_READY');};await waitForDatabase();
  const imageId=(await docker(['inspect','--format','{{.Image}}',containerId])).stdout.trim();
  return{admin,connectionString,port,database,user,evidence:{containerId,name,label,image:G8I_POSTGRES_IMAGE,imageId,host:'127.0.0.1',port,database,storage:'exclusive-labelled-docker-volume',volumeName,existingComposeAccessed:false},async killAndRestart(){
    const owner=(await docker(['inspect','--format','{{index .Config.Labels "bankpilot.g8i.owner"}}',containerId!])).stdout.trim();if(owner!==suffix)throw new Error('G8I_CONTAINER_OWNER_MISMATCH');
    await docker(['kill','--signal','KILL',containerId!]);
    const stopped=JSON.parse((await docker(['inspect','--format','{{json .State}}',containerId!])).stdout);
    if(stopped.Running||stopped.ExitCode!==137)throw new Error('G8I_CONTAINER_NOT_KILLED');
    await docker(['start',containerId!]);
    const restartedMapping=JSON.parse((await docker(['inspect','--format','{{json .NetworkSettings.Ports}}',containerId!])).stdout);
    if(Number(restartedMapping['5432/tcp']?.[0]?.HostPort)!==port)throw new Error('G8I_RESTART_PORT_CHANGED');
    await waitForDatabase();
    const recoveryLog=await docker(['logs',containerId!]);const recoveryText=recoveryLog.stdout+recoveryLog.stderr;
    return{walRecoveryObserved:/database system was interrupted|database system was not properly shut down/.test(recoveryText)&&/redo starts at|redo is not required/.test(recoveryText),containerId,signal:'SIGKILL',exitCode:stopped.ExitCode,sameContainer:true,sameVolume:volumeName,reconnected:true};
  },close};
 }catch{const cleanup=await close();throw Object.assign(new Error('G8I_ISOLATED_DATABASE_START_FAILED'),{cleanup});}
}
export type G8iDatabase=Awaited<ReturnType<typeof startG8iPostgres>>;
