import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DB } from '../src/db';
import { WorkspaceService } from '../src/workspaces/service';
import { bootstrapScript, initializeWorkspaceLayout, linuxUserProvisionScript, environmentCommand, createRuntimeCommand } from '../src/workspaces/runtime';
import { EMPTY_WORKSPACE, type WorkspaceConfig, type WorkspaceEnvironment } from '../../../packages/core/src/executionWorkspace';
import { gitStatusScript, parseGitState } from '../src/workspaces/git';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const tmux = spawnSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-git-workspace-')), source = join(dir, 'source'), root = join(dir, 'instances');
  mkdirSync(source); mkdirSync(join(dir, 'tmux'));
  const env = { ...process.env, TMUX_TMPDIR: join(dir, 'tmux'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (path: string, ...args: string[]) => {
    const result = spawnSync('git', ['-C', path, ...args], { env, encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr); return result.stdout.trim();
  };
  git(source, 'init', '-b', 'main'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(source, 'tracked.txt'), 'baseline\n'); git(source, 'add', '.'); git(source, 'commit', '-m', 'initial');
  git(source, 'remote', 'add', 'origin', 'https://github.com/example/fixture.git'); git(source, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const config: WorkspaceConfig = { ...EMPTY_WORKSPACE, serverId: 'host', localRepository: source, repository: 'https://github.com/example/fixture.git', source: 'auto', ref: 'main', workRoot: root };
  const run = (command: string, input?: string) => new Promise<{code:number;stdout:string;stderr:string}>((resolve) => {
    const child = spawn('sh', ['-c', command], { env, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value.toString()); child.stderr.on('data', value => stderr += value.toString());
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr })); child.stdin.end(input);
  });
  cleanup.push(() => { spawnSync('tmux', ['kill-server'], { env, stdio: 'ignore' }); rmSync(dir, { recursive: true, force: true }); });
  const environment = (id = 'fixture'): WorkspaceEnvironment => { const value: WorkspaceEnvironment = { id, taskId: 'task', config: { ...config }, connectionHost: 'fixture', state: 'queued', managed: true, resourceId: '', session: `nexus-${id}`, directory: '', createdAt: 1, updatedAt: 1 }; initializeWorkspaceLayout(value); return value; };
  return { dir, source, root, env, config, git, run, environment };
}
describe('Workspace Git layout', () => {
  it.skipIf(!tmux)('creates a separate local worktree branch without changing source branch, tracked edits or untracked files, and resumes without resetting work', async () => {
    const f = fixture(), environment = f.environment();
    const before = f.git(f.source, 'rev-parse', 'HEAD');
    writeFileSync(join(f.source, 'tracked.txt'), 'local dirty edit\n'); writeFileSync(join(f.source, 'untracked.txt'), 'private note');
    let result = await f.run('sh -s', bootstrapScript(environment)); expect(result.code, result.stderr).toBe(0);
    const repo = join(f.root, environment.id, 'repo');
    expect(f.git(f.source, 'branch', '--show-current')).toBe('main'); expect(f.git(f.source, 'rev-parse', 'HEAD')).toBe(before);
    expect(readFileSync(join(f.source, 'tracked.txt'), 'utf8')).toBe('local dirty edit\n'); expect(existsSync(join(f.source, 'untracked.txt'))).toBe(true);
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('baseline\n'); expect(f.git(repo, 'branch', '--show-current')).toBe('nexus-agent/workspace-fixture');
    writeFileSync(join(repo, 'tracked.txt'), 'agent edit\n'); result = await f.run('sh -s', bootstrapScript(environment)); expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('agent edit\n');
  });
  it.skipIf(!tmux)('resumes a stored legacy branch and protects new Agent directories during cleanup', async () => {
    const f = fixture(), environment = f.environment('legacy');
    environment.branch = 'nexus/workspace-legacy';
    const result = await f.run('sh -s', bootstrapScript(environment)); expect(result.code, result.stderr).toBe(0);
    environment.directory = `${environment.workRoot}/repo`;
    expect(f.git(environment.directory, 'branch', '--show-current')).toBe('nexus/workspace-legacy');
    const tree = `${environment.workRoot}/nexus-agent/developer`;
    f.git(environment.directory, 'worktree', 'add', '-b', 'nexus-agent/developer', tree);
    writeFileSync(join(tree, 'note'), 'unfinished');
    const state = await f.run('sh -s', gitStatusScript(environment)); expect(state.code, state.stderr).toBe(0);
    expect(parseGitState(state.stdout)).toMatchObject({ dirty: true });
    expect(parseGitState(state.stdout).trees).toEqual(expect.arrayContaining([expect.objectContaining({ directory: tree, dirtyFiles: 1 })]));
  });
  it.skipIf(!tmux)('rejects a missing or mismatched local repository instead of silently cloning the remote', async () => {
    const f = fixture(); const environment = f.environment('wrong'); environment.config.repository = 'https://github.com/other/repo.git';
    const result = await f.run('sh -s', bootstrapScript(environment)); expect(result.code).not.toBe(0); expect(result.stderr).toContain('不一致');
    expect(existsSync(join(f.root, 'wrong', 'repo'))).toBe(false);
    const missing = f.environment('missing'); missing.config.localRepository = join(f.dir, 'absent');
    const absent = await f.run('sh -s', bootstrapScript(missing)); expect(absent.code).not.toBe(0); expect(absent.stderr).toContain('不会改用远程');
  });
  it.skipIf(!tmux)('clones an explicit remote source at the requested base and creates a new branch inside the persistent root', async () => {
    const f = fixture(), environment = f.environment('remote'); environment.config.source = 'remote'; environment.config.localRepository = '/does/not/exist';
    f.env.GIT_CONFIG_GLOBAL = join(f.dir, 'gitconfig');
    writeFileSync(f.env.GIT_CONFIG_GLOBAL, `[url "file://${f.source}"]\n  insteadOf = https://github.com/example/fixture.git\n`);
    const result = await f.run('sh -s', bootstrapScript(environment)); expect(result.code, result.stderr).toBe(0);
    const repo = join(f.root, 'remote', 'repo'); expect(f.git(repo, 'branch', '--show-current')).toBe('nexus-agent/workspace-remote'); expect(f.git(repo, 'rev-parse', 'HEAD')).toBe(f.git(f.source, 'rev-parse', 'main'));
    expect(existsSync(join(f.root, 'remote', 'nexus-agent'))).toBe(true);
  });
  it.skipIf(!tmux)('blocks dirty and unpushed data deletion and leaves the source checkout intact when explicit force cleans owned data', async () => {
    const f = fixture(), db = new DB(join(f.dir, 'db'));
    const service = new WorkspaceService(db, { resolve: () => ({ userId: 'alice', host: 'fixture', password: '', sshDir: f.dir }) }, () => ({ config: f.config, title: 'Task' }), (_connection, command, options) => f.run(command, options?.input));
    cleanup.push(() => { service.close(); db.close(); });
    const environment = service.create('alice', 'task', 'create');
    await expect.poll(() => service.environment('alice', environment.id).state).toBe('ready');
    const ready = service.environment('alice', environment.id), repo = ready.directory;
    expect(await service.gitState('alice', ready.id)).toMatchObject({ repository: true, dirty: false, unpushed: false });
    writeFileSync(join(repo, 'tracked.txt'), 'agent edit\n');
    await expect(service.deleteData('alice', ready.id, true)).rejects.toThrow('未提交'); expect(existsSync(repo)).toBe(true);
    await service.pause('alice', ready.id);
    expect(existsSync(repo)).toBe(true);
    service.resume('alice', ready.id);
    await expect.poll(() => service.environment('alice', ready.id).state).toBe('ready');
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('agent edit\n');
    f.git(repo, 'add', '.'); f.git(repo, 'commit', '-m', 'agent change');
    expect(await service.gitState('alice', ready.id)).toMatchObject({ dirty: false, unpushed: true });
    await expect(service.deleteData('alice', ready.id, true)).rejects.toThrow('未推送');
    const removed = await service.deleteData('alice', ready.id, true, true); expect(removed.dataDeletedAt).toBeTypeOf('number'); expect(existsSync(ready.workRoot!)).toBe(false);
    expect(readFileSync(join(f.source, 'tracked.txt'), 'utf8')).toBe('baseline\n'); expect(f.git(f.source, 'branch', '--show-current')).toBe('main');
  });
  it('generates Linux user scripts with immutable UID ownership checks and no source checkout or sudo privileges in Agent command', () => {
    const f = fixture(), environment = f.environment('12345678-1234-1234-1234-123456789abc'); environment.config.runtime = 'linux-user'; environment.config.workRoot = '/var/lib/nexus/workspaces'; initializeWorkspaceLayout(environment);
    const provision = linuxUserProvisionScript(environment); expect(provision).toContain('useradd --system --user-group'); expect(provision).toContain('clone --bare --no-local'); expect(provision).not.toContain('userdel -r'); expect(provision).not.toContain('usermod');
    expect(spawnSync('sh', ['-n'], { input: provision }).status).toBe(0);
    expect(() => environmentCommand(environment, 'agent')).toThrow('UID'); environment.executionUid = 1234;
    expect(environmentCommand(environment, 'agent')).toContain("'1234'"); expect(environmentCommand(environment, 'agent')).toContain("'-u' 'nx_123456781234123412341234'");
  });
  it.skipIf(!tmux)('protects ordinary data outside Git and unregistered Agent directories', async () => {
    const f = fixture(), environment = f.environment();
    const bootstrap = await f.run('sh -s', bootstrapScript(environment)); expect(bootstrap.code, bootstrap.stderr).toBe(0);
    environment.directory = `${environment.workRoot}/repo`;
    writeFileSync(join(environment.workRoot!, 'research.md'), 'valuable notes');
    let result = await f.run('sh -s', gitStatusScript(environment)); expect(result.code, result.stderr).toBe(0);
    expect(parseGitState(result.stdout)).toMatchObject({ dirty: true, untrackedData: true });
    rmSync(join(environment.workRoot!, 'research.md'));
    mkdirSync(join(environment.workRoot!, 'worktrees', 'orphan'), { recursive: true }); writeFileSync(join(environment.workRoot!, 'worktrees', 'orphan', 'note'), 'unsaved');
    result = await f.run('sh -s', gitStatusScript(environment)); expect(result.code, result.stderr).toBe(0);
    expect(parseGitState(result.stdout)).toMatchObject({ dirty: true, untrackedData: true });
  });
  it.skipIf(!tmux)('retries final cleanup after directory deletion without recreating data or requiring its removed marker', async () => {
    const f = fixture(), db = new DB(join(f.dir, 'db')); let failedOnce = false;
    const service = new WorkspaceService(db, { resolve: () => ({ userId: 'alice', host: 'fixture', password: '', sshDir: f.dir }) }, () => ({ config: f.config, title: 'Task' }), (_connection, command, options) => {
      if (command.includes('kill-session') && !failedOnce) { failedOnce = true; return Promise.resolve({ code: 1, stdout: '', stderr: 'Temporary cleanup failure' }); }
      return f.run(command, options?.input);
    });
    cleanup.push(() => { service.close(); db.close(); });
    const environment = service.create('alice', 'task', 'create');
    await expect.poll(() => service.environment('alice', environment.id).state).toBe('ready');
    await expect(service.deleteData('alice', environment.id, true)).rejects.toThrow('Temporary');
    const partial = service.environment('alice', environment.id); expect(partial.dataClearedAt).toBeTypeOf('number'); expect(partial.state).toBe('unknown'); expect(existsSync(partial.workRoot!)).toBe(false);
    expect(() => service.retry('alice', partial.id)).toThrow('不能重新准备');
    expect((await service.deleteData('alice', environment.id, true)).dataDeletedAt).toBeTypeOf('number');
    expect(existsSync(partial.workRoot!)).toBe(false);
  });
  it('mounts the complete durable root into Docker so both repo and worktrees survive compute replacement', () => {
    const f = fixture(), environment = f.environment(); environment.config.runtime = 'docker'; environment.config.image = 'node:24'; environment.resourceId = 'nexus-fixture'; environment.config.workRoot = '/workspace'; initializeWorkspaceLayout(environment);
    const command = createRuntimeCommand(environment, 'alice')!;
    expect(command).toContain('type=volume,source=nexus-data-fixture,target=/workspace'); expect(environment.workRoot).toBe('/workspace/fixture');
    expect(command).not.toContain('--rm');
  });
});
