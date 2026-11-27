import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as protocol from 'y-protocols/sync';
import {encodeFrame} from '../../../packages/crdt/src/framing';
import { DB } from '../src/db';
import { setupSync } from '../src/sync';
import { AgentService, validateAgentInput } from '../src/agents/service';
import { setupAgents } from '../src/agents/routes';
import { taskDescriptionService } from '../src/taskDescriptions';
import { PANES_COMMAND, parsePanes } from '../src/workspaces/runtime';
import { shellQuote } from '../src/connections';
import { WorkspaceError, WorkspaceService } from '../src/workspaces/service';
import { EMPTY_WORKSPACE, DEFAULT_AGENT_PROMPT, type WorkspaceEnvironment, type CreateWorkspaceAgent, type AgentMessage } from '../../../packages/core/src/index';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const fixture = fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url));
const wait = async (condition: () => boolean, timeout = 6000) => {
  const start = Date.now(); while (!condition()) { if (Date.now() - start > timeout) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
function setup(mode = 'normal', route = false) {
  const path = mkdtempSync(join(tmpdir(), 'nexus-agents-')), db = new DB(path), server = createServer(), sync = setupSync(server, db, ticket => ticket==='fixture-ticket'?{userId:db.getUserByUsername('alice')!.id,sessionToken:'fixture-session'}:null);
  const user = db.createUser('alice', 'hash', 'salt', true).id, other = db.createUser('bob', 'hash', 'salt', false).id;
  let task = '', childTask = '', otherTask = '';
  sync.withStore(user, true, store => { task = store.createTask({ title: '父任务', notes: '  人工说明\n\n' }).id; childTask = store.createTask({ title: '子任务', parentId: task }).id; });
  sync.withStore(other, true, store => { otherTask = store.createTask({ title: '私有任务' }).id; });
  let environment: WorkspaceEnvironment = { id: 'environment', taskId: task, config: { ...EMPTY_WORKSPACE, serverId: 'host' }, connectionHost: 'fixture', state: 'ready', managed: true, resourceId: '', session: 'session', directory: '/tmp', createdAt: Date.now(), updatedAt: Date.now() };
  const calls: { env: Record<string, string>; command: string }[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const remote = {
    environment: (id: string, environmentId: string) => { if (id !== user || environmentId !== 'environment') throw new WorkspaceError('环境不存在', 404); return structuredClone(environment); },
    openAgentTransport: vi.fn(async (_: string, _id: string, command: string, options: {env: Record<string, string>}) => {
      calls.push({ env: options.env, command });
      const child = spawn(process.execPath, [fixture], { env: { ...process.env, ...options.env, FIXTURE_MODE: mode }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
      const closed = new Promise<{code: number|null}>(resolve => child.on('close', code => resolve({ code })));
      return { stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!, closed, close: () => { child.kill('SIGTERM'); } };
    }),
    agentWorkRoot: WorkspaceService.prototype.agentWorkRoot,
    agentProxyEnvironment: () => ({}),
    executeInEnvironment: vi.fn(async () => ''),
    panes: vi.fn(async () => [{id:'%1',sessionId:'$0',session:'session',windowId:'@0',window:'main',pid:42,serverPid:100,command:'node',directory:'/tmp',dead:false}]),
    capture: vi.fn(async () => 'terminal output'),
  } as unknown as WorkspaceService;
  let app = new Hono();
  const descriptions=taskDescriptionService(db,()=>sync),options={publicOrigin:'http://nexus.test',readTaskRevision:descriptions.read,updateTaskDescription:descriptions.update};
  let service = route ? setupAgents(app, db, remote, () => sync, c => c.req.header('X-Test-User') || null, options) : new AgentService(db, remote, () => sync, options);
  cleanups.push(() => { service.close(); for (const child of children) child.kill('SIGKILL'); sync.close(); server.close(); db.close(); rmSync(path, { recursive: true, force: true }); });
  const input = (patch: Partial<CreateWorkspaceAgent> = {}): CreateWorkspaceAgent => ({ requestId: crypto.randomUUID(), environmentId: 'environment', name: '研究员', persistentSession:false, mode: 'acp', command: 'fixture --acp', prompt: '处理当前任务 {{task_title}} {{task_context_url}}', ...patch });
  const restart = () => { service.close(); app = new Hono(); service = route ? setupAgents(app, db, remote, () => sync, c => c.req.header('X-Test-User') || null, options) : new AgentService(db, remote, () => sync, options); return service; };
  return { path, db, sync, user, other, task, childTask, otherTask, calls, remote, input, service, get app() { return app; }, children, restart,descriptions,server, setEnvironment: (patch: Partial<WorkspaceEnvironment>) => { environment = { ...environment, ...patch }; } };
}

describe('Agent lifecycle and task integration', () => {
  it('returns multiple choices to the live Harness question protocol without treating them as tool approval', async () => {
    const h=setup('question'),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).state==='waiting');
    const request=h.service.events(h.user,agent.id,0).events.find(event=>event.kind==='permission')!;
    expect((request.data?.questions as any[])[0].multiSelect).toBe(true);
    expect(()=>h.service.answer(h.user,agent.id,request.data?.permissionId,{scope:[]})).toThrow();
    h.service.answer(h.user,agent.id,request.data?.permissionId,{scope:['桌面端','手机端']});
    await wait(()=>h.service.get(h.user,agent.id).state==='idle');
    expect(h.service.events(h.user,agent.id,0).events.find(event=>event.kind==='assistant')?.text).toContain('"answers":["桌面端","手机端"]');
  });
  it('continues a conversation after acceptance without a separate round command, idempotently', async () => {
    const h=setup(),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const round=h.service.get(h.user,agent.id).currentRound!;
    h.service.report(h.user,agent.id,{requestId:'done',summary:'初步方案完成',suggestions:[{label:'实现方案',text:'请按方案实现'}]});
    h.service.reviewRound(h.user,agent.id,round.id,{requestId:'accept',action:'accept'});
    const message=h.service.send(h.user,agent.id,{requestId:'followup',text:'先比较另一种方案'});
    expect(h.service.send(h.user,agent.id,{requestId:'followup',text:'先比较另一种方案'}).id).toBe(message.id);
    expect(h.service.rounds(h.user,agent.id)).toHaveLength(2);
    expect(h.service.get(h.user,agent.id).currentRound?.objective).toBe('先比较另一种方案');
    expect(h.service.context(h.user,agent.id).reports[0]?.suggestions?.[0]?.label).toBe('实现方案');
    expect(h.sync.withStore(h.user,false,store=>store.getData().tasks.find(t=>t.id===h.task)!.status)).not.toBe('done');
  });

  it('persists callback choice questions and replies once, isolating agents and accounts', async () => {
    const h=setup(),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const input={requestId:'clarify',kind:'waiting',text:'先确认目标',questions:[{id:'scope',question:'先完成什么？',multiSelect:true,options:[{label:'设计',description:'先讨论设计'},{label:'原型',description:'验证体验'}]}]};
    const event=h.service.callbackEvent(h.user,agent.id,input),permissionId=event.data!.permissionId;
    expect(h.service.callbackEvent(h.user,agent.id,input).id).toBe(event.id);
    expect(h.service.context(h.user,agent.id).questions).toHaveLength(1);
    expect(()=>h.service.answer(h.other,agent.id,permissionId,{scope:['设计']})).toThrow();
    expect(()=>h.service.answer(h.user,agent.id,permissionId,{scope:[]})).toThrow();
    h.service.answer(h.user,agent.id,permissionId,{scope:['设计','原型']});
    h.service.answer(h.user,agent.id,permissionId,{scope:['设计','原型']});
    expect(h.service.context(h.user,agent.id).questions[0]?.answers).toEqual({scope:{answers:['设计','原型']}});
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id).filter(m=>m.text.includes('回答：设计；原型'))).toHaveLength(1);
    expect(()=>h.service.answer(h.user,agent.id,permissionId,{scope:['设计']})).toThrow('不同答案');
    const other=h.service.create(h.user,h.childTask,h.input({requestId:'second-agent'}));
    expect(()=>h.service.answer(h.user,other.id,permissionId,{scope:['设计','原型']})).toThrow('不属于');
    const resolved=h.service.snapshot(h.user,agent.id).items.find(item=>item.data?.permissionId===permissionId);
    expect(resolved?.data?.resolved).toBe(true);
  });

  it('free text replies dismiss callback questions and suggestions cannot execute work', async () => {
    const h=setup(),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    h.service.callbackEvent(h.user,agent.id,{requestId:'ask',kind:'waiting',text:'目标不明确',questions:[{id:'goal',question:'希望实现什么？',options:[]}]});
    h.service.send(h.user,agent.id,{requestId:'reply',text:'先解释原理'});
    expect(h.service.context(h.user,agent.id).questions[0]?.freeform).toBe('先解释原理');
    const before=h.db.agentMessages<AgentMessage>(h.user,agent.id).length;
    const suggestion=h.service.callbackEvent(h.user,agent.id,{requestId:'suggest',kind:'assistant',text:'可以继续',suggestions:[{label:'部署',text:'请先确认目标环境'}]});
    expect(suggestion.data?.suggestions).toEqual([{label:'部署',text:'请先确认目标环境'}]);
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id)).toHaveLength(before);
    expect(()=>h.service.callbackEvent(h.user,agent.id,{requestId:'invalid',kind:'waiting',text:'问题',questions:[{id:'same',question:'一'},{id:'same',question:'二'}]})).toThrow('唯一');
    expect(h.service.context(h.user,agent.id).interactionGuide).toContain('原生选择题工具');
  });
  it('blocks work area cleanup for other accounts, active references, terminals and dirty code',async()=>{
    const h=setup(), agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    h.setEnvironment({workRoot:'/tmp/nexus-test',directory:'/tmp/nexus-test/repo'});
    const record=h.db.agentRecord<any>(h.user,agent.id);record.directory='/tmp/nexus-test/nexus-agent/a';record.workArea={id:agent.id,agentId:agent.id,environmentId:'environment',directory:record.directory,kind:'directory',owned:true,createdAt:1};h.db.saveAgentRecord(h.user,record);
    vi.mocked(h.remote.executeInEnvironment).mockResolvedValue(JSON.stringify({exists:true,dirty:false,unpushed:false}));
    await expect(h.service.workAreaPlan(h.other,agent.id)).rejects.toThrow();
    expect((await h.service.workAreaPlan(h.user,agent.id)).blockers.length).toBeGreaterThan(0);
    await h.service.stop(h.user,agent.id);
    vi.mocked(h.remote.executeInEnvironment).mockResolvedValue(JSON.stringify({exists:true,dirty:true,unpushed:false}));
    await expect(h.service.cleanWorkArea(h.user,agent.id,{confirmDirectory:record.directory})).rejects.toThrow('未保存');
    vi.mocked(h.remote.executeInEnvironment).mockResolvedValue(JSON.stringify({exists:true,dirty:false,unpushed:false}));
    await h.service.cleanWorkArea(h.user,agent.id,{confirmDirectory:record.directory});
    expect(h.service.get(h.user,agent.id).workArea?.dataDeletedAt).toBeGreaterThan(0);
    expect(()=>h.service.resume(h.user,agent.id)).toThrow('已清理');
    await expect(h.service.terminal(h.user,agent.id)).rejects.toThrow('已清理');
    expect(h.service.snapshot(h.user,agent.id).items.length).toBeGreaterThan(0);
  });

  it('keeps a native Codex process, execution receipt and scoped credential through Nexus restart',async()=>{
    const h=setup();h.setEnvironment({directory:h.path,workRoot:h.path,layoutVersion:2});
    const nativeFixture=fileURLToPath(new URL('./fixtures/codex-app-server.mjs',import.meta.url));
    const receipt=join(h.path,'native-receipts');
    vi.mocked(h.remote.executeInEnvironment).mockImplementation(async(_u,_id,command,input)=>{
      const child=spawn('/bin/sh',['-c',command],{env:{...process.env,PATH:`${process.execPath.slice(0,process.execPath.lastIndexOf('/'))}:${process.env.PATH}`},stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.stdin.end(input);return await new Promise((resolve,reject)=>child.on('close',code=>code?reject(new Error(error)):resolve(output)));
    });
    vi.mocked(h.remote.openAgentTransport).mockImplementation(async(_u,_id,command,options)=>{
      const child=spawn('/bin/sh',['-c',command],{env:{...process.env,...options?.env,PATH:`${process.execPath.slice(0,process.execPath.lastIndexOf('/'))}:${process.env.PATH}`},stdio:['pipe','pipe','pipe']});h.children.push(child);return{stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,closed:new Promise(resolve=>child.on('close',code=>resolve({code}))),close:()=>{child.kill('SIGTERM');}};
    });
    const agent=h.service.create(h.user,h.task,h.input({mode:'codex',persistentSession:true,command:`FIXTURE_RECEIPTS=${shellQuote(receipt)} ${shellQuote(process.execPath)} ${shellQuote(nativeFixture)}`,prompt:'slow'}));
    await wait(()=>h.service.get(h.user,agent.id).state==='running');
    const saved=h.db.agentRecord<any>(h.user,agent.id),token=readFileSync(saved.hostRoot+'/token','utf8');
    const recovered=h.restart();
    await wait(()=>recovered.get(h.user,agent.id).state==='idle'&&recovered.get(h.user,agent.id).stage==='ready',10000);
    expect(recovered.authenticate(token,agent.id).userId).toBe(h.user);
    expect(readFileSync(receipt,'utf8').trim().split('\n')).toEqual(['slow']);
    const snapshot=recovered.snapshot(h.user,agent.id);
    expect(snapshot.items.filter(item=>item.kind==='assistant')).toHaveLength(1);
    expect(snapshot.items.find(item=>item.kind==='assistant')?.text).toBe('正在处理中文 slow');
    expect(snapshot.runs[0]?.state).toBe('completed');
    await recovered.stop(h.user,agent.id);
    await new Promise(resolve=>setTimeout(resolve,600));
    recovered.resume(h.user,agent.id);
    await wait(()=>recovered.get(h.user,agent.id).stage==='ready',10000);
    expect(recovered.get(h.user,agent.id).remoteSessionId).toBe(saved.remoteSessionId);
    expect(readFileSync(receipt,'utf8').trim().split('\n')).toEqual(['slow']);
    await recovered.stop(h.user,agent.id);
    await new Promise(resolve=>setTimeout(resolve,600));
  },15000);
  it('isolates provider, bindings, queue and projected history across accounts',async()=>{
    const h=setup();h.setEnvironment({state:'queued'});
    const provider=h.service.saveProvider(h.user,{name:'Codex account',harness:'codex',configDirectory:'/private/codex'});
    expect(h.service.providers(h.other)).toEqual([]);
    expect(()=>h.service.create(h.user,h.task,h.input({providerId:provider.id}))).toThrow('产品不匹配');
    h.service.bind(h.user,h.task,{environmentId:'environment'});
    expect(h.service.bindings(h.user,h.childTask)[0]?.inherited).toBe(true);
    expect(()=>h.service.bind(h.other,h.otherTask,{environmentId:'environment'})).toThrow();
    const agent=h.service.create(h.user,h.task,h.input());
    const message=h.service.send(h.user,agent.id,{requestId:'queued-api',text:'original'});
    h.service.queue(h.user,agent.id,message.id,{text:'updated'});
    expect(h.service.snapshot(h.user,agent.id).items.find(item=>item.kind==='user'&&item.data?.messageId===message.id)?.text).toBe('updated');
    h.service.queue(h.user,agent.id,message.id,{cancel:true});
    expect(h.service.snapshot(h.user,agent.id).runs.find(run=>run.id===message.id)?.state).toBe('cancelled');
    expect(()=>h.service.snapshot(h.other,agent.id)).toThrow();
  });
  it('keeps an existing Agent and scoped context available when its Task is archived',async()=>{
    const h=setup(),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    h.sync.withStore(h.user,true,store=>store.updateTask(h.task,{status:'archived'}));
    expect(h.service.context(h.user,agent.id).task.status).toBe('archived');
    expect(h.service.authenticate(h.calls[0]!.env.NEXUS_AGENT_TOKEN!,agent.id).userId).toBe(h.user);
    const message=h.service.send(h.user,agent.id,{requestId:'continue-archived',text:'继续已授权工作'});
    await wait(()=>h.db.agentMessages<AgentMessage>(h.user,agent.id).some(m=>m.id===message.id&&m.state==='delivered'));
    expect(()=>h.service.create(h.user,h.task,h.input())).toThrow('已归档');
  });
  it('starts real ACP stdio, binds child Task and keeps credentials out of public records/events', async () => {
    const h = setup(), body = h.input(), agent = h.service.create(h.user, h.childTask, body);
    await wait(() => h.service.get(h.user, agent.id).stage === 'ready');
    expect(agent.currentRound?.kind).toBe('auto');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.env.NEXUS_TASK_ID).toBe(h.childTask);
    expect(agent.prompt).toContain(`taskId=${h.childTask}`);
    expect(agent.prompt).toContain(agent.id);
    expect(agent.prompt).not.toContain(`taskId=${h.task}`);
    const events = h.service.events(h.user, agent.id, 0).events;
    expect(events.some(e => e.kind === 'assistant' && e.text.includes('已处理'))).toBe(true);
    expect(events.some(e => e.kind === 'tool')).toBe(true);
    expect(JSON.stringify({agent:h.service.get(h.user,agent.id),events})).not.toContain(h.calls[0]!.env.NEXUS_AGENT_TOKEN!);
    expect(h.service.authenticate(h.calls[0]!.env.NEXUS_AGENT_TOKEN!, agent.id).userId).toBe(h.user);
  });
  it('creates multiple independent Agents and preserves idempotency after environment directory resolves', async () => {
    const h = setup(); h.setEnvironment({state:'queued',directory:''});
    const body = h.input(), one = h.service.create(h.user,h.task,body), two = h.service.create(h.user,h.task,h.input());
    h.setEnvironment({state:'ready',directory:'/repo'});
    expect(h.service.create(h.user,h.task,body).id).toBe(one.id);
    expect(() => h.service.create(h.user,h.task,{...body,name:'changed'})).toThrow('请求 ID');
    await wait(() => h.service.get(h.user,one.id).stage==='ready' && h.service.get(h.user,two.id).stage==='ready');
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.env.NEXUS_AGENT_TOKEN).not.toBe(h.calls[1]!.env.NEXUS_AGENT_TOKEN);
    expect(() => h.service.authenticate(h.calls[0]!.env.NEXUS_AGENT_TOKEN!, two.id)).toThrow();
  });
  it('defaults to task prompt, enforces account ownership, validates before remote effects', () => {
    const h = setup(); h.setEnvironment({state:'queued'});
    h.sync.withStore(h.user, true, store => {
      store.saveWorkspaceProfile({ id: 'legacy-template', name: '旧模板', config: { ...EMPTY_WORKSPACE, serverId: 'host' }, promptTemplate: '旧环境 Prompt 不应覆盖 Agent 指令', createdAt: 1, updatedAt: 1 });
      store.setWorkspace(h.task, { mode: 'inherit', workspaceId: 'legacy-template' });
    });
    expect(h.service.prompt(h.user, h.task, 'http://nexus.test').prompt).toContain('通过 REST API');
    expect(h.service.prompt(h.user, h.task, 'http://nexus.test').prompt).not.toContain('旧环境 Prompt');
    const body = h.input(); delete body.prompt;
    const agent=h.service.create(h.user,h.task,body);
    expect(agent.prompt).toContain('通过 REST API');
    expect(agent.prompt).not.toContain('旧环境 Prompt');
    expect(() => h.service.get(h.other,agent.id)).toThrow();
    expect(() => h.service.create(h.other,h.otherTask,h.input())).toThrow();
    expect(() => validateAgentInput({...body,command:''})).toThrow();
    expect(h.calls).toHaveLength(0);
    expect(DEFAULT_AGENT_PROMPT).toContain('{{task_context_url}}');
  });
  it('requires explicit human permission and records answer, with no automatic approval', async () => {
    const h=setup('permission'), agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).state==='waiting');
    const event=h.service.events(h.user,agent.id,0).events.find(e=>e.kind==='permission')!;
    expect(event.data?.options).toHaveLength(2);
    expect(()=>h.service.permission(h.other,agent.id,event.data?.permissionId,'allow')).toThrow();
    expect(()=>h.service.permission(h.user,agent.id,event.data?.permissionId,'invented')).toThrow();
    h.service.permission(h.user,agent.id,event.data?.permissionId,'deny');
    await wait(()=>h.service.get(h.user,agent.id).state==='idle');
    expect(h.service.events(h.user,agent.id,0).events.some(e=>e.kind==='permission' && e.data?.resolved===true)).toBe(true);
    expect(h.service.events(h.user,agent.id,0).events.filter(e=>e.kind==='assistant').map(e=>e.text).join('')).toContain('deny');
  });
  it('queues messages once and isolates per-Agent acknowledgement', async () => {
    const h=setup(), agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const body={requestId:'follow-up',text:'中文与多行\n$(not shell)'};
    const message=h.service.send(h.user,agent.id,body);
    expect(h.service.send(h.user,agent.id,body).id).toBe(message.id);
    expect(()=>h.service.send(h.user,agent.id,{...body,text:'changed'})).toThrow();
    await wait(()=>h.db.agentMessages<AgentMessage>(h.user,agent.id).find(m=>m.id===message.id)?.state==='delivered');
    expect(h.service.unread(h.user,agent.id).some(m=>m.id===message.id)).toBe(true);
    h.service.acknowledge(h.user,agent.id,[message.id]);
    expect(h.service.unread(h.user,agent.id).some(m=>m.id===message.id)).toBe(false);
    expect(()=>h.service.acknowledge(h.user,agent.id,['other-agent-message'])).toThrow();
  });
  it('persists independent reports atomically, preserves human notes, and never completes the task implicitly', async () => {
    const h=setup(), a=h.service.create(h.user,h.task,h.input()), b=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,a.id).stage==='ready' && h.service.get(h.user,b.id).stage==='ready');
    const report={requestId:'report-1',summary:'实现完成',verification:'测试通过',remaining:'待评审',artifacts:['https://example.test/pr/1'],writeBack:true};
    const first=h.service.report(h.user,a.id,report);
    h.service.report(h.user,b.id,{...report,summary:'复核完成'});
    expect(h.service.report(h.user,a.id,report).id).toBe(first.id);
    const task=h.sync.withStore(h.user,false,store=>store.getData().tasks.find(t=>t.id===h.task)!);
    expect(task.notes!.startsWith('  人工说明\n\n')).toBe(true);
    expect(task.notes).toContain('实现完成');expect(task.notes).toContain('复核完成');
    expect(task.notes!.match(/### Agent 工作记录/g)).toHaveLength(2);
    expect(task.status).not.toBe('done');
    expect(()=>h.service.report(h.user,a.id,{...report,summary:'changed'})).toThrow();
    expect(h.db.agentReports(h.user,h.task)).toHaveLength(2);
  });
  it('cancels an active ACP turn, retains queued messages for explicit continuation', async () => {
    const h=setup('slow'), agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).state==='running');
    const queued=h.service.send(h.user,agent.id,{requestId:'queued',text:'later'});
    await h.service.cancel(h.user,agent.id);
    await wait(()=>h.service.get(h.user,agent.id).state==='interrupted');
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id).find(m=>m.id===queued.id)?.state).toBe('queued');
    await h.service.stop(h.user,agent.id);
    expect(()=>h.service.authenticate(h.calls[0]!.env.NEXUS_AGENT_TOKEN!,agent.id)).toThrow();
  });
  it('recovers after restart without resending a message whose delivery is uncertain', async () => {
    const h=setup('slow'), agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).state==='running');
    const oldToken=h.calls[0]!.env.NEXUS_AGENT_TOKEN!;
    const recovered=h.restart();
    expect(recovered.get(h.user,agent.id).state).toBe('disconnected');
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id)[0]!.state).toBe('unknown');
    expect(()=>recovered.authenticate(oldToken,agent.id)).toThrow();
    recovered.resume(h.user,agent.id);
    await wait(()=>recovered.get(h.user,agent.id).stage==='ready');
    expect(h.calls).toHaveLength(2);
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id)[0]!.state).toBe('unknown');
  });
  it('requires an explicit new session when an Agent cannot load previous sessions', async () => {
    const h=setup('no-resume'),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const recovered=h.restart();
    expect(()=>recovered.resume(h.user,agent.id)).toThrow('新会话');
    recovered.resume(h.user,agent.id,true);
    await wait(()=>recovered.get(h.user,agent.id).stage==='ready');
    expect(h.calls).toHaveLength(2);
    expect(h.service.events(h.user,agent.id,0).events.some(e=>e.kind==='user' && e.text.includes('不要自动重放历史指令'))).toBe(true);
  });
  it('keeps a real tmux callback credential across service restart and same-pane resume, then revokes it on stop', async () => {
    const h = setup('normal', true), socket = join(h.path, 'tmux'); mkdirSync(socket, { mode: 0o700 });
    const env = { ...process.env, TMUX_TMPDIR: socket };
    const run = (command: string, input?: string) => new Promise<string>((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { env, stdio: ['pipe','pipe','pipe'] }); let output = '', error = '';
      child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => error += bytes);
      child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error))); child.stdin.end(input);
    });
    expect(spawnSync('tmux', ['-f','/dev/null','new-session','-d','-s','session'], { env }).status).toBe(0);
    cleanups.push(() => { spawnSync('tmux', ['kill-server'], { env }); });
    h.remote.executeInEnvironment = vi.fn(async (_user, _id, command, input) => run(command, input));
    h.remote.panes = vi.fn(async () => parsePanes(await run(PANES_COMMAND)));
    const fixturePath = fileURLToPath(new URL('./fixtures/terminal-agent.mjs', import.meta.url));
    const a = h.service.create(h.user, h.task, h.input({ mode: 'tmux', command: `${shellQuote(process.execPath)} ${shellQuote(fixturePath)}` }));
    const tokenFile = `/tmp/nexus-agent-${a.id}/token`;
    cleanups.push(() => rmSync(`/tmp/nexus-agent-${a.id}`, { recursive: true, force: true }));
    await wait(() => h.service.get(h.user, a.id).stage === 'ready');
    const token = readFileSync(tokenFile, 'utf8'), pane = h.service.get(h.user, a.id).pane!;
    const request = (suffix: string, method = 'GET', body?: unknown, credential = token) => h.app.request(`http://nexus.test/api/agent-context/${a.id}${suffix}`, {
      method, headers: { Authorization: `Bearer ${credential}` }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect((await request('')).status).toBe(200);
    expect((await request('/events', 'POST', { requestId: 'waiting-before-restart', kind: 'waiting', text: '请确认设计' })).status).toBe(200);
    const message = h.db.agentMessages<AgentMessage>(h.user, a.id)[0]!;
    const uncertain: AgentMessage = { id: 'uncertain', agentId: a.id, text: 'do not replay', state: 'unknown', createdAt: Date.now(), updatedAt: Date.now() };
    h.db.saveAgentMessage(h.user, uncertain);
    const remoteCalls = vi.mocked(h.remote.executeInEnvironment).mock.calls.length;
    const recovered = h.restart();
    expect(recovered.get(h.user, a.id).state).toBe('waiting');
    expect((await request('')).status).toBe(200);
    expect((await request('/messages/ack', 'POST', { messageIds: [message.id] })).status).toBe(200);
    expect((await request('/events', 'POST', { requestId: 'waiting-after-restart', kind: 'waiting', text: '仍等待确认' })).status).toBe(200);
    await wait(() => recovered.events(h.user, a.id, 0).events.some(e => e.text.includes('重新关联原 tmux')));
    expect(recovered.get(h.user, a.id).state).toBe('waiting');
    expect(h.remote.executeInEnvironment).toHaveBeenCalledTimes(remoteCalls);
    expect(readFileSync(tokenFile, 'utf8')).toBe(token);
    expect(h.db.agentMessages<AgentMessage>(h.user, a.id).find(m => m.id === 'uncertain')?.state).toBe('unknown');

    recovered.close();
    const record = h.db.agentRecord<any>(h.user, a.id)!;
    h.db.saveAgentRecord(h.user, { ...record, state: 'disconnected', error: '模拟仅控制连接断开' });
    const resumed = h.restart(); resumed.resume(h.user, a.id);
    await wait(() => resumed.get(h.user, a.id).stage === 'ready');
    expect(resumed.get(h.user, a.id).pane).toMatchObject({ id: pane.id, pid: pane.pid, serverPid: pane.serverPid });
    expect(readFileSync(tokenFile, 'utf8')).toBe(token);
    expect((await request('')).status).toBe(200);
    expect(h.db.agentMessages<AgentMessage>(h.user, a.id)).toHaveLength(2);
    await resumed.stop(h.user, a.id);
    expect((await request('')).status).toBe(401);
    expect(h.db.findAgentToken(token)).toBeNull();
  }, 15000);

  it('reconciles persisted pane identity before queued delivery and revokes a replaced process credential', async () => {
    const h = setup(); h.setEnvironment({ state: 'queued' });
    const a = h.service.create(h.user, h.task, h.input({ mode: 'tmux', command: 'fixture' }));
    const record = h.db.agentRecord<any>(h.user, a.id)!;
    h.db.saveAgentRecord(h.user, { ...record, state: 'running', stage: 'ready', pane: { id: '%1', pid: 41, serverPid: 100 } });
    const token = h.db.createAgentToken(h.user, a.id); h.setEnvironment({ state: 'ready' });
    const recovered = h.restart();
    await wait(() => recovered.get(h.user, a.id).state === 'disconnected');
    expect(h.remote.executeInEnvironment).not.toHaveBeenCalled();
    expect(h.db.agentMessages<AgentMessage>(h.user, a.id)[0]!.state).toBe('queued');
    expect(() => recovered.authenticate(token, a.id)).toThrow();
  });

  it('renews valid scoped credentials on use without reviving expired or revoked tokens', () => {
    const h = setup(); h.setEnvironment({ state: 'queued' });
    const a = h.service.create(h.user, h.task, h.input()), b = h.service.create(h.user, h.childTask, h.input());
    const token = h.db.createAgentToken(h.user, a.id), other = h.db.createAgentToken(h.user, b.id);
    const realNow = Date.now.bind(Date); let days = 6.5;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + days * 86400000);
    try {
      expect(h.service.authenticate(token, a.id).userId).toBe(h.user);
      expect(() => h.service.authenticate(other, a.id)).toThrow();
      days = 7.5;
      expect(h.service.authenticate(token, a.id).userId).toBe(h.user);
      expect(h.db.findAgentToken(other)).toBeNull();
      h.db.renewAgentToken(other); expect(h.db.findAgentToken(other)).toBeNull();
      days = 15;
      expect(() => h.service.authenticate(token, a.id)).toThrow();
      h.db.renewAgentToken(token); expect(h.db.findAgentToken(token)).toBeNull();
    } finally { clock.mockRestore(); }
    h.db.revokeAgentTokens(h.user, a.id); h.db.renewAgentToken(token);
    expect(h.db.findAgentToken(token)).toBeNull();
  });
  it('marks a broken ACP handshake as failure and never interprets terminal output as conversation', async () => {
    const h=setup('malformed'),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).state==='failed');
    expect(h.service.get(h.user,agent.id).error).toContain('ACP');
    expect(h.service.events(h.user,agent.id,0).events.some(e=>e.kind==='assistant')).toBe(false);
  });
  it('records transport loss as disconnected and does not retry uncertain prompts', async () => {
    const h=setup('disconnect'),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).state==='disconnected');
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id)[0]!.state).toBe('unknown');
    expect(h.calls).toHaveLength(1);
  });
  it('exposes authenticated browser routes and task-scoped callbacks with credential revocation', async () => {
    const h=setup('normal',true),request=(path:string,method='GET',body?:unknown,user=h.user,token?:string)=>h.app.request('http://nexus.test'+path,{method,headers:{...(user?{'X-Test-User':user}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
    expect((await request(`/api/tasks/${h.task}/agents`,'GET',undefined,'')).status).toBe(401);
    const response=await request(`/api/tasks/${h.task}/agents`,'POST',h.input());
    const agent=(await response.json() as {data: {id:string}}).data;
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    expect((await request(`/api/agents/${agent.id}`,'GET',undefined,h.other)).status).toBe(404);
    const token=h.calls[0]!.env.NEXUS_AGENT_TOKEN!;
    expect((await request(`/api/agent-context/${agent.id}`,'GET',undefined,'')).status).toBe(401);
    expect((await request(`/api/agent-context/${agent.id}`,'GET',undefined,'',token)).status).toBe(200);
    expect((await request(`/api/agent-context/${agent.id}?taskId=${h.otherTask}`,'GET',undefined,'',token)).status).toBe(403);
    expect((await request(`/api/agents/${agent.id}`,'GET',undefined,'',token)).status).toBe(401);
    await request(`/api/agents/${agent.id}/stop`,'POST',{});
    expect((await request(`/api/agent-context/${agent.id}`,'GET',undefined,'',token)).status).not.toBe(200);
  });
  it('creates real isolated tmux Agent panes with private credentials outside Git, delivers literal text, and stops only its own pane', async () => {
    const h=setup(),socket=join(h.path,'tmux'); mkdirSync(socket,{mode:0o700});
    const env={...process.env,TMUX:'',TMUX_TMPDIR:socket};
    const run=(command:string,input?:string)=>new Promise<string>((resolve,reject)=>{
      const child=spawn('sh',['-c',command],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      // exit may precede draining stdout under load; pane discovery consumes
      // this output, so resolve only once the process's pipes have closed.
      child.on('close',code=>code===0?resolve(stdout):reject(new Error(stderr)));child.stdin.end(input);
    });
    const started=spawnSync('tmux',['-f','/dev/null','new-session','-d','-s','session'],{env,stdio:'ignore'}); expect(started.status).toBe(0);
    cleanups.push(()=>{spawnSync('tmux',['kill-server'],{env});});
    h.remote.executeInEnvironment=vi.fn(async (_user,_id,command,input)=>run(command,input));
    h.remote.panes=vi.fn(async()=>parsePanes(await run(PANES_COMMAND)));
    h.remote.capture=vi.fn(async(_user,_id,paneId)=>run(`tmux capture-pane -p -t ${shellQuote(paneId)}`));
    const terminalFixture=fileURLToPath(new URL('./fixtures/terminal-agent.mjs',import.meta.url));
    const agent=h.service.create(h.user,h.task,h.input({mode:'tmux',command:`${shellQuote(process.execPath)} ${shellQuote(terminalFixture)}`,prompt:'literal $(echo injected) 中文'}));
    cleanups.push(()=>rmSync(`/tmp/nexus-agent-${agent.id}`,{recursive:true,force:true}));
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready' || h.service.get(h.user,agent.id).state==='failed');
    const current=h.service.get(h.user,agent.id);expect(current.error).toBeUndefined();expect(current.pane).toBeDefined();
    const tokenFile=`/tmp/nexus-agent-${agent.id}/token`;
    expect(existsSync(tokenFile)).toBe(true);expect(readFileSync(tokenFile,'utf8')).toMatch(/^nxa_/);
    await wait(()=>h.db.agentMessages<AgentMessage>(h.user,agent.id)[0]!.state==='delivered');
    const capture=()=>run(`tmux capture-pane -p -t ${shellQuote(current.pane!.id)}`);
    // A delivered message means tmux accepted the input, not that the program
    // has already processed it. Wait for the fixture's application-level reply.
    await expect.poll(capture,{timeout:3000}).toContain('received:');
    const output=await capture();
    expect(output).toContain('literal $(echo injected) 中文');
    expect(output).toContain('received:');
    // Rendering must not turn screen refreshes into repeated SSH captures/events.
    const paneReads = vi.mocked(h.remote.panes).mock.calls.length;
    const remoteCommands = vi.mocked(h.remote.executeInEnvironment).mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(h.remote.panes).toHaveBeenCalledTimes(paneReads);
    expect(h.remote.capture).not.toHaveBeenCalled();
    expect(h.service.events(h.user, agent.id, 0).events.filter(e => e.kind === 'terminal')).toHaveLength(0);
    // A failed read-only probe must neither revoke the callback token nor
    // relaunch the CLI/replay the prompt. Keep real time advancing for wait().
    const realNow = Date.now.bind(Date); let offset = 31000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      vi.mocked(h.remote.panes).mockRejectedValueOnce(new Error('kex_exchange_identification: read: Connection reset by peer'));
      await wait(() => h.service.events(h.user, agent.id, 0).events.some(e => e.text.includes('暂时无法检查')));
      expect(h.service.get(h.user, agent.id).state).toBe('running');
      expect(h.service.authenticate(readFileSync(tokenFile, 'utf8'), agent.id).userId).toBe(h.user);
      offset += 30000;
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(h.remote.panes).toHaveBeenCalledTimes(paneReads + 1);
      offset += 31000;
      await wait(() => h.service.events(h.user, agent.id, 0).events.some(e => e.text.includes('已恢复远端会话状态检查')));
      expect(h.remote.panes).toHaveBeenCalledTimes(paneReads + 2);
      expect(h.remote.executeInEnvironment).toHaveBeenCalledTimes(remoteCommands);
      expect(h.db.agentMessages<AgentMessage>(h.user, agent.id)).toHaveLength(1);
    } finally { clock.mockRestore(); }
    await h.service.stop(h.user,agent.id);
    const panes=await h.remote.panes(h.user,'environment');expect(panes).toHaveLength(1);expect(panes[0]!.id).not.toBe(current.pane!.id);
    h.service.resume(h.user,agent.id);
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    expect(h.service.get(h.user,agent.id).pane!.id).not.toBe(current.pane!.id);
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id).filter(m=>m.id.startsWith('bootstrap-'))).toHaveLength(1);
  }, 15000);
  it('preserves immediate CLI failures, reports their exit output and retries only the owned pane', async () => {
    const h = setup(), socket = join(h.path, 'tmux'); mkdirSync(socket, { mode: 0o700 });
    const env = { ...process.env, TMUX: '', TMUX_TMPDIR: socket };
    const run = (command: string, input?: string) => new Promise<string>((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
      child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
      child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr))); child.stdin.end(input);
    });
    expect(spawnSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', 'session'], { env }).status).toBe(0);
    cleanups.push(() => { spawnSync('tmux', ['kill-server'], { env }); });
    h.remote.executeInEnvironment = vi.fn(async (_user, _id, command, input) => run(command, input));
    h.remote.panes = vi.fn(async () => parsePanes(await run(PANES_COMMAND)));
    h.remote.capture = vi.fn(async (_user, _id, paneId) => {
      if ((await h.remote.panes(h.user, 'environment')).find(value => value.id === paneId)?.dead) throw new WorkspaceError('Agent pane 已变化，请重新关联', 409);
      return run(`tmux capture-pane -p -t ${shellQuote(paneId)}`);
    });
    const started = join(h.path, 'startup-count'), script = join(h.path, 'fail-once');
    writeFileSync(script, `#!/bin/sh\nprintf run\\n >> ${shellQuote(started)}\nprintf 'missing model configuration\\n' >&2\nexit 23\n`, { mode: 0o700 });
    const agent = h.service.create(h.user, h.task, h.input({ mode: 'tmux', command: shellQuote(script), prompt: 'do not deliver to a failed CLI' }));
    cleanups.push(() => rmSync(`/tmp/nexus-agent-${agent.id}`, { recursive: true, force: true }));
    await wait(() => h.service.get(h.user, agent.id).state === 'failed');
    const failed = h.service.get(h.user, agent.id);
    expect(failed.error).toContain('退出码 23'); expect(failed.error).toContain('missing model configuration');
    expect(failed.error).not.toContain('no such window'); expect(failed.pane?.dead).toBe(true);
    expect((await h.remote.panes(h.user, 'environment')).filter(pane => !pane.dead)).toHaveLength(1);
    expect(h.db.agentMessages<AgentMessage>(h.user, agent.id)[0]!.state).toBe('queued');
    const fixturePath = fileURLToPath(new URL('./fixtures/terminal-agent.mjs', import.meta.url));
    writeFileSync(script, `#!/bin/sh\nprintf run\\n >> ${shellQuote(started)}\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)}\n`, { mode: 0o700 });
    h.service.retry(h.user, agent.id);
    await wait(() => h.service.get(h.user, agent.id).stage === 'ready');
    const ready = h.service.get(h.user, agent.id);
    expect(ready.error).toBeUndefined(); expect(ready.pane!.id).not.toBe(failed.pane!.id);
    await expect.poll(() => run(`tmux capture-pane -p -t ${shellQuote(ready.pane!.id)}`)).toContain('received:');
    expect((await h.remote.panes(h.user, 'environment'))).toHaveLength(2);
    expect(readFileSync(started, 'utf8').match(/run/g)).toHaveLength(2);
    await run(`tmux send-keys -t ${shellQuote(ready.pane!.id)} C-d`);
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31000);
    try { await wait(() => h.service.get(h.user, agent.id).state === 'disconnected'); }
    finally { clock.mockRestore(); }
    expect(h.service.get(h.user, agent.id).error).toContain('退出码 0');
  });

  it('shows the Workspace failure cause without starting an Agent or delivering its prompt', async () => {
    const h = setup(); h.setEnvironment({ state: 'queued' });
    const agent = h.service.create(h.user, h.task, h.input());
    h.setEnvironment({ state: 'failed', error: 'SSH connection reset by peer' });
    await wait(() => h.service.get(h.user, agent.id).state === 'failed');
    expect(h.service.get(h.user, agent.id).error).toContain('SSH connection reset by peer');
    expect(h.calls).toHaveLength(0);
    expect(h.db.agentMessages<AgentMessage>(h.user, agent.id)[0]!.state).toBe('queued');
  });

  it('creates an actual independent git worktree and leaves user modifications intact', async () => {
    const h=setup(),repo=join(h.path,'repo');mkdirSync(repo);
    for(const args of [['init','-q',repo],['-C',repo,'config','user.name','Fixture'],['-C',repo,'config','user.email','fixture@example.test']]) expect(spawnSync('git',args).status).toBe(0);
    writeFileSync(join(repo,'README'),'initial');expect(spawnSync('git',['-C',repo,'add','README']).status).toBe(0);expect(spawnSync('git',['-C',repo,'commit','-qm','initial']).status).toBe(0);
    writeFileSync(join(repo,'README'),'uncommitted human work');h.setEnvironment({directory:repo,workRoot:h.path});
    h.remote.executeInEnvironment=vi.fn(async(_user,_id,command,input)=>new Promise<string>((resolve,reject)=>{
      const child=spawn('sh',['-c',command],{stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('close',code=>code===0?resolve(output):reject(new Error(error)));child.stdin.end(input);
    }));
    const agent=h.service.create(h.user,h.task,h.input({worktree:true}));
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const directory=h.service.get(h.user,agent.id).directory;
    expect(directory).toBe(join(h.path,'nexus-agent',agent.id));expect(existsSync(join(directory,'.git'))).toBe(true);
    expect(spawnSync('git',['-C',directory,'symbolic-ref','--short','HEAD'],{encoding:'utf8'}).stdout.trim()).toBe(`nexus-agent/${agent.id}`);
    expect(readFileSync(join(directory,'README'),'utf8')).toBe('initial');expect(readFileSync(join(repo,'README'),'utf8')).toBe('uncommitted human work');
    const named = h.service.create(h.user, h.task, h.input({ worktree: true, worktreeName: 'agent-feature-unique' }));
    await wait(() => h.service.get(h.user, named.id).stage === 'ready');
    expect(h.service.get(h.user, named.id)).toMatchObject({ directory: join(h.path, 'nexus-agent', 'agent-feature-unique'), branch: 'nexus-agent/agent-feature-unique' });
    await wait(() => h.db.agentMessages<AgentMessage>(h.user, named.id).some(message => message.state === 'delivered'));
    expect(() => h.service.create(h.user, h.task, h.input({ worktree: true, worktreeName: 'agent-feature-unique' }))).toThrow(/名称已被使用/);
    h.setEnvironment({ workRoot: undefined, config: { ...EMPTY_WORKSPACE, serverId: 'host', workRoot: join(h.path, 'attached-root') }, managed: false });
    const attached = h.service.create(h.user, h.task, h.input({ worktree: true, worktreeName: 'attached-unique' }));
    await wait(() => h.service.get(h.user, attached.id).stage === 'ready');
    expect(h.service.get(h.user, attached.id).directory).toBe(join(h.path, 'attached-root', 'environment', 'nexus-agent', 'attached-unique'));
    expect(readFileSync(join(repo, 'README'), 'utf8')).toBe('uncommitted human work');
    h.setEnvironment({ state: 'queued', workRoot: h.path });
    const legacy = h.service.create(h.user, h.task, h.input({ worktree: true, worktreeName: 'legacy' }));
    const record = h.db.agentRecord<any>(h.user, legacy.id)!;
    delete record.worktreeLayoutVersion;
    h.db.saveAgentRecord(h.user, record);
    h.setEnvironment({ state: 'ready' });
    await wait(() => h.service.get(h.user, legacy.id).stage === 'ready');
    expect(h.service.get(h.user, legacy.id)).toMatchObject({ directory: join(h.path, 'worktrees', 'legacy'), branch: 'nexus/legacy' });
  });

  it('rejects mixed directory modes and unsafe worktree names before starting an Agent', () => {
    const h = setup();
    for (const patch of [{ worktree: true, directory: '/custom' }, { worktree: true, worktreeName: '../escape' }, { worktree: false, worktreeName: 'unused' }]) {
      expect(() => h.service.create(h.user, h.task, h.input(patch))).toThrow();
    }
    expect(h.service.list(h.user, h.task)).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it('keeps clarification messages in one explicit round and separates acceptance from Task completion', async()=>{
    const h=setup(),agent=h.service.create(h.user,h.task,h.input({round:{kind:'design',objective:'讨论可行方案',expectedOutcome:'方案文档',acceptanceCriteria:['列出取舍']}}));
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const first=agent.currentRound!;
    expect(first.baseRevisionId).toBe(h.descriptions.read(h.user,h.task).id);
    const follow=h.service.send(h.user,agent.id,{requestId:'clarification',text:'先比较两个方案'});
    expect(follow.roundId).toBe(first.id);
    await wait(()=>h.db.agentMessages<AgentMessage>(h.user,agent.id).find(m=>m.id===follow.id)?.state==='delivered');
    expect(()=>h.service.startRound(h.user,agent.id,{requestId:'premature',kind:'implement',objective:'实现'})).toThrow('先验收');
    expect(()=>h.service.report(h.user,agent.id,{requestId:'wrong',roundId:'another-round',summary:'错误报告'})).toThrow('当前轮次');
    const notes=h.descriptions.read(h.user,h.task).notes;
    h.service.report(h.user,agent.id,{requestId:'design-report',roundId:first.id,summary:'方案 A / B 与取舍'});
    expect(h.service.get(h.user,agent.id).currentRound?.state).toBe('awaiting_review');
    expect(h.descriptions.read(h.user,h.task).notes).toBe(notes);
    const revision=h.service.reviewRound(h.user,agent.id,first.id,{requestId:'revise',action:'revise',text:'补充成本'});
    expect(revision.round.id).toBe(first.id);expect(revision.round.state).toBe('running');
    await wait(()=>h.db.agentMessages<AgentMessage>(h.user,agent.id).every(m=>m.state==='delivered'));
    h.service.report(h.user,agent.id,{requestId:'revised',summary:'补充完成'});
    expect(()=>h.service.reviewRound(h.user,agent.id,first.id,{requestId:'complete-too-soon',action:'complete_task'})).toThrow('先验收');
    const accepted=h.service.reviewRound(h.user,agent.id,first.id,{requestId:'accept',action:'accept'});
    expect(accepted.taskCompleted).toBe(false);expect(accepted.round.state).toBe('accepted');
    expect(h.sync.withStore(h.user,false,store=>store.getData().tasks.find(t=>t.id===h.task)!.status)).not.toBe('done');
    expect(h.service.reviewRound(h.user,agent.id,first.id,{requestId:'complete',action:'complete_task'}).taskCompleted).toBe(true);
    expect(h.sync.withStore(h.user,false,store=>store.getData().tasks.find(t=>t.id===h.task)!.status)).toBe('done');
    const next=h.service.startRound(h.user,agent.id,{requestId:'next',kind:'implement',objective:'实现方案 A',expectedOutcome:'PR',acceptanceCriteria:['测试通过']});
    expect(next.sequence).toBe(2);expect(next.id).not.toBe(first.id);
    expect(h.service.startRound(h.user,agent.id,{requestId:'next',kind:'implement',objective:'实现方案 A',expectedOutcome:'PR',acceptanceCriteria:['测试通过']}).id).toBe(next.id);
    expect(h.service.context(h.user,agent.id).roundHistory.map(r=>r.id)).toEqual([first.id]);
    expect(h.service.unread(h.user,agent.id).every(m=>m.roundId===next.id)).toBe(true);
  });

  it('resumes user-waiting callbacks while never bypassing an outstanding permission request',async()=>{
    const h=setup(),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    h.service.callbackEvent(h.user,agent.id,{requestId:'question',kind:'waiting',text:'请选择方案'});
    expect(h.service.get(h.user,agent.id).waitReason).toBe('user');
    const reply=h.service.send(h.user,agent.id,{requestId:'answer',text:'使用方案 A'});
    await wait(()=>h.db.agentMessages<AgentMessage>(h.user,agent.id).find(m=>m.id===reply.id)?.state==='delivered');
    expect(h.service.get(h.user,agent.id).currentRound?.state).toBe('running');
    const p=setup('permission'),protectedAgent=p.service.create(p.user,p.task,p.input());
    await wait(()=>p.service.get(p.user,protectedAgent.id).state==='waiting');
    const queued=p.service.send(p.user,protectedAgent.id,{requestId:'follow-up-permission',text:'这是澄清消息，不是授权'});
    p.service.callbackEvent(p.user,protectedAgent.id,{requestId:'self-report',kind:'running',text:'试图继续'});
    expect(p.service.get(p.user,protectedAgent.id).waitReason).toBe('permission');
    expect(p.db.agentMessages<AgentMessage>(p.user,protectedAgent.id).find(m=>m.id===queued.id)?.state).toBe('queued');
    expect(p.service.events(p.user,protectedAgent.id,0).events.filter(e=>e.kind==='permission'&&e.data?.resolved)).toHaveLength(0);
  });

  it('explicitly abandons a round, cancels queued work and permits a new round without changing the Task',async()=>{
    const h=setup('slow'),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).state==='running');
    const queued=h.service.send(h.user,agent.id,{requestId:'queued-round',text:'以后再做的工作'}),roundId=agent.currentRoundId!;
    const cancelled=await h.service.cancelRound(h.user,agent.id,roundId,{requestId:'cancel-round',text:'切换研究方向'});
    expect(cancelled.round.state).toBe('cancelled');
    expect(h.db.agentMessages<AgentMessage>(h.user,agent.id).find(m=>m.id===queued.id)?.state).toBe('failed');
    expect((await h.service.cancelRound(h.user,agent.id,roundId,{requestId:'cancel-round',text:'切换研究方向'})).round.id).toBe(roundId);
    expect(h.sync.withStore(h.user,false,store=>store.getData().tasks.find(t=>t.id===h.task)!.status)).not.toBe('done');
    await wait(()=>!h.db.agentMessages<AgentMessage>(h.user,agent.id).some(m=>m.state==='sending'));
    const next=h.service.startRound(h.user,agent.id,{requestId:'new-direction',kind:'explore',objective:'验证新方向'});
    expect(next.sequence).toBe(2);expect(h.service.rounds(h.user,agent.id)[0]?.state).toBe('cancelled');
    await wait(()=>h.service.get(h.user,agent.id).state==='running');
    expect(h.service.unread(h.user,agent.id).every(m=>m.roundId===next.id)).toBe(true);
  });

  it('uses scoped CAS description updates and captures contextual revisions without inventing dependencies',async()=>{
    const h=setup(),agent=h.service.create(h.user,h.childTask,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const context=h.service.context(h.user,agent.id);
    expect(context.ancestors.map(t=>t.id)).toEqual([h.task]);expect(context.children).toEqual([]);
    expect(context).not.toHaveProperty('dependencies');
    const first=context.revision!;
    const updated=h.service.updateDescription(h.user,agent.id,{expectedRevisionId:first.id,notes:'保留任务背景并补充结论'}) as {id:string;agentId:string;roundId:string;source:string};
    expect(updated.id).not.toBe(first.id);expect(updated.agentId).toBe(agent.id);expect(updated.roundId).toBe(agent.currentRoundId);expect(updated.source).toBe('agent');
    expect(()=>h.service.updateDescription(h.user,agent.id,{expectedRevisionId:first.id,notes:'覆盖新内容'})).toThrow('正文已更新');
    expect(h.service.context(h.user,agent.id).revision?.notes).toBe('保留任务背景并补充结论');
    expect(h.descriptions.read(h.user,h.task).notes).toBe('  人工说明\n\n');
  });

  it('flushes pending browser text before creating or lazily migrating rounds without nested SQLite transactions',async()=>{
    const h=setup();h.setEnvironment({state:'queued'});
    await new Promise<void>(resolve=>h.server.listen(0,'127.0.0.1',resolve));
    const port=(h.server.address() as {port:number}).port,ws=new WebSocket(`ws://127.0.0.1:${port}/api/sync?ticket=fixture-ticket`),doc=new Y.Doc();
    cleanups.push(()=>{ws.terminate();doc.destroy();});
    Y.applyUpdate(doc,h.db.loadDocSnapshot(h.user,'tasks')!);
    await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    const first=encoding.createEncoder();protocol.writeSyncStep1(first,doc);ws.send(encodeFrame('tasks',encoding.toUint8Array(first)));
    const edit=async(text:string)=>{
      const before=Y.encodeStateVector(doc);doc.getMap<Y.Map<unknown>>('items').get(h.task)!.set('notes',text);
      const encoder=encoding.createEncoder();protocol.writeUpdate(encoder,Y.encodeStateAsUpdate(doc,before));ws.send(encodeFrame('tasks',encoding.toUint8Array(encoder)));
      // A pong follows the already processed update, without reading through
      // withStore (which would itself flush and hide the pending-history case).
      await new Promise<void>(resolve=>{ws.once('pong',()=>resolve());ws.ping();});
    };
    await edit('浏览器刚刚更新，尚未到 checkpoint 定时器');
    expect(h.db.taskRevisions.latest(h.user,h.task)?.notes).toBe('  人工说明\n\n');
    const agent=h.service.create(h.user,h.task,h.input());
    expect(h.db.taskRevisions.latest(h.user,h.task)?.notes).toBe('浏览器刚刚更新，尚未到 checkpoint 定时器');
    expect(agent.currentRound?.baseRevisionId).toBe(h.db.taskRevisions.latest(h.user,h.task)?.id);
    const legacy=h.db.agentRecord<any>(h.user,agent.id)!;delete legacy.currentRoundId;h.db.saveAgentRecord(h.user,legacy);
    await edit('旧 Agent 迁移前的新输入');
    expect(h.db.taskRevisions.latest(h.user,h.task)?.notes).not.toBe('旧 Agent 迁移前的新输入');
    expect(()=>h.service.callbackEvent(h.user,agent.id,{requestId:'legacy-progress',kind:'assistant',text:'继续处理'})).not.toThrow();
    expect(h.service.get(h.user,agent.id).currentRound?.baseRevisionId).toBe(h.db.taskRevisions.latest(h.user,h.task)?.id);
    expect(h.db.taskRevisions.latest(h.user,h.task)?.notes).toBe('旧 Agent 迁移前的新输入');
    ws.close();await new Promise<void>(resolve=>ws.once('close',()=>resolve()));
  });

  it('groups the global workbench by Task once, preserving multiple attention reasons and account isolation',async()=>{
    const h=setup(),a=h.service.create(h.user,h.task,h.input()),b=h.service.create(h.user,h.task,h.input()),c=h.service.create(h.user,h.childTask,h.input());
    await wait(()=>[a,b,c].every(agent=>h.service.get(h.user,agent.id).stage==='ready'));
    h.service.report(h.user,a.id,{requestId:'report',summary:'待验收'});
    h.service.callbackEvent(h.user,b.id,{requestId:'waiting',kind:'waiting',text:'需要用户决策'});
    const work=h.service.workbench(h.user),row=work.groups.waiting[0] as {agents:unknown[];reasons:string[];taskId:string};
    expect(work.total).toBe(2);expect(work.groups.waiting).toHaveLength(1);expect(work.groups.review).toHaveLength(0);expect(work.groups.running).toHaveLength(1);
    expect(row.taskId).toBe(h.task);expect(row.agents).toHaveLength(2);expect(row.reasons).toContain('本轮产物待验收');
    expect(h.service.workbench(h.other).total).toBe(0);
  });

  it('checks installed terminal commands and ACP handshake without claiming model authentication',async()=>{
    const h=setup();h.remote.executeInEnvironment=vi.fn(async()=> 'installed');
    const check=await h.service.checkConnection(h.user,{taskId:h.task,environmentId:'environment',mode:'acp',command:'fixture --acp'});
    expect(check).toMatchObject({ok:true,protocol:'acp-v1',authentication:'not_checked',capabilities:{resume:true}});
    expect(h.db.agentRecords(h.user)).toHaveLength(0);
    expect(h.calls[0]?.env).toBeUndefined();
    h.remote.executeInEnvironment=vi.fn(async()=> '');
    expect(await h.service.checkConnection(h.user,{taskId:h.task,environmentId:'environment',mode:'tmux',command:'absent-cli'})).toMatchObject({ok:false,installed:false,authentication:'not_checked'});
    expect(h.remote.openAgentTransport).toHaveBeenCalledTimes(1);
  });

  it('replays SSE events by cursor with account checks and releases streams on disconnect',async()=>{
    const h=setup('normal',true),agent=h.service.create(h.user,h.task,h.input());
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const cursor=h.service.events(h.user,agent.id,0).nextCursor;
    const event=h.service.callbackEvent(h.user,agent.id,{requestId:'stream-event',kind:'assistant',text:'新的进度'});
    expect((await h.app.request(`/api/agents/${agent.id}/stream`,{headers:{'X-Test-User':h.other}})).status).toBe(404);
    expect((await h.app.request(`/api/agents/${agent.id}/stream`)).status).toBe(401);
    const controller=new AbortController(),response=await h.app.request(`/api/agents/${agent.id}/stream?after=0`,{headers:{'X-Test-User':h.user,'Last-Event-ID':String(cursor)},signal:controller.signal});
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader=response.body!.getReader(),decoder=new TextDecoder();let text='';
    while(!text.includes('event: agent-state')){const part=await reader.read();text+=decoder.decode(part.value);}
    expect(text).toContain(`id: ${event.id}`);expect(text).toContain('新的进度');expect(text).not.toContain('等待环境准备完成');
    controller.abort();await reader.cancel();
    const unsubscribers=Array.from({length:16},()=>h.service.subscribe(h.user,agent.id,()=>{}));
    expect(()=>h.service.subscribe(h.user,agent.id,()=>{})).toThrow('实时连接过多');unsubscribers.forEach(unsubscribe=>unsubscribe());
  });

  it('preserves multilingual multiline text as one raw bracketed-paste TUI submission and fences pane identity',async()=>{
    const h=setup(),socket=join(h.path,'raw-tmux'),submissions=join(h.path,'submissions.jsonl');mkdirSync(socket,{mode:0o700});
    const env={...process.env,TMUX_TMPDIR:socket};
    const run=(command:string,input?:string)=>new Promise<string>((resolve,reject)=>{
      const child=spawn('sh',['-c',command],{env,stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('close',code=>code===0?resolve(output):reject(new Error(error)));child.stdin.end(input);
    });
    expect(spawnSync('tmux',['new-session','-d','-s','session'],{env,stdio:'ignore'}).status).toBe(0);
    cleanups.push(()=>{spawnSync('tmux',['kill-server'],{env});});
    h.remote.executeInEnvironment=vi.fn(async(_user,_id,command,input)=>run(command,input));h.remote.panes=vi.fn(async()=>parsePanes(await run(PANES_COMMAND)));h.remote.capture=vi.fn(async(_user,_id,pane)=>run(`tmux capture-pane -p -t ${shellQuote(pane)}`));
    const fixture=fileURLToPath(new URL('./fixtures/terminal-tui-agent.mjs',import.meta.url));
    const agent=h.service.create(h.user,h.task,h.input({mode:'tmux',command:`${shellQuote(process.execPath)} ${shellQuote(fixture)} ${shellQuote(submissions)}`,prompt:''}));
    cleanups.push(()=>rmSync(`/tmp/nexus-agent-${agent.id}`,{recursive:true,force:true}));
    await wait(()=>h.service.get(h.user,agent.id).stage==='ready');
    const current=h.service.get(h.user,agent.id);
    await wait(()=>spawnSync('tmux',['capture-pane','-p','-t',current.pane!.id],{env,encoding:'utf8'}).stdout.includes('TUI ready'));
    const text='中文与 English 一起输入\n第二行 $(touch SHOULD_NOT_EXIST) `echo literal`\n最后一行';
    h.service.send(h.user,agent.id,{requestId:'raw-tui',text});
    await wait(()=>existsSync(submissions)&&readFileSync(submissions,'utf8').trim().length>0);
    const rows=readFileSync(submissions,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    expect(rows).toEqual([{text}]);expect(existsSync(join('/tmp','SHOULD_NOT_EXIST'))).toBe(false);
    const realPanes=h.remote.panes;h.remote.panes=vi.fn(async()=> (await realPanes(h.user,'environment')).map(p=>p.id===current.pane!.id?{...p,pid:p.pid+1}:p));
    const rejected=h.service.send(h.user,agent.id,{requestId:'changed-pane',text:'不得投递'});
    await wait(()=>h.db.agentMessages<AgentMessage>(h.user,agent.id).find(m=>m.id===rejected.id)?.state==='failed');
    expect(readFileSync(submissions,'utf8').trim().split('\n')).toHaveLength(1);
  },15000);

});
