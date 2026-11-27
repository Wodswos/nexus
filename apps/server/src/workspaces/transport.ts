import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { sshArgs, shellQuote, sshCredentialError, type SshConnection } from '../connections';
import { agentLoginCommand } from './agentShell';
import { loadEnvironmentScript } from './runtime';

export interface AgentTransport {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  closed: Promise<{ code: number | null; signal?: string }>;
  close(): void;
}
export interface AgentTransportOptions {
  directory?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** The first line travels on stdin, so scoped credentials never enter process argv or exec URLs. */
export const BOOTSTRAP_READER = 'IFS= read -r nexus_launch || exit 1; eval "$(printf \'%s\' "$nexus_launch" | base64 -d)"';
export function agentLaunchLine(command: string, options: AgentTransportOptions = {}, environmentFile?: string): string {
  return Buffer.from(agentLaunchScript(command, options, environmentFile)).toString('base64') + '\n';
}
export function agentLaunchScript(command: string, options: AgentTransportOptions = {}, environmentFile?: string): string {
  if (!command.trim() || command.length > 8192 || command.includes('\0')) throw new Error('Agent 启动命令无效');
  if (options.directory && (!options.directory.startsWith('/') || /[\0\r\n]/.test(options.directory))) throw new Error('Agent 工作目录需要使用绝对路径');
  // Workspace credentials are loaded first; per-session scoped values always take precedence.
  const lines = ['set -e', ...(environmentFile ? [loadEnvironmentScript(environmentFile)] : [])];
  if (options.env?.NEXUS_AGENT_TOKEN !== undefined) lines.push('unset NEXUS_AGENT_TOKEN_FILE');
  else if (options.env?.NEXUS_AGENT_TOKEN_FILE !== undefined) lines.push('unset NEXUS_AGENT_TOKEN');
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes('\0') || value.length > 32768) throw new Error('Agent 环境变量无效');
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  if (options.directory) lines.push(`cd -- ${shellQuote(options.directory)}`);
  lines.push(`exec ${agentLoginCommand(command)}`);
  return lines.join('\n');
}

export function openSshTransport(connection: SshConnection, command: string, signal?: AbortSignal, tty = false): AgentTransport {
  const error = sshCredentialError(connection);
  if (error) throw new Error(error);
  if (signal?.aborted) throw new Error('Agent 连接已取消');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
  let secretPath = '';
  if (connection.password) {
    secretPath = join(tmpdir(), `nexus-agent-askpass-${randomBytes(16).toString('hex')}`);
    writeFileSync(secretPath, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(connection.password)}\n`, { mode: 0o700, flag: 'wx' });
    Object.assign(env, { SSH_ASKPASS: secretPath, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':none' });
  }
  const args = sshArgs(connection);
  if (!connection.password) args.unshift('-o', 'BatchMode=yes');
  const child = spawn('ssh', [tty ? '-tt' : '-T', ...args, command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref();
  };
  const closed = new Promise<{ code: number | null; signal?: string }>((resolve) => {
    let done = false;
    const finish = (code: number | null, endedSignal?: string) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', close);
      if (secretPath) { try { unlinkSync(secretPath); } catch { /* already removed */ } }
      resolve({ code, signal: endedSignal });
    };
    child.on('error', () => finish(-1));
    child.on('close', (code, endedSignal) => finish(code, endedSignal ?? undefined));
  });
  child.stdin.on('error', () => { /* error/close is reported by the process */ });
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, closed, close };
}
