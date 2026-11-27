import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { DB } from '../src/db';
import { shellQuote, type SshConnection } from '../src/connections';
import { WorkspaceService } from '../src/workspaces/service';
import {
  bootstrapScript,
  createRuntimeCommand,
  deliveryCommand,
  environmentCommand,
  PANES_COMMAND,
  parsePanes,
  resourceIdentity,
  stopRuntimeCommand,
} from '../src/workspaces/runtime';
import {
  EMPTY_WORKSPACE,
  type WorkspaceConfig,
  type WorkspaceEnvironment,
  type WorkspaceInstruction,
} from '../../../packages/core/src/index';

const cleanup: (() => void)[] = [];
const kubectlExecutable = spawnSync('sh', ['-c', 'command -v kubectl'], {
  encoding: 'utf8',
}).stdout.trim();
const tmuxExecutable = spawnSync('sh', ['-c', 'command -v tmux'], {
  encoding: 'utf8',
}).stdout.trim();
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
const success = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const paneLine = (session = 'dev', command = 'codex', pid = 42) =>
  `%1\t$0\t@0\t${pid}\t100\t0\t${session}\tmain\t${command}\t/workspace\n`;
const configFor = (
  runtime: WorkspaceConfig['runtime'] = 'ssh',
): WorkspaceConfig => ({
  ...EMPTY_WORKSPACE,
  runtime,
  serverId: 'host',
  image: runtime === 'ssh' ? '' : 'node:22',
});
const environmentFor = (
  runtime: WorkspaceConfig['runtime'],
): WorkspaceEnvironment => ({
  id: 'test-env',
  taskId: 'task',
  config: configFor(runtime),
  connectionHost: 'fixture@host',
  state: 'ready',
  managed: true,
  resourceId: runtime === 'ssh' ? '' : 'resource',
  resourceUid: runtime === 'kubernetes' ? 'pod-uid' : undefined,
  session: 'dev',
  directory: '/workspace',
  createdAt: 1,
  updatedAt: 1,
});

function fixture(runtime: WorkspaceConfig['runtime'] = 'ssh') {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-workspace-'));
  const db = new DB(dir),
    calls: { command: string; input?: string }[] = [];
  const state = {
    session: 'dev',
    command: 'codex',
    pid: 42,
    failDelivery: false,
    failBootstrap: false,
    owner: 'a',
    host: 'fixture@host',
    deleted: false,
    deliveryDelayMs: 0,
  };
  const config = configFor(runtime);
  const connection: SshConnection = {
    userId: 'a',
    host: state.host,
    password: '',
    sshDir: dir,
  };
  const service = new WorkspaceService(
    db,
    {
      resolve: (user, id) =>
        user === 'a' && id === 'host'
          ? { ...connection, host: state.host }
          : null,
    },
    (_user, taskId) => {
      if (state.deleted || taskId !== 'task') throw new Error('节点不存在');
      return { config, title: 'task' };
    },
    async (_connection, command, options) => {
      calls.push({ command, input: options?.input });
      if(command.includes("NEXUS_MACHINE="))return success("NEXUS_UID=1000\nNEXUS_MACHINE=fixture-machine\n");
      if (options?.input?.includes('# nexus:bootstrap')) {
        if (state.failBootstrap)
          return {
            code: 1,
            stdout: 'install progress\n',
            stderr: 'fixture preparation failure',
          };
        state.session =
          /tmux new-session -d -s '([^']+)'/.exec(options.input)?.[1] ?? 'dev';
        return success('NEXUS_DIRECTORY=/workspace\n');
      }
      if (command.includes('# nexus:deliver')) {
        if (state.deliveryDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, state.deliveryDelayMs),
          );
        return state.failDelivery
          ? { code: -1, stdout: '', stderr: 'connection lost' }
          : success();
      }
      if (command.includes('list-panes'))
        return success(paneLine(state.session, state.command, state.pid));
      if (command.includes("'docker' 'inspect'"))
        return success(
          JSON.stringify([
            {
              Id: 'container123',
              Config: { Labels: { 'nexus.owner': state.owner } },
              State: { Running: true },
            },
          ]),
        );
      if (command.includes("'get' 'pod'"))
        return success(
          JSON.stringify({
            metadata: {
              name: 'pod-one',
              uid: 'pod-uid',
              labels: { 'nexus.owner': state.owner },
            },
            status: { phase: 'Running' },
          }),
        );
      return success();
    },
  );
  cleanup.push(() => {
    service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, db, state, config, calls };
}

