import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DB } from '../src/db';
import { shellQuote } from '../src/connections';
import { WorkspaceService } from '../src/workspaces/service';
import { agentLaunchLine, BOOTSTRAP_READER } from '../src/workspaces/transport';
import { EMPTY_WORKSPACE, type WorkspaceEnvironment } from '../../../packages/core/src/executionWorkspace';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
function fixture(agentProxy?: { url: string; noProxy: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-agent-ssh-'));
  const originalPath = process.env.PATH;
  const argsPath = join(dir, 'ssh-argv');
  // Only the transport boundary is mocked. The remote POSIX bootstrap and Agent command run as real child processes.
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(argsPath)}\nfor argument do command=$argument; done\nexec /bin/sh -c "$command"\n`, { mode: 0o700 });
  writeFileSync(join(dir, 'id_ed25519'), 'fixture identity, never used by an SSH server', { mode: 0o600 });
  process.env.PATH = `${dir}:${originalPath}`;
  const secretRef = join(dir, 'model.env'), db = new DB(dir);
  const config = { ...EMPTY_WORKSPACE, serverId: 'host', secretRef, directory: dir };
  const service = new WorkspaceService(db, { resolve: (user, id) => user === 'alice' && id === 'host' ? { userId: user, host: 'fixture@host', password: '', sshDir: dir, agentProxy } : null }, () => ({ config, title: 'Task' }));
  const environment: WorkspaceEnvironment = { id: 'environment', taskId: 'task', config, connectionHost: 'fixture@host', state: 'ready', managed: true, resourceId: '', session: 'dev', directory: dir, createdAt: 1, updatedAt: 1 };
  db.saveWorkspaceRecord('alice', 'environment', environment, 'transport-fixture', 'fixture-config');
  cleanups.push(() => { service.close(); db.close(); if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; rmSync(dir, { recursive: true, force: true }); });
  return { dir, secretRef, service, argsPath };
}

describe('Agent SSH credential inheritance', () => {
  it('injects account proxy defaults into the execution process without passing them as SSH options', async () => {
    const { secretRef, service, argsPath } = fixture({ url: 'http://127.0.0.1:7890', noProxy: 'internal.invalid' });
    writeFileSync(secretRef, 'HTTPS_PROXY=http://old-proxy.invalid\nhttps_proxy=http://old-proxy.invalid\n');
    const transport = await service.openAgentTransport('alice', 'environment', `printf '%s\\n' "$HTTP_PROXY" "$https_proxy" "$ALL_PROXY" "$NO_PROXY"`);
    let output = '';
    transport.stdout.on('data', bytes => { output += bytes.toString(); });
    transport.stdin.end();
    expect((await transport.closed).code).toBe(0);
    const lines = output.trim().split('\n');
    expect(lines.slice(0, 3)).toEqual(Array(3).fill('http://127.0.0.1:7890'));
    expect(lines[3]).toContain('localhost,127.0.0.1,::1,internal.invalid');
    expect(readFileSync(argsPath, 'utf8')).not.toContain('7890');
    await expect(service.openAgentTransport('bob', 'environment', 'true')).rejects.toThrow();
    const env = service.environment('alice', 'environment');
    expect(service.agentProxyEnvironment('alice', { ...env, config: { ...env.config, runtime: 'docker' } })).toEqual({});
    expect(service.agentProxyEnvironment('alice', { ...env, config: { ...env.config, runtime: 'kubernetes' } })).toEqual({});
  });
  it('loads the SSH env file literally before injecting task-scoped values and preserves the following stdin stream', async () => {
    const { dir, secretRef, service, argsPath } = fixture();
    const marker = join(dir, 'must-not-execute');
    const literal = `$(touch ${marker})`;
    writeFileSync(secretRef, [
      '# Workspace provider credentials',
      "ANTHROPIC_API_KEY='fixture-model-key'",
      'GITHUB_TOKEN="fixture-git-key"',
      'NEXUS_AGENT_TOKEN=stale-parent-token',
      'NEXUS_AGENT_TOKEN_FILE=/stale-parent/token',
      'NEXUS_TASK_ID=parent-task',
      `LITERAL=${literal}`,
      '',
    ].join('\r\n'), { mode: 0o600 });
    const command = `printf '%s\\n' "$ANTHROPIC_API_KEY" "$GITHUB_TOKEN" "$NEXUS_AGENT_TOKEN" "$NEXUS_TASK_ID" "\${NEXUS_AGENT_TOKEN_FILE:-unset}" "$LITERAL"; IFS= read -r message; printf '%s\\n' "$message"`;
    const transport = await service.openAgentTransport('alice', 'environment', command, { env: { NEXUS_AGENT_TOKEN: 'session-scoped-token', NEXUS_TASK_ID: 'actual-child-task' } });
    let output = '', error = '';
    transport.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
    transport.stderr.on('data', (bytes: Buffer) => { error += bytes.toString(); });
    transport.stdin.end('继续处理这条消息\n');
    expect((await transport.closed).code).toBe(0);
    expect(error).toBe('');
    expect(output.trim().split('\n')).toEqual(['fixture-model-key', 'fixture-git-key', 'session-scoped-token', 'actual-child-task', 'unset', literal, '继续处理这条消息']);
    expect(existsSync(marker)).toBe(false);
    const argv = readFileSync(argsPath, 'utf8');
    expect(argv).not.toContain('session-scoped-token');
    expect(argv).not.toContain('fixture-model-key');
    expect(argv).not.toContain(secretRef);
  });

  it('fails closed before starting the Agent when the referenced SSH credential file is unreadable or malformed', async () => {
    const { dir, secretRef, service } = fixture();
    const marker = join(dir, 'agent-started');
    const invoke = async () => {
      const transport = await service.openAgentTransport('alice', 'environment', `touch ${shellQuote(marker)}`);
      let error = '';
      transport.stderr.on('data', (bytes: Buffer) => { error += bytes.toString(); });
      transport.stdin.end();
      const result = await transport.closed;
      expect(result.code).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      return error;
    };
    expect(await invoke()).toContain('环境凭据文件不可读');
    writeFileSync(secretRef, 'export SECRET=should-not-source\n', { mode: 0o600 });
    expect(await invoke()).toContain('环境变量名无效');
  });

  it('keeps container-provided credentials when no SSH file loader is requested', async () => {
    const child = spawn('/bin/sh', ['-c', BOOTSTRAP_READER], { env: { PATH: process.env.PATH, PROVIDER_KEY: 'container-secret', NEXUS_TASK_ID: 'container-default' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.end(agentLaunchLine(`printf '%s\\n' "$PROVIDER_KEY" "$NEXUS_TASK_ID"`, { env: { NEXUS_TASK_ID: 'actual-task' } }));
    expect(await closed).toBe(0);
    expect(output).toBe('container-secret\nactual-task\n');
  });

  it('attaches the requested Agent pane in an inactive window and only detaches the viewer on close', async () => {
    const { dir, service } = fixture(), socketDir = join(dir, 'tmux-sockets'); mkdirSync(socketDir, { mode: 0o700 });
    const env = { ...process.env, TMUX_TMPDIR: socketDir };
    const tmux = (...args: string[]) => {
      const result = spawnSync('tmux', args, { env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
    };
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'dev', 'printf WORKSPACE_SHELL; sleep 60');
    cleanups.push(() => { spawnSync('tmux', ['kill-server'], { env }); });
    const paneId = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'dev:', '-n', 'agent', "printf 'AGENT_SESSION_READY\\n'; cat");
    // The fake SSH allocates a real local PTY only for -tt, with a private tmux server.
    writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nexport TMUX_TMPDIR=${shellQuote(socketDir)}\nterminal=no\nfor argument do [ "$argument" != '-tt' ] || terminal=yes; command=$argument; done\nif [ "$terminal" = yes ]; then exec script -qec "$command" /dev/null; fi\nexec /bin/sh -c "$command"\n`, { mode: 0o700 });
    const identity = tmux('display-message', '-p', '-t', paneId, '#{pane_pid} #{pid}');
    const transport = await service.openTerminalTransport('alice', 'environment', paneId, 100, 30);
    let output = ''; transport.stdout.on('data', bytes => { output += bytes.toString(); });
    try {
      await expect.poll(() => output).toContain('AGENT_SESSION_READY');
      expect(output).not.toContain('WORKSPACE_SHELL');
      transport.stdin.write('continue-in-same-session\r');
      await expect.poll(() => output).toContain('continue-in-same-session');
    } finally { transport.close(); await transport.closed; }
    expect(tmux('display-message', '-p', '-t', paneId, '#{pane_pid} #{pid}')).toBe(identity);
    expect(tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n')).toHaveLength(2);
    await expect.poll(() => tmux('list-clients')).toBe('');
  });
});
