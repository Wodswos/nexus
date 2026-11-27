import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DB } from '../src/db';
import { WorkspaceService } from '../src/workspaces/service';
import { bootstrapScript, createRuntimeCommand, environmentCommand, initializeWorkspaceLayout, pauseRuntimeCommand, stopRuntimeCommand } from '../src/workspaces/runtime';
import { EMPTY_WORKSPACE, type WorkspaceConfig, type WorkspaceEnvironment } from '../../../packages/core/src/executionWorkspace';

// Opt in only with a disposable image containing git, tmux, sudo, shadow, procps, coreutils and prlimit.
// Every resource uses nexus-test names; the host never gains an extra Unix user or a production mount.
const image = process.env.NEXUS_TEST_RUNTIME_IMAGE;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const run = (command: string, args: string[], input?: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  child.on('error', reject); child.on('close', code => resolve({ code: code ?? -1, stdout, stderr })); child.stdin.end(input);
});
async function successful(command: string, args: string[], input?: string) {
  const result = await run(command, args, input); expect(result.code, result.stderr).toBe(0); return result.stdout.trim();
}
describe.skipIf(!image)('isolated real Workspace runtimes', () => {
  it('isolates a Linux UID, credentials and remote-only custom base worktree; preserves source and data across pause/resume; rejects marker symlinks; deletes only its own data/user', async () => {
    const name = `nexus-test-linux-${randomUUID()}`;
    await successful('docker', ['run', '-d', '--name', name, '--network', 'none', '--pids-limit', '256', '--entrypoint', 'sh', image!, '-c', 'while :; do sleep 3600; done']);
    cleanup.push(() => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); });
    const command = (value: string, input?: string) => run('docker', ['exec', '-i', name, 'sh', '-c', value], input);
    const checked = (value: string, input?: string) => successful('docker', ['exec', '-i', name, 'sh', '-c', value], input);
    await checked('sh -s', [
      'set -eu', 'mkdir -p /opt/nexus-test-source', 'cd /opt/nexus-test-source',
      'git init -b main', 'git config user.name Fixture', 'git config user.email fixture@example.invalid',
      'printf "baseline\\n" > tracked.txt', 'git add .', 'git commit -m baseline',
      'git remote add origin https://github.com/example/fixture.git', 'git update-ref refs/remotes/origin/main HEAD',
      'git checkout -b temporary-fixture-branch', 'printf "remote custom base\\n" > custom.txt', 'git add .', 'git commit -m custom-base',
      'git update-ref refs/remotes/origin/custom-dev HEAD', 'git checkout main', 'git branch -D temporary-fixture-branch',
      'printf "source dirty\\n" > tracked.txt', 'printf "source note\\n" > local-note',
      'printf "NEXUS_FIXTURE_SECRET=fixture-only\\n" > /root/nexus-test.env', 'chmod 600 /root/nexus-test.env',
      'printf "untouched\\n" > /root/nexus-test-sentinel',
    ].join('\n'));
    const dir = mkdtempSync(join(tmpdir(), 'nexus-test-runtime-')), db = new DB(join(dir, 'db'));
    const config: WorkspaceConfig = { ...EMPTY_WORKSPACE, runtime: 'linux-user', serverId: 'fixture', localRepository: '/opt/nexus-test-source', repository: 'https://github.com/example/fixture.git', source: 'local', ref: 'origin/custom-dev', prTarget: 'custom-dev', secretRef: '/root/nexus-test.env' };
    const service = new WorkspaceService(db, { resolve: () => ({ userId: 'alice', host: 'fixture', password: '', sshDir: dir }) }, () => ({ title: 'Fixture', config }), (_connection, shell, options) => command(shell, options?.input));
    cleanup.push(() => { service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const created = service.create('alice', 'fixture', 'create');
    await expect.poll(() => service.environment('alice', created.id).state, { timeout: 20000 }).toBe('ready');
    let environment = service.environment('alice', created.id);
    expect(environment.executionUid).toBeGreaterThan(0); expect(environment.credentialFile).toBe(`${environment.workRoot}/.credentials`);
    expect(await checked('git -C /opt/nexus-test-source branch --show-current')).toBe('main');
    expect(await checked('cat /opt/nexus-test-source/tracked.txt')).toBe('source dirty');
    expect(await checked('cat /opt/nexus-test-source/local-note')).toBe('source note');
    expect(await checked(environmentCommand(environment, `cat '${environment.directory}/tracked.txt'`))).toBe('baseline');
    expect(await checked(environmentCommand(environment, `cat '${environment.directory}/custom.txt'`))).toBe('remote custom base');
    expect(environment.baseRef).toBe('origin/custom-dev'); expect(environment.prTarget).toBe('custom-dev');
    expect(await service.gitState('alice', created.id)).toMatchObject({ dirty: false, unpushed: false });
    expect((await command(environmentCommand(environment, `git -C '${environment.workRoot}/.source.git' config --get remote.origin.mirror`))).code).toBe(1);
    expect((await command(environmentCommand(environment, `git -C '${environment.workRoot}/.source.git' config --get-all remote.origin.push`))).code).toBe(1);
    expect(await checked(environmentCommand(environment, 'id -u'))).toBe(String(environment.executionUid));
    expect((await command(environmentCommand(environment, 'sudo -n true'))).code).not.toBe(0);
    expect((await command(environmentCommand(environment, 'cat /root/nexus-test.env'))).code).not.toBe(0);
    expect(await checked(environmentCommand(environment, `cat '${environment.credentialFile}'`))).toBe('NEXUS_FIXTURE_SECRET=fixture-only');
    await checked(environmentCommand(environment, `printf "agent draft\\n" > '${environment.directory}/tracked.txt'`));
    await service.pause('alice', created.id); service.resume('alice', created.id);
    await expect.poll(() => service.environment('alice', created.id).state, { timeout: 20000 }).toBe('ready');
    environment = service.environment('alice', created.id);
    expect(await checked(environmentCommand(environment, `cat '${environment.directory}/tracked.txt'`))).toBe('agent draft');
    await expect(service.deleteData('alice', created.id, true)).rejects.toThrow('未提交');
    await service.pause('alice', created.id);
    await checked(`rm '${environment.workRoot}/.nexus-workspace'; ln -s /root/nexus-test-sentinel '${environment.workRoot}/.nexus-workspace'`);
    service.resume('alice', created.id);
    await expect.poll(() => service.environment('alice', created.id).state, { timeout: 20000 }).toBe('failed');
    expect(await checked('cat /root/nexus-test-sentinel')).toBe('untouched');
    await checked(`rm '${environment.workRoot}/.nexus-workspace'; printf '%s' '${created.id}' > '${environment.workRoot}/.nexus-workspace'`);
    service.retry('alice', created.id);
    await expect.poll(() => service.environment('alice', created.id).state, { timeout: 20000 }).toBe('ready');
    const removed = await service.deleteData('alice', created.id, true, true);
    expect(removed.dataDeletedAt).toBeTypeOf('number');
    expect((await command(`id '${environment.executionUser}'`)).code).not.toBe(0);
    await checked(`test ! -e '${environment.workRoot}'; test ! -e '${environment.workRoot!.replace(/\/data$/, '/home')}'`);
    expect(await checked('cat /opt/nexus-test-source/tracked.txt')).toBe('source dirty');
    expect(await checked('id -u root')).toBe('0');
  }, 90000);

  it('retains both repository and Agent files through a Docker stop and full container replacement', async () => {
    const suffix = randomUUID(), name = `nexus-test-docker-${suffix}`, volume = `nexus-test-data-${suffix}`;
    await successful('docker', ['volume', 'create', volume]);
    cleanup.push(() => { spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' }); });
    cleanup.push(() => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); });
    const environment: WorkspaceEnvironment = { id: suffix, taskId: 'fixture', config: { ...EMPTY_WORKSPACE, runtime: 'docker', image: image!, serverId: 'fixture', volumeName: volume, workRoot: '/workspace', cpuLimit: '0.5', memoryLimit: '128Mi' }, connectionHost: 'fixture', managed: true, state: 'queued', resourceId: name, session: `nexus-test-${suffix}`, directory: '', createdAt: 1, updatedAt: 1 };
    initializeWorkspaceLayout(environment);
    await successful('sh', ['-s'], createRuntimeCommand(environment, 'fixture')!);
    await successful('sh', ['-c', environmentCommand(environment, 'sh -s', true)], bootstrapScript(environment));
    environment.directory = `${environment.workRoot}/repo`;
    await successful('sh', ['-c', environmentCommand(environment, `printf repo-data > '${environment.directory}/note'; mkdir -p '${environment.workRoot}/worktrees/agent'; printf agent-data > '${environment.workRoot}/worktrees/agent/note'`)]);
    await successful('sh', ['-c', pauseRuntimeCommand(environment)]);
    await successful('sh', ['-s'], createRuntimeCommand(environment, 'fixture')!);
    expect(await successful('sh', ['-c', environmentCommand(environment, `cat '${environment.directory}/note'`)])).toBe('repo-data');
    await successful('sh', ['-c', stopRuntimeCommand(environment)]);
    await successful('sh', ['-s'], createRuntimeCommand(environment, 'fixture')!);
    expect(await successful('sh', ['-c', environmentCommand(environment, `cat '${environment.workRoot}/worktrees/agent/note'`)] )).toBe('agent-data');
    const inspected = JSON.parse(await successful('docker', ['inspect', name]))[0];
    expect(inspected.HostConfig.NanoCpus).toBe(500000000); expect(inspected.HostConfig.Memory).toBe(128 * 2 ** 20);
  }, 60000);
});
