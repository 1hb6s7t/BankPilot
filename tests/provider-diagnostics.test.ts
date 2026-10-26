import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invokeStructured, type OpenAICompatibleConfig } from '../packages/agents/src/provider';
import type { ModelRun } from '../packages/contracts/src/index';
const config:OpenAICompatibleConfig={baseURL:'https://example.invalid/v1',model:'synthetic-test',apiKey:'secret-api-key',maxAttempts:2,retryDelayMs:0,maxStructureRepairs:0};
const completion=(serialized:string,finish:unknown='tool_calls')=>new Response(JSON.stringify({usage:{prompt_tokens:11,completion_tokens:7},choices:[{finish_reason:finish,message:{tool_calls:[{function:{name:'submit',arguments:serialized}}]}}]}),{status:200});
afterEach(()=>vi.unstubAllGlobals());
describe('bounded provider structure diagnostics',()=>{
 it('reports trusted nested schema paths and expected types, never the model value or task text',async()=>{
  const runs:ModelRun[]=[],raw=JSON.stringify({items:[{amountMinor:42,note:'sensitive-value'}]});
  const fetch=vi.fn().mockResolvedValue(completion(raw));vi.stubGlobal('fetch',fetch);
  const schema=z.object({items:z.array(z.object({amountMinor:z.string(),note:z.string()}).strict())}).strict();
  await expect(invokeStructured(config,{role:'investment',message:'private-user-text'},schema,'submit',r=>runs.push(r))).rejects.toMatchObject({code:'MODEL_SCHEMA_INVALID',retryable:false});
  expect(fetch).toHaveBeenCalledTimes(1);expect(runs[0]).toMatchObject({attempt:1,failureStage:'schema',errorCode:'MODEL_SCHEMA_INVALID',finishReason:'tool_calls',outputLength:raw.length,outputDigest:createHash('sha256').update(raw).digest('hex'),issues:[{path:['items','[]','amountMinor'],code:'invalid_type',expectedType:'string'}]});
  for(const secret of ['sensitive-value','private-user-text','secret-api-key'])expect(JSON.stringify(runs)).not.toContain(secret);
 });
 it('does not expose unknown property names, dynamic record keys, custom messages or literal expected values',async()=>{
  const runs:ModelRun[]=[];
  const raw=JSON.stringify({map:{'private-record-key':42},choice:'wrong','private-property':'private-value'});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(completion(raw,'private-finish-reason')));
  const schema=z.object({map:z.record(z.string(),z.string()),choice:z.literal('private-literal')}).strict();
  await expect(invokeStructured(config,{role:'goal'},schema,'submit',r=>runs.push(r))).rejects.toMatchObject({code:'MODEL_SCHEMA_INVALID'});
  expect(runs[0].issues).toContainEqual({path:['map','[unrecognized]'],code:'invalid_type',expectedType:'string'});
  expect(runs[0].issues).toContainEqual({path:[],code:'unrecognized_keys'});expect(runs[0].finishReason).toBe('other');
  for(const secret of ['private-record-key','private-property','private-value','private-literal','private-finish-reason'])expect(JSON.stringify(runs)).not.toContain(secret);
 });
 it('bounds issue count and depth and never logs refinement messages',async()=>{
  const runs:ModelRun[]=[];const schema=z.object({items:z.array(z.string().refine(()=>false,{message:'private-refinement-message'}))}).strict();
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(completion(JSON.stringify({items:Array(30).fill('private-value')}))));
  await expect(invokeStructured(config,{role:'reviewer'},schema,'submit',r=>runs.push(r))).rejects.toMatchObject({code:'MODEL_SCHEMA_INVALID'});
  expect(runs[0].issues).toHaveLength(8);expect(runs[0].issues!.every(i=>i.path.length<=12)).toBe(true);expect(JSON.stringify(runs)).not.toContain('private-');
 });
 it.each([['{','output_json','MODEL_OUTPUT_JSON_INVALID'],['','tool_output','MODEL_TOOL_OUTPUT_INVALID']] as const)('diagnoses invalid structured output %j without retry',async(raw,stage,code)=>{
  const runs:ModelRun[]=[],fetch=vi.fn().mockResolvedValue(completion(raw));vi.stubGlobal('fetch',fetch);
  await expect(invokeStructured(config,{role:'reviewer'},z.object({ok:z.boolean()}),'submit',r=>runs.push(r))).rejects.toMatchObject({code});
  expect(runs[0]).toMatchObject({attempt:1,failureStage:stage});expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('distinguishes malformed completion envelopes from transient transport failures',async()=>{
  const runs:ModelRun[]=[],fetch=vi.fn().mockResolvedValue(new Response('null'));vi.stubGlobal('fetch',fetch);
  await expect(invokeStructured(config,{},z.object({ok:z.boolean()}),'submit',r=>runs.push(r))).rejects.toMatchObject({code:'MODEL_RESPONSE_JSON_INVALID'});
  expect(runs[0].failureStage).toBe('response_json');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('retains strict schema and retries only transient errors with separate attempt diagnostics',async()=>{
  const runs:ModelRun[]=[],fetch=vi.fn().mockResolvedValueOnce(new Response('secret-http-body',{status:503})).mockResolvedValueOnce(completion('{"ok":true}'));
  vi.stubGlobal('fetch',fetch);
  expect(await invokeStructured(config,{role:'reviewer'},z.object({ok:z.boolean()}).strict(),'submit',r=>runs.push(r))).toEqual({ok:true});
  expect(runs.map(r=>[r.attempt,r.status,r.failureStage])).toEqual([[1,'failed','request'],[2,'success',undefined]]);expect(JSON.stringify(runs)).not.toContain('secret');
 });
 it('forwards explicit output cap and zero temperature, leaves production defaults omitted',async()=>{
  const fetch=vi.fn().mockImplementation(async()=>completion('{"ok":true}'));vi.stubGlobal('fetch',fetch);
  await invokeStructured({...config,maxOutputTokens:6144,temperature:0},{},z.object({ok:z.boolean()}),'submit');
  await invokeStructured(config,{},z.object({ok:z.boolean()}),'submit');
  const bodies=fetch.mock.calls.map(c=>JSON.parse(c[1].body));expect(bodies[0]).toMatchObject({max_tokens:6144,temperature:0});expect(bodies[1]).not.toHaveProperty('max_tokens');expect(bodies[1]).not.toHaveProperty('temperature');
 });
 it.each([{maxOutputTokens:0},{maxOutputTokens:32769},{maxOutputTokens:1.5},{temperature:-1},{temperature:2.1},{temperature:NaN}])('rejects invalid explicit request limits %j before fetch',async fields=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(invokeStructured({...config,...fields},{},z.object({ok:z.boolean()}),'submit')).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
});
