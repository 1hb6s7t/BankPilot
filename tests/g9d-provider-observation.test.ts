import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { invokeStructured, providerFromEnv, MODEL_STRUCTURED_OUTPUT_MAX_BYTES,
  type ModelStructuredOutputObservation, type OpenAICompatibleConfig } from '../packages/agents/src/provider';

afterEach(() => vi.unstubAllGlobals());
const base: OpenAICompatibleConfig = { baseURL:'https://synthetic.invalid/v1',model:'synthetic',apiKey:'test-private-header',outputMode:'json_object',maxAttempts:2,retryDelayMs:0 };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const schema = z.object({ ready:z.boolean() }).strict();
function response(content: string, finish = 'stop') { return new Response(JSON.stringify({choices:[{finish_reason:finish,message:{content,reasoning_content:'DO_NOT_CAPTURE_REASONING'}}]}),{status:200}); }

describe('G9D explicit evaluation-only structured-output observation',()=>{
 it('preserves exact response bytes after a closed durable attempt without changing the wire or result',async()=>{
  const bodies:unknown[]=[]; const events:ModelStructuredOutputObservation[]=[];const order:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{bodies.push(JSON.parse(init.body));return response(' { "ready": true } ');}));
  const plain=await invokeStructured(base,{role:'semantic_intent',message:'synthetic'},schema,'interpret');
  const observed=await invokeStructured({...base,attemptObserver:async e=>{order.push(e.type);},structuredOutputObserver:e=>{
   expect(Object.isFrozen(e)).toBe(true);order.push('structured');events.push(e);
  }},{role:'semantic_intent',message:'synthetic'},schema,'interpret',()=>order.push('model_run'));
  expect(observed).toEqual(plain);expect(bodies[1]).toEqual(bodies[0]);
  expect(order).toEqual(['attempt_start','attempt_end','model_run','structured']);
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({role:'semantic_intent',toolName:'interpret',attempt:1,status:'success',outputText:' { "ready": true } ',outputDigest:hash(' { "ready": true } ')});
  expect(events[0]?.attemptId).toBeTruthy();expect(JSON.stringify(events)).not.toMatch(/test-private-header|DO_NOT_CAPTURE_REASONING|catalog|baseURL/);
 });
 it('records the rejected and repaired raw structures separately within the original two attempts',async()=>{
  const events:ModelStructuredOutputObservation[]=[];const outputs=['{"ready":"yes"}','{"ready":true}'];
  const fetch=vi.fn(async()=>response(outputs.shift()!));vi.stubGlobal('fetch',fetch);
  await expect(invokeStructured({...base,structuredOutputObserver:e=>events.push(e)},{role:'semantic_intent'},schema,'interpret')).resolves.toEqual({ready:true});
  expect(fetch).toHaveBeenCalledTimes(2);expect(events.map(e=>[e.attempt,e.status,e.errorCode])).toEqual([[1,'failed','MODEL_SCHEMA_INVALID'],[2,'success',undefined]]);
  expect(events[0]?.outputText).toBe('{"ready":"yes"}');expect(events[1]?.outputText).toBe('{"ready":true}');
 });
 it.each(['invalid-json','truncated'] as const)('retains bounded visible %s output with a digest and no reasoning content',async kind=>{
  const output=kind==='invalid-json'?'not json':'{"ready":';const events:ModelStructuredOutputObservation[]=[];
  vi.stubGlobal('fetch',vi.fn(async()=>response(output,kind==='truncated'?'length':'stop')));
  await expect(invokeStructured({...base,maxAttempts:1,structuredOutputObserver:e=>events.push(e)},{role:'semantic_intent'},schema,'interpret')).rejects.toThrow();
  expect(events[0]).toMatchObject({status:'failed',outputText:output,outputDigest:hash(output),outputLength:output.length});
 });
 it('omits oversize UTF-8 data completely rather than publishing a cropped span',async()=>{
  const output=JSON.stringify({text:'字'.repeat(23000)});expect(output.length).toBeLessThan(MODEL_STRUCTURED_OUTPUT_MAX_BYTES);expect(Buffer.byteLength(output)).toBeGreaterThan(MODEL_STRUCTURED_OUTPUT_MAX_BYTES);
  const events:ModelStructuredOutputObservation[]=[];vi.stubGlobal('fetch',vi.fn(async()=>response(output)));
  await invokeStructured({...base,structuredOutputObserver:e=>events.push(e)},{role:'semantic_intent'},z.object({text:z.string()}),'interpret');
  expect(events[0]).toMatchObject({status:'success',outputOmitted:'size_limit',outputDigest:hash(output),outputLength:output.length});expect(events[0]).not.toHaveProperty('outputText');
 });
 it('records missing visible output without inventing empty content',async()=>{
  const events:ModelStructuredOutputObservation[]=[];vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:503})));
  await expect(invokeStructured({...base,maxAttempts:1,structuredOutputObserver:e=>events.push(e)},{role:'semantic_intent'},schema,'interpret')).rejects.toThrow('MODEL_HTTP_503');
  expect(events[0]).toMatchObject({status:'failed',outputOmitted:'not_text'});expect(events[0]).not.toHaveProperty('outputText');
 });
 it('does not repeat HTTP after a trace sink failure, including a repairable first response',async()=>{
  const order:string[]=[];const fetch=vi.fn(async()=>response('{"ready":"invalid"}'));vi.stubGlobal('fetch',fetch);
  await expect(invokeStructured({...base,attemptObserver:async e=>{order.push(e.type);},structuredOutputObserver:()=>{throw new Error('trace-write-failed');}},{role:'semantic_intent'},schema,'interpret')).rejects.toThrow('trace-write-failed');
  expect(fetch).toHaveBeenCalledTimes(1);expect(order).toEqual(['attempt_start','attempt_end']);
 });
 it('never activates raw capture from environment configuration',()=>{
  expect(providerFromEnv({BANKPILOT_MODEL_BASE_URL:base.baseURL,BANKPILOT_MODEL_NAME:base.model,BANKPILOT_MODEL_STRUCTURED_OUTPUT_OBSERVER:'true'})).not.toHaveProperty('structuredOutputObserver');
 });
});
