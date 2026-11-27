import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { agentRuntimeSetup, agentLoginCommand } from '../src/workspaces/agentShell';
import { shellQuote as q } from '../src/connections';
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'nexus-agent-path-')); paths.push(home);
  const nvm = join(home, '.nvm'), bin = join(nvm, 'versions/node/fixture/bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nprintf node-fixture\n', { mode: 0o700 });
  writeFileSync(join(bin, 'nexus-fixture-cli'), '#!/bin/sh\nnode\nprintf ":%s" "$1"\n', { mode: 0o700 });
  const marker = join(home, 'must-not-install');
  writeFileSync(join(nvm, 'nvm.sh'), `nvm() { if [ "$1 $2" = 'which default' ]; then printf '%s\\n' ${q(join(bin, 'node'))}; else touch ${q(marker)}; return 1; fi; }\n`);
  const env = { HOME: home, NVM_DIR: nvm, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
  const run = (command: string) => spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' });
  return { home, bin, nvm, marker, env, run };
}
describe('Agent non-interactive runtime environment', () => {
  it('finds an installed NVM CLI and its node interpreter without installing or changing aliases', () => {
    const f = fixture(), source = readFileSync(join(f.nvm, 'nvm.sh'), 'utf8');
    const result = f.run(agentLoginCommand('nexus-fixture-cli hello'));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('node-fixture:hello');
    expect(existsSync(f.marker)).toBe(false);
    expect(readFileSync(join(f.nvm, 'nvm.sh'), 'utf8')).toBe(source);
  });
  it('preserves an existing executable and never loads NVM when PATH already resolves it', () => {
    const f = fixture();
    writeFileSync(join(f.nvm, 'nvm.sh'), `touch ${q(f.marker)}; return 1\n`);
    const result = f.run(agentRuntimeSetup('printf') + '\nprintf retained');
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('retained'); expect(existsSync(f.marker)).toBe(false);
  });
  it('preserves shell command semantics and exposes a missing command as exit 127', () => {
    const f = fixture();
    const result = f.run(agentLoginCommand("printf first; printf '%s' ' $(not-a-command)'"));
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('first $(not-a-command)');
    const missing = f.run(agentLoginCommand('nexus-uninstalled-cli'));
    expect(missing.status).toBe(127); expect(missing.stderr).toContain('nexus-uninstalled-cli');
  });
});