async function settled<T extends { state: string }>(read: () => T): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (!['queued', 'preparing', 'sending'].includes(value.state)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Workspace job did not settle');
}

describe('workspace environment and delivery service', () => {
  it('prepares an on-demand SSH Workspace without tmux and keeps it ready without a terminal',async()=>{
    const {service,config,calls}=fixture();
    const environment=service.create('a','task','native-workspace',{...config,terminalPolicy:'on-demand'});
    expect((await settled(()=>service.environment('a',environment.id))).state).toBe('ready');
    const bootstrap=calls.find(call=>call.input?.includes('# nexus:bootstrap'))!.input!;
    expect(bootstrap).not.toContain('tmux');
    expect((await service.check('a',environment.id)).state).toBe('ready');
  });
  it('claims the real SSH machine and UID and rejects another account at that execution boundary',async()=>{
    const {service}=fixture();const environment=environmentFor('ssh');
    await service.ensureExecutionIdentity('a',environment);
    // The connection adapter refuses another account before any command; ownership cannot be guessed by environment ID.
    await expect(service.ensureExecutionIdentity('b',environment)).rejects.toThrow();
  });
  it('persists the Workspace name shown before creation and template identity with idempotent retries', () => {
    const { service, config } = fixture();
    const metadata = { name: 'workspace-task-unique', workspaceId: 'task-template' };
    const value = service.create('a', 'task', 'named-create', config, metadata);
    expect(service.environment('a', value.id)).toMatchObject(metadata);
    expect(service.create('a', 'task', 'named-create', config, metadata).id).toBe(value.id);
    expect(() => service.create('a', 'task', 'named-create', config, { ...metadata, name: 'changed' })).toThrow(/请求 ID/);
  });
  it('rejects capture from a replaced Agent pane and checks both process identities before capturing', async () => {
    const { service, state, calls } = fixture();
    const environment = await service.attach('a', 'task', 'dev', 'adopt-for-capture');
    await service.capture('a', environment.id, '%1', { pid: 42, serverPid: 100 });
    expect(calls.at(-1)?.command).toContain("'#{pane_pid} #{pid}'");
    expect(calls.at(-1)?.command).toContain("'42 100'");
    const count = calls.filter((call) => call.command.includes('capture-pane')).length;
    state.pid = 99;
    await expect(service.capture('a', environment.id, '%1', { pid: 42, serverPid: 100 })).rejects.toThrow('已变化');
    expect(calls.filter((call) => call.command.includes('capture-pane'))).toHaveLength(count);
  });
  for (const runtime of ['ssh', 'docker', 'kubernetes'] as const) {
    it(`prepares ${runtime} once with a configuration snapshot and ends only managed resources`, async () => {
      const { service, config, calls } = fixture(runtime);
      const created = service.create('a', 'task', 'create-once');
      expect(service.create('a', 'task', 'create-once').id).toBe(created.id);
      expect(() =>
        service.create('a', 'task', 'create-once', {
          ...config,
          directory: '/changed',
        }),
      ).toThrow(/配置已变化/);
      const ready = await settled(() => service.environment('a', created.id));
      expect(ready).toMatchObject({
        state: 'ready',
        managed: true,
        directory: '/workspace',
      });
      config.directory = '/changed';
      expect(ready.config.directory).toBe('');
      expect(
        calls.filter((call) => call.input?.includes('# nexus:bootstrap')),
      ).toHaveLength(1);
      expect(() => service.environment('b', created.id)).toThrow(/不存在/);
      const stopped = await service.stop('a', created.id);
      expect(stopped.state).toBe('stopped');
      expect(
        calls.some((call) =>
          /kill-session|'rm' '-f'|'delete' '--raw'/.test(call.command),
        ),
      ).toBe(true);
    });
  }

  it('adopts a specific existing session and delivers literal text once to its existing Agent pane', async () => {
    const { service, db, calls } = fixture();
    const environment = await service.attach('a', 'task', 'dev', 'attach');
    const pane = (await service.panes('a', environment.id))[0]!;
    const text = '中文\n$(touch /never-run) `pwd` "quoted"';
    const body = {
      requestId: 'instruction',
      environmentId: environment.id,
      pane,
      text,
      submit: true,
    };
    const instruction = service.send('a', 'task', body);
    expect(service.send('a', 'task', body).id).toBe(instruction.id);
    expect(() =>
      service.send('a', 'task', { ...body, text: 'different' }),
    ).toThrow(/其他内容/);
    expect(
      await settled(
        () =>
          db.workspaceRecord<WorkspaceInstruction>(
            'a',
            'instruction',
            instruction.id,
          )!,
      ),
    ).toMatchObject({ state: 'delivered', text });
    const deliveries = calls.filter((call) =>
      call.command.includes('# nexus:deliver'),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.input).toBe(text);
    expect(deliveries[0]!.command).not.toContain(text);
    const previous = calls.length;
    await service.stop('a', environment.id);
    expect(calls.length).toBe(previous);
  });

  it('rejects changed panes, plain shells and changed SSH destinations before transmission', async () => {
    const { service, db, state, calls } = fixture();
    const environment = await service.attach('a', 'task', 'dev', 'attach');
    const pane = (await service.panes('a', environment.id))[0]!;
    const body = {
      environmentId: environment.id,
      pane,
      text: 'work',
      submit: false,
    };
    state.pid++;
    let sent = service.send('a', 'task', { ...body, requestId: 'stale' });
    expect(
      await settled(
        () =>
          db.workspaceRecord<WorkspaceInstruction>(
            'a',
            'instruction',
            sent.id,
          )!,
      ),
    ).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/已变化/),
    });
    state.pid = pane.pid;
    state.command = 'bash';
    sent = service.send('a', 'task', { ...body, requestId: 'shell' });
    expect(
      await settled(
        () =>
          db.workspaceRecord<WorkspaceInstruction>(
            'a',
            'instruction',
            sent.id,
          )!,
      ),
    ).toMatchObject({ state: 'failed', error: expect.stringMatching(/Shell/) });
    expect(calls.some((call) => call.command.includes('# nexus:deliver'))).toBe(
      false,
    );
    state.host = 'changed@host';
    await expect(service.panes('a', environment.id)).rejects.toThrow(
      /目标已变化/,
    );
    expect(() => service.create('b', 'task', 'other')).toThrow(/不存在/);
  });

  it('keeps delivery uncertainty for manual inspection and records preparation failure logs', async () => {
    const { service, db, state } = fixture();
    const environment = await service.attach('a', 'task', 'dev', 'attach');
    const pane = (await service.panes('a', environment.id))[0]!;
    state.failDelivery = true;
    const instruction = service.send('a', 'task', {
      requestId: 'uncertain',
      environmentId: environment.id,
      pane,
      text: 'work',
    });
    expect(
      await settled(
        () =>
          db.workspaceRecord<WorkspaceInstruction>(
            'a',
            'instruction',
            instruction.id,
          )!,
      ),
    ).toMatchObject({ state: 'unknown' });
    state.failBootstrap = true;
    const created = service.create('a', 'task', 'fail');
    expect(
      await settled(() => service.environment('a', created.id)),
    ).toMatchObject({ state: 'failed', log: 'install progress\n' });
    state.failBootstrap = false;
    service.retry('a', created.id);
    expect(
      await settled(() => service.environment('a', created.id)),
    ).toMatchObject({ state: 'ready' });
  });

  it('checks resource ownership and recovers interrupted jobs without replaying instructions', async () => {
    const { service, db, state } = fixture('docker');
    state.owner = 'b';
    await expect(
      service.attach('a', 'task', 'existing', 'bad'),
    ).rejects.toThrow(/归属/);
    const value = { ...environmentFor('ssh'), state: 'preparing' as const };
    db.saveWorkspaceRecord(
      'a',
      'environment',
      value,
      'interrupted',
      'fingerprint',
    );
    const instruction = {
      id: 'interrupted-instruction',
      state: 'sending',
      updatedAt: 1,
    };
    db.saveWorkspaceRecord(
      'a',
      'instruction',
      instruction,
      'interrupted',
      'fingerprint',
    );
    db.recoverWorkspaceRecords();
    expect(
      db.workspaceRecord<WorkspaceEnvironment>('a', 'environment', value.id)
        ?.state,
    ).toBe('unknown');
    expect(
      db.workspaceRecord<WorkspaceInstruction>(
        'a',
        'instruction',
        instruction.id,
      )?.state,
    ).toBe('unknown');
    expect(db.queuedWorkspaces()).toEqual([]);
  });

  it('serializes the same physical pane across separate adopted environment records', async () => {
    const { service, db, state, calls } = fixture();
    const first = await service.attach('a', 'task', 'dev', 'first');
    const second = await service.attach('a', 'task', 'dev', 'second');
    const pane = (await service.panes('a', first.id))[0]!;
    state.deliveryDelayMs = 100;
    const one = service.send('a', 'task', {
      requestId: 'one',
      environmentId: first.id,
      pane,
      text: 'first',
    });
    const two = service.send('a', 'task', {
      requestId: 'two',
      environmentId: second.id,
      pane,
      text: 'second',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      calls.filter((call) => call.command.includes('# nexus:deliver')),
    ).toHaveLength(1);
    await expect(service.stop('a', second.id)).rejects.toThrow(/仍在执行/);
    expect(
      await settled(
        () =>
          db.workspaceRecord<WorkspaceInstruction>('a', 'instruction', one.id)!,
      ),
    ).toMatchObject({ state: 'delivered' });
    expect(
      await settled(
        () =>
          db.workspaceRecord<WorkspaceInstruction>('a', 'instruction', two.id)!,
      ),
    ).toMatchObject({ state: 'delivered' });
    expect(
      calls
        .filter((call) => call.command.includes('# nexus:deliver'))
        .map((call) => call.input),
    ).toEqual(['first', 'second']);
  });
  it('preserves legacy Docker writable layers on pause and refuses destructive Pod pause without PVC', async () => {
    for (const runtime of ['docker','kubernetes'] as const) {
      const { service, db, calls } = fixture(runtime);
      const environment = environmentFor(runtime);
      db.saveWorkspaceRecord('a', 'environment', environment, 'legacy', 'legacy');
      if (runtime === 'docker') {
        expect(await service.pause('a', environment.id)).toMatchObject({ state: 'paused' });
        expect(calls.some(call => call.command.includes("'docker' 'stop'"))).toBe(true);
        expect(calls.some(call => call.command.includes("'docker' 'rm'"))).toBe(false);
      } else await expect(service.pause('a', environment.id)).rejects.toThrow('没有持久 PVC');
      await expect(service.stop('a', environment.id)).rejects.toThrow('尚未持久化');
      expect(calls.some(call => call.command.includes("'delete' '--raw'") || call.command.includes("'docker' 'rm'"))).toBe(false);
    }
  });
  it('cleans up partially created Pods and retried resources while they are queued', async () => {
    const { service, db, calls } = fixture('kubernetes');
    const environment = {
      ...environmentFor('kubernetes'),
      state: 'queued' as const,
      startedAt: 1,
      resourceUid: undefined,
      storage: { kind: 'pvc' as const, name: 'retained-data', managed: true, mountRoot: '/workspace' },
    };
    db.saveWorkspaceRecord(
      'a',
      'environment',
      environment,
      'partial-pod',
      'fingerprint',
    );
    expect(await service.stop('a', environment.id)).toMatchObject({
      state: 'stopped',
      resourceUid: 'pod-uid',
    });
    expect(
      calls.some((call) => call.command.includes("'delete' '--raw'")),
    ).toBe(true);
  });
});

