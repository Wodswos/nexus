import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const flagsByName = new Map([['--device', 'device'], ['--resume', 'resume']]);
const usage = `Usage
  pnpm release:native mac
  pnpm release:native ios [--device <iPhone name, model, or identifier>]
  pnpm release:native all [--device <iPhone name, model, or identifier>]
  pnpm release:native ios --resume <ios release directory>

Build and update the local Mac app and/or a paired iPhone.
When one eligible iPhone is available, it is selected automatically.
Use --resume to verify a completed iPhone installation and retry launch.
Release evidence and backups are saved under backups/native-*/.`;

function parseArgs(args) {
  const [platform, ...flags] = args;
  if (!['mac', 'ios', 'all'].includes(platform)) {
    throw new Error('Choose mac, ios, or all. Run pnpm release:native --help for usage.');
  }
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    const key = flagsByName.get(flag);
    if (!key || !value?.trim() || value.startsWith('--') || options[key] !== undefined) {
      throw new Error(`Invalid release option ${flag}. Run pnpm release:native --help for usage.`);
    }
    options[key] = value;
  }
  if (options.device && platform === 'mac') throw new Error('--device requires ios or all.');
  if (options.resume && (platform !== 'ios' || options.device)) {
    throw new Error('--resume requires ios and uses the device recorded in the release.');
  }
  return { platform, options };
}

const releaseEnv = {
  ...process.env,
  // The default Rustup location also works from a shell that has not loaded cargo/env.
  PATH: [process.env.PATH, join(homedir(), '.cargo', 'bin')].filter(Boolean).join(delimiter),
};

function run(command, args, { cwd = root, env = {}, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...releaseEnv, ...env },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolveRun(stdout);
      const detail = stderr.trim() || stdout.trim();
      const error = new Error(`${command} exited with ${signal ?? code}${detail ? `\n${detail}` : ''}`);
      Object.assign(error, { code, signal, stderr, stdout });
      reject(error);
    });
  });
}

const pnpm = (args, options) => run('pnpm', args, options);

function requireIosLaunch(result, output) {
  if (result.launchVerified) return;
  const quoted = `'${output.replaceAll("'", "'\\''")}'`;
  throw new Error(`iPhone installation and data verification completed. Unlock the iPhone and retry launch with:\n  pnpm release:native ios --resume ${quoted}`);
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(usage);
    return;
  }
  const { platform, options } = parseArgs(args);
  if (process.platform !== 'darwin') throw new Error('Native release requires macOS.');

  // Both builds share web/dist, and both installers touch local devices.
  if (process.env.NEXUS_NATIVE_RELEASE_LOCKED !== '1') {
    const directory = join(homedir(), 'Library', 'Caches', 'nexus-native-release');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await run('/usr/bin/lockf', ['-k', '-t', '0', join(directory, 'release.lock'), process.execPath, script, ...args], {
        env: { NEXUS_NATIVE_RELEASE_LOCKED: '1' },
      });
    } catch (error) {
      if (error.code !== 1) throw error;
      process.exitCode = 1; // The child already reported its release error.
    }
    return;
  }

  const context = { root, run, pnpm, options };
  if (options.resume) {
    const { verifyIosLaunch } = await import('./native-release-ios.mjs');
    const output = resolve(options.resume);
    requireIosLaunch(await verifyIosLaunch({ ...context, output }), output);
    console.log('iPhone launch verified.');
    return;
  }

  const { packageManager } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = (await pnpm(['--version'], { capture: true })).trim();
  if (`pnpm@${version}` !== packageManager) throw new Error(`This checkout requires ${packageManager}.`);

  const backupRoot = join(root, 'backups');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const release = await mkdtemp(join(backupRoot, `native-${timestamp}-`));
  const commit = (await run('git', ['rev-parse', 'HEAD'], { capture: true })).trim();
  const changes = await run('git', ['status', '--porcelain'], { capture: true });
  await writeFile(join(release, 'source.json'), JSON.stringify({ commit, workingTreeDirty: !!changes.trim(), platform }, null, 2) + '\n', { mode: 0o600 });
  console.log(`Native release directory ${release}`);

  if (platform === 'mac' || platform === 'all') {
    const { releaseMac } = await import('./native-release-mac.mjs');
    const output = join(release, 'mac');
    await mkdir(output, { mode: 0o700 });
    await releaseMac({ ...context, output });
  }
  if (platform === 'ios' || platform === 'all') {
    const { releaseIos } = await import('./native-release-ios.mjs');
    const output = join(release, 'ios');
    await mkdir(output, { mode: 0o700 });
    requireIosLaunch(await releaseIos({ ...context, output }), output);
  }
  console.log(`Native release verified for ${platform}.`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
