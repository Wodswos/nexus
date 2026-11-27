import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DB } from '../src/db';
import { setupWorkspaceLaunch } from '../src/workspaces/launch';
import { WorkspaceError, type WorkspaceService } from '../src/workspaces/service';
import { KubernetesError } from '../src/workspaces/kubernetesConnections';
import { AgentService } from '../src/agents/service';
import { setupSync } from '../src/sync';
import { taskDescriptionService } from '../src/taskDescriptions';
import { EMPTY_WORKSPACE, type CreateWorkspaceAgent, type WorkspaceConfig, type WorkspaceEnvironment, type WorkspaceAgent } from '../../../packages/core/src/index';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-launch-')), db = new DB(dir), app = new Hono();
  const state = { environments: 0, agents: 0, failAgent: false, config: EMPTY_WORKSPACE, metadata: undefined as { name?: string; workspaceId?: string } | undefined, createError: null as Error | null };
  const environment = { id: 'environment', state: 'queued', taskId: 'task' } as WorkspaceEnvironment;
  const agent = { id: 'agent', state: 'queued', environmentId: 'environment' } as WorkspaceAgent;
  const workspaces = {
    create(_u: string, _t: string, _r: unknown, config: WorkspaceConfig, metadata?: { name?: string; workspaceId?: string }) { if (state.createError) throw state.createError; state.environments++; state.config = config; state.metadata = metadata; return environment; },
    environment() { return environment; },
  } as unknown as WorkspaceService;
  const agents = {
    validateProvider() {},
    prompt(userId: string) { if (userId !== 'alice') throw new WorkspaceError('任务不存在', 404); return { prompt: '工作 {{task_context_url}}' }; },
    create(_u: string, _t: string, input: CreateWorkspaceAgent) { if (state.failAgent) throw new WorkspaceError('启动配置失败'); state.agents++; expect(input.environmentId).toBe(environment.id); return agent; },
    get() { return agent; },
  } as unknown as AgentService;
  const read = (u: string) => { if (u !== 'alice') throw new WorkspaceError('Workspace 不存在', 404); };
  let launch = setupWorkspaceLaunch(app, db, workspaces, agents, c => c.req.header('test-user') ?? null, read);
  cleanups.push(() => { launch.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const req = (body: unknown, user = 'alice') => app.request('/api/tasks/task/workspace-launch', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(user ? { 'test-user': user } : {}) }, body: JSON.stringify(body),
  });
  return { state, db, req, restart() { launch.close(); launch = setupWorkspaceLaunch(new Hono(), db, workspaces, agents, () => 'alice', read); } };
}
const body = () => ({ requestId: 'new-workspace', config: { ...EMPTY_WORKSPACE, serverId: 'host', agentCommand: 'agent --acp' }, agent: { name: 'Developer', persistentSession:false,mode: 'acp', command: 'agent --acp' } });
describe('combined durable Workspace creation', () => {
  it('accepts the actual UI product and round fields and persists them with the real Agent service',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'nexus-launch-round-')),db=new DB(dir),server=createServer(),sync=setupSync(server,db,()=>null),app=new Hono();
    const userId=db.createUser('alice','hash','salt',true).id,taskId=sync.withStore(userId,true,store=>store.createTask({title:'新建环境与首轮任务'}).id);
    const environment:WorkspaceEnvironment={id:'environment',taskId,config:{...EMPTY_WORKSPACE,serverId:'host'},connectionHost:'fixture',state:'queued',managed:true,resourceId:'',session:'session',directory:'/repo',createdAt:Date.now(),updatedAt:Date.now()};
    let environments=0;
    const workspaces={create(){environments++;return environment;},environment(){return environment;}} as unknown as WorkspaceService;
    const descriptions=taskDescriptionService(db,()=>sync),agents=new AgentService(db,workspaces,()=>sync,{publicOrigin:'http://nexus.test',readTaskRevision:descriptions.read,updateTaskDescription:descriptions.update});
    const launch=setupWorkspaceLaunch(app,db,workspaces,agents,()=>userId,()=>{});
    cleanups.push(()=>{launch.close();agents.close();sync.close();server.close();db.close();rmSync(dir,{recursive:true,force:true});});
    const request={...body(),agent:{...body().agent,productId:'generic-acp',round:{kind:'design',objective:'比较可行方案',expectedOutcome:'已确认的设计',acceptanceCriteria:['解释取舍']}}};
    const send=(value:unknown)=>app.request(`http://nexus.test/api/tasks/${taskId}/workspace-launch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
    expect((await send({...request,agent:{...request.agent,productId:'codex-terminal'}})).status).toBe(400);
    expect((await send({...request,agent:{...request.agent,round:{...request.agent.round,kind:'invented'}}})).status).toBe(400);
    expect(environments).toBe(0);
    const response=await send(request);expect(response.status).toBe(200);
    const result=await response.json() as {data:{agent:WorkspaceAgent}};
    expect(result.data.agent).toMatchObject({taskId,productId:'generic-acp',currentRound:{...request.agent.round,sequence:1,state:'running'}});
    expect(agents.rounds(userId,result.data.agent.id)).toHaveLength(1);
    expect(agents.rounds(userId,result.data.agent.id)[0]?.baseRevisionId).toBe(descriptions.read(userId,taskId).id);
    expect((await send(request)).status).toBe(200);expect(environments).toBe(1);expect(agents.list(userId,taskId)).toHaveLength(1);
  });
  it('validates before effects, starts only one Agent and refuses changed retry payload', async () => {
    const { req, state } = fixture();
    expect((await req(body(), '')).status).toBe(401);
    expect((await req(body(), 'bob')).status).toBe(404);
    expect((await req({ ...body(), agent: { ...body().agent, command: '' } })).status).toBe(400);
    expect((await req({ ...body(), agent: { ...body().agent, worktree: true, directory: '/custom' } })).status).toBe(400);
    expect((await req({ ...body(), agent: { ...body().agent, worktree: true, worktreeName: '../escape' } })).status).toBe(400);
    expect(state.environments).toBe(0);
    expect((await req(body())).status).toBe(200);
    expect((await req(body())).status).toBe(200);
    expect(state.environments).toBe(1); expect(state.agents).toBe(1);
    expect(state.config.agentCommand).toBe('');
    expect(state.metadata).toBeUndefined();
    expect((await req({ ...body(), agent: { ...body().agent, name: 'Changed' } })).status).toBe(409);
  });
  it('forwards the displayed Workspace name and template for named launches', async () => {
    const { req, state } = fixture();
    const request = { ...body(), name: 'workspace-task-a1b2c3', workspaceId: 'template' };
    expect((await req(request)).status).toBe(200);
    expect(state.metadata).toEqual({ name: request.name, workspaceId: request.workspaceId });
    expect((await req(request)).status).toBe(200);
    expect(state.environments).toBe(1);
  });
  it('preserves direct Kubernetes identity conflict errors before any Agent is started', async () => {
    const { req, state } = fixture();
    state.createError = new KubernetesError('Pod 已被替换', 409);
    const response = await req(body());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Pod 已被替换' });
    expect(state.environments).toBe(0);
    expect(state.agents).toBe(0);
  });
  it('retains a prepared environment on Agent failure and resumes a persisted unfinished launch after restart', async () => {
    const { req, state, db, restart } = fixture();
    state.failAgent = true;
    expect((await req(body())).status).toBe(400);
    expect(state.environments).toBe(1);
    const pending = db.workspaceLaunch<Record<string, unknown>>('alice', body().requestId)!;
    expect(pending.environmentId).toBe('environment'); expect(pending.state).toBe('failed');
    db.saveWorkspaceLaunch('alice', { ...pending, requestId: body().requestId, state: 'pending' });
    state.failAgent = false; restart();
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(state.agents).toBe(1); expect(state.environments).toBe(1);
    expect(db.workspaceLaunch<{state: string}>('alice', body().requestId)?.state).toBe('complete');
  });
});