describe('runtime command safety', () => {
  it.skipIf(!kubectlExecutable)(
    'uses a UID precondition through the real kubectl client against a local mock API',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nexus-kubectl-runtime-'));
      const received: { method?: string; url?: string; body: string }[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (bytes) => {
          body += bytes;
        });
        request.on('end', () => {
          received.push({ method: request.method, url: request.url, body });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              apiVersion: 'v1',
              kind: 'Status',
              status: 'Success',
            }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      cleanup.push(() => {
        server.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const port = (server.address() as { port: number }).port;
      writeFileSync(
        join(dir, 'kubectl'),
        `#!/bin/sh\nexec ${shellQuote(kubectlExecutable)} --server=http://127.0.0.1:${port} --kubeconfig=/dev/null "$@"\n`,
        { mode: 0o700 },
      );
      const script = stopRuntimeCommand(environmentFor('kubernetes'));
      const result = await new Promise<{ code: number | null; stderr: string }>(
        (resolve, reject) => {
          const child = spawn('sh', ['-c', script], {
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('Local mock Kubernetes request timed out'));
          }, 5000);
          child.stderr.on('data', (bytes) => {
            stderr += bytes;
          });
          child.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          child.on('close', (code) => {
            clearTimeout(timeout);
            resolve({ code, stderr });
          });
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        method: 'DELETE',
        url: '/api/v1/namespaces/default/pods/resource',
      });
      expect(JSON.parse(received[0]!.body)).toMatchObject({
        kind: 'DeleteOptions',
        preconditions: { uid: 'pod-uid' },
      });
    },
  );
  it('stops provisioning immediately when an existing resource belongs to another account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-runtime-owner-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const unexpected = join(dir, 'unexpected');
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh\ncase "$1" in inspect) if [ "\${2:-}" = --format ]; then echo other-owner; fi ;; *) touch ${shellQuote(unexpected)} ;; esac\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(dir, 'kubectl'),
      `#!/bin/sh\ncase "$*" in *'get pod'*) case "$*" in *jsonpath*) echo other-owner ;; esac ;; *) touch ${shellQuote(unexpected)} ;; esac\n`,
      { mode: 0o700 },
    );
    for (const runtime of ['docker', 'kubernetes'] as const) {
      const result = spawnSync('sh', ['-s'], {
        input: createRuntimeCommand(environmentFor(runtime), 'current-owner')!,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(unexpected)).toBe(false);
    }
  });
  it('generates valid POSIX scripts for every backend and protects resource identity', () => {
    for (const runtime of ['ssh', 'docker', 'kubernetes'] as const) {
      const environment = environmentFor(runtime);
      environment.config.agentCommand = 'echo "中文"; exec sh';
      environment.config.repository = 'https://github.com/org/repo.git';
      environment.config.ref = "branch'quoted";
      for (const script of [
        bootstrapScript(environment),
        createRuntimeCommand(environment, 'user-id'),
        environmentCommand(environment, 'sh -s', true),
        deliveryCommand('%1', 'prompt', true, { pid: 42, serverPid: 100 }),
        stopRuntimeCommand(environment),
      ]) {
        if (script === null) continue;
        const result = spawnSync('sh', ['-n'], {
          input: script,
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
      }
    }
    expect(() =>
      environmentCommand(
        { ...environmentFor('docker'), resourceId: 'name;touch /bad' },
        'true',
      ),
    ).toThrow();
    expect(() => deliveryCommand('%1; touch /bad', 'id', true)).toThrow();
    expect(() =>
      resourceIdentity(
        configFor('kubernetes'),
        JSON.stringify({
          metadata: { name: 'pod' },
          status: { phase: 'Running' },
        }),
        'a',
      ),
    ).toThrow();
  });

  it.skipIf(!tmuxExecutable)(
    'executes bootstrap and literal delivery through an isolated real tmux socket',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nexus-tmux-runtime-'));
      const socket = join(dir, 'socket'),
        output = join(dir, 'output'),
        envFile = join(dir, 'env');
      writeFileSync(
        join(dir, 'tmux'),
        `#!/bin/sh\nexec ${shellQuote(tmuxExecutable)} -S ${shellQuote(socket)} "$@"\n`,
        { mode: 0o700 },
      );
      const env = {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        TMUX: '',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${dir}/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/org/',
      };
      cleanup.push(() => {
        spawnSync(tmuxExecutable, ['-S', socket, 'kill-server']);
        rmSync(dir, { recursive: true, force: true });
      });
      const environment = environmentFor('ssh');
      const source = join(dir, 'source'),
        repository = join(dir, 'repo.git');
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git(['init', '-b', 'main', source]);
      writeFileSync(join(source, 'data'), 'main');
      git(['-C', source, 'add', 'data']);
      git([
        '-C',
        source,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'main',
      ]);
      git(['-C', source, 'checkout', '-b', 'feature']);
      writeFileSync(join(source, 'data'), 'feature');
      git([
        '-C',
        source,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-am',
        'feature',
      ]);
      const featureCommit = git(['-C', source, 'rev-parse', 'HEAD']);
      git(['-C', source, 'checkout', 'main']);
      git(['clone', '--bare', source, repository]);
      environment.config.repository = 'https://github.com/org/repo.git';
      environment.config.ref = 'feature';
      environment.config.directory = join(dir, 'work');
      environment.config.secretRef = envFile;
      environment.config.agentCommand = `stty raw -echo; exec cat > ${shellQuote(output)}`;
      writeFileSync(
        envFile,
        `# sample\r\nSAMPLE="literal $(touch ${dir}/should-not-exist)"\r\n`,
      );
      const bootstrap = spawnSync('sh', ['-s'], {
        input: bootstrapScript(environment),
        env,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(bootstrap.status, bootstrap.stderr).toBe(0);
      expect(
        git(['-C', environment.config.directory, 'rev-parse', 'HEAD']),
      ).toBe(featureCommit);
      writeFileSync(
        join(environment.config.directory, 'data'),
        'uncommitted data',
      );
      environment.config.ref = 'main';
      const dirty = spawnSync('sh', ['-s'], {
        input: bootstrapScript(environment),
        env,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(dirty.status).not.toBe(0);
      expect(dirty.stderr).toContain('未提交改动');
      expect(
        readFileSync(join(environment.config.directory, 'data'), 'utf8'),
      ).toBe('uncommitted data');
      expect(existsSync(join(dir, 'should-not-exist'))).toBe(false);
      let panes = parsePanes(
        spawnSync('sh', ['-c', PANES_COMMAND], { env, encoding: 'utf8' })
          .stdout,
      );
      for (
        let attempt = 0;
        attempt < 40 && panes[0]?.command !== 'cat';
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        panes = parsePanes(
          spawnSync('sh', ['-c', PANES_COMMAND], { env, encoding: 'utf8' })
            .stdout,
        );
      }
      expect(panes[0]?.command).toBe('cat');
      const text = `中文 $(touch ${dir}/should-not-exist) \`pwd\`\nsecond line`;
      const deliver = spawnSync(
        'sh',
        ['-c', deliveryCommand(panes[0]!.id, 'literal', false, panes[0]!)],
        { input: text, env, encoding: 'utf8' },
      );
      expect(deliver.status, deliver.stderr).toBe(0);
      await expect
        .poll(() => readFileSync(output, 'utf8'))
        .toBe(text);
      const stale = spawnSync(
        'sh',
        [
          '-c',
          deliveryCommand(panes[0]!.id, 'stale', true, {
            pid: 99999,
            serverPid: 99999,
          }),
        ],
        { input: 'do not paste', env, encoding: 'utf8' },
      );
      expect(stale.status).not.toBe(0);
      expect(readFileSync(output, 'utf8')).not.toContain('do not paste');
    },
  );
});
