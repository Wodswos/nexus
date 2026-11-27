import {describe,it,expect,afterEach} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {providerSession,type ProviderEvent} from '../src/agents/provider';
import {HostSession} from '../src/agents/host';
const fixture=fileURLToPath(new URL('./fixtures/codex-app-server.mjs',import.meta.url));
const host=fileURLToPath(new URL('../dist/agent-host.cjs',import.meta.url));
const clean:(()=>void)[]=[];afterEach(()=>{clean.splice(0).reverse().forEach(fn=>fn());});
function transport(args:string[]){const process_=spawn(process.execPath,args,{stdio:['pipe','pipe','pipe']});clean.push(()=>process_.kill('SIGKILL'));const closed=new Promise<{code:number|null}>(resolve=>process_.on('close',code=>resolve({code})));return{stdin:process_.stdin,stdout:process_.stdout,stderr:process_.stderr,closed,close:()=>{process_.kill('SIGTERM');}};}
describe('Native provider and durable execution host',()=>{
 it('maps Codex text, native approvals, receipt and turn completion without TUI parsing',async()=>{const events:ProviderEvent[]=[];let allowed=false,accepted=false;const p=providerSession('codex',transport([fixture]),event=>events.push(event),async(method,params)=>{expect(method).toBe('session/request_permission');expect(params.options.map((o:any)=>o.optionId)).toEqual(['accept','decline']);allowed=true;return{outcome:{outcome:'selected',optionId:'decline'}};});expect(await p.open({directory:'/tmp'})).toBe('thread-fixture');expect(p.capabilities.resume).toBe(true);await p.turn('approval','run-1',()=>{accepted=true;});expect(allowed&&accepted).toBe(true);const messages=events.filter(e=>e.kind==='assistant');expect(new Set(messages.map(e=>e.data?.messageId)).size).toBe(1);expect(messages.at(-1)?.data?.delta).not.toBe(true);p.close();});
 it('detaches and reattaches to the same remote process, deduplicates an uncertain turn, and replays only missing events',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nexus-host-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));const receipt=join(root,'receipts');writeFileSync(join(root,'config.json'),JSON.stringify({mode:'codex',directory:root,command:`${process.execPath} ${fixture}`,env:{FIXTURE_RECEIPTS:receipt}}));writeFileSync(join(root,'token'),'private-token');
  let cursor=0;const events:ProviderEvent[]=[];const receive=(event:ProviderEvent,sequence:number)=>{cursor=sequence;events.push(event);};
  const one=new HostSession(transport([host,root]),0,receive,async()=>({}));await one.open({directory:root});await one.subscribe();const pending=one.turn('slow','stable-run',()=>{}).catch(()=>{});await new Promise(r=>setTimeout(r,200));one.close();await pending;
  const count=events.length;const two=new HostSession(transport([host,root]),cursor,receive,async()=>({}));expect(await two.open({directory:root})).toBe('thread-fixture');await two.subscribe();await two.turn('slow','stable-run',()=>{});expect(readFileSync(receipt,'utf8').trim().split('\n')).toEqual(['slow']);expect(events.length).toBeGreaterThan(count);await expect(two.turn('changed','stable-run',()=>{})).rejects.toThrow('内容发生变化');await two.stop();two.close();await new Promise(r=>setTimeout(r,600));
 },10000);
});

describe('Remote Claude SDK bridge',()=>{
 it('uses the selected workdir and propagates SDK streaming, tools, and actual approval choices',async()=>{
  const {CLAUDE_BRIDGE}=await import('../src/agents/claudeBridge');
  const {mkdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'nexus-sdk-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  const moduleDir=join(root,'node_modules/@anthropic-ai/claude-agent-sdk');mkdirSync(moduleDir,{recursive:true});writeFileSync(join(moduleDir,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-agent-sdk',version:'test',type:'module',main:'index.js'}));
  writeFileSync(join(moduleDir,'index.js'),`export function query({prompt,options}){if(options.cwd!==process.cwd())throw new Error('Wrong execution directory');return(async function*(){yield{type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'中文回复'}}};yield{type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'pwd'}}]}};const result=await options.canUseTool('Bash',{command:'pwd'});if(result.behavior!=='deny')throw new Error('Approval not respected');yield{type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'rejected',is_error:true}]}};yield{type:'result',is_error:false};})();}`);
  const child=spawn(process.execPath,['-e',CLAUDE_BRIDGE],{cwd:root,stdio:['pipe','pipe','pipe']});clean.push(()=>child.kill('SIGKILL'));
  const events:ProviderEvent[]=[];const session=providerSession('claude',{stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,closed:new Promise(resolve=>child.on('close',code=>resolve({code}))),close:()=>{child.kill('SIGTERM');}},event=>events.push(event),async()=>({outcome:{outcome:'selected',optionId:'deny'}}));
  const id=await session.open({directory:root});expect(id).toBeTruthy();await session.turn('测试','claude-run',()=>{});expect(events.find(e=>e.kind==='assistant')?.text).toBe('中文回复');expect(events.filter(e=>e.kind==='tool').at(-1)?.data?.status).toBe('failed');session.close();
 });
});

describe('Host crash boundaries',()=>{
 it('refuses to replace a surviving native process after the host crashes and can explicitly stop the orphan',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nexus-host-crash-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'config.json'),JSON.stringify({mode:'codex',directory:root,command:`${process.execPath} ${fixture}`,env:{FIXTURE_KEEP_ALIVE:'1'}}));
  clean.push(()=>{try{const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));if(state.process)process.kill(-state.process.pid,'SIGKILL');}catch{}try{const lock=JSON.parse(readFileSync(join(root,'host.lock'),'utf8'));process.kill(lock.pid,'SIGKILL');}catch{}});
  const first=new HostSession(transport([host,root]),0,()=>{},async()=>({}));await first.open({directory:root});
  const state=JSON.parse(readFileSync(join(root,'state.json'),'utf8'));
  const lock=JSON.parse(readFileSync(join(root,'host.lock'),'utf8'));process.kill(lock.pid,'SIGKILL');first.close();
  await new Promise(resolve=>setTimeout(resolve,150));
  const second=new HostSession(transport([host,root]),0,()=>{},async()=>({}));
  await expect(second.open({directory:root})).rejects.toThrow('原生进程仍在运行');
  expect(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).process.pid).toBe(state.process.pid);
  await second.stop();second.close();await new Promise(resolve=>setTimeout(resolve,150));
  expect(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).process).toBeUndefined();
 },10000);
 it('does not start a new provider when durable state is corrupt',async()=>{
  const root=mkdtempSync(join(tmpdir(),'nexus-host-corrupt-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'config.json'),JSON.stringify({mode:'codex',directory:root,command:`${process.execPath} ${fixture}`,env:{}}));writeFileSync(join(root,'state.json'),'{invalid');
  const child=transport([host,root,'daemon']);let error='';child.stderr.on('data',bytes=>error+=bytes);await child.closed;
  expect(error).toContain('为避免重复执行');expect(readFileSync(join(root,'state.json'),'utf8')).toBe('{invalid');
 });
});
