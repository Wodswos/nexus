import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// The public Capacitor app ID is the base for the local Personal Team identifiers.
const appId = 'app.cortex.ios';
const durableRoots = [
  'Documents',
  'Library/Application Support',
  'Library/Cookies',
  'Library/HTTPStorages',
  'Library/Preferences',
  'Library/WebKit/WebsiteData',
  'Library/kvstore',
];

async function withScratch(work) {
  const scratch = await mkdtemp(join(tmpdir(), 'nexus-ios-release-'));
  try {
    return await work(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function devicectl(run, scratch, args, timeout = 20) {
  const file = join(scratch, `${randomUUID()}.json`);
  let commandError;
  try {
    await run('xcrun', ['devicectl', '--timeout', String(timeout), ...args, '--json-output', file], { capture: true });
  } catch (error) {
    commandError = error;
  }
  const report = await readFile(file, 'utf8').then(JSON.parse, error => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!commandError && report?.info?.outcome === 'success') return report.result;

  let reason;
  let denial;
  for (let cause = report?.error; cause; cause = cause.userInfo?.NSUnderlyingError?.error) {
    const info = cause.userInfo;
    reason = info?.NSLocalizedFailureReason?.string ?? info?.NSLocalizedDescription?.string ?? reason;
    if (cause.domain === 'FBSOpenApplicationErrorDomain') denial = info?.BSErrorCodeDescription?.string;
  }
  const error = new Error(reason || `devicectl ${args.slice(0, 3).join(' ')} failed`, { cause: commandError });
  if (denial === 'Locked') error.code = 'IOS_DEVICE_LOCKED';
  if (denial === 'Security') error.code = 'IOS_LAUNCH_SECURITY';
  throw error;
}

async function selectIphone(run, scratch, selector) {
  const { devices } = await devicectl(run, scratch, ['list', 'devices']);
  const paired = devices.filter(device =>
    device.hardwareProperties?.platform === 'iOS'
    && device.hardwareProperties?.reality === 'physical'
    && device.hardwareProperties?.deviceType === 'iPhone'
    && device.connectionProperties?.pairingState === 'paired');
  let choices = paired.filter(device => device.deviceProperties?.developerModeStatus === 'enabled');
  if (selector) {
    choices = paired.filter(device => [
      device.identifier,
      device.hardwareProperties.udid,
      device.deviceProperties?.name,
      ...(device.connectionProperties.potentialHostnames ?? []),
    ].includes(selector));
    if (!choices.length) {
      choices = paired.filter(device => device.hardwareProperties.marketingName === selector);
    }
  }
  if (choices.length !== 1) {
    throw new Error('Connect a paired iPhone with Developer Mode enabled. If several match, select one using --device and xcrun devicectl list devices.');
  }
  const selected = choices[0];
  const device = await retry(() => devicectl(run, scratch, ['device', 'info', 'details', '--device', selected.identifier]));
  if (device.deviceProperties?.developerModeStatus !== 'enabled' || !device.hardwareProperties?.udid) {
    throw new Error('Enable Developer Mode on the selected iPhone and reconnect it.');
  }
  return {
    identifier: selected.identifier,
    udid: device.hardwareProperties.udid,
    model: device.hardwareProperties.marketingName,
  };
}

function onDevice(run, scratch, device) {
  return (action, args = [], timeout) =>
    devicectl(run, scratch, ['device', ...action, '--device', device.identifier, ...args], timeout);
}

async function installedApp(call, bundleId) {
  const { apps } = await retry(() => call(['info', 'apps'], ['--bundle-id', bundleId]));
  return apps.find(app => app.bundleIdentifier === bundleId);
}

async function runningProcesses(call, app) {
  const bundlePath = fileURLToPath(app.url).replace(/\/$/, '');
  const { runningProcesses } = await retry(() => call(['info', 'processes']));
  return runningProcesses.filter(({ executable }) =>
    typeof executable === 'string' && dirname(executable.startsWith('file:') ? fileURLToPath(executable) : executable) === bundlePath);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function hashes(directory, folder = directory) {
  const files = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) Object.assign(files, await hashes(directory, path));
    else if (entry.isFile()) files[relative(directory, path)] = await sha256(path);
    else throw new Error(`Unexpected asset entry ${entry.name}`);
  }
  return files;
}

async function retry(work) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt === 3) throw error;
      await delay(500);
    }
  }
}

async function snapshotData(call, bundleId, directory) {
  const domain = ['--domain-type', 'appDataContainer', '--domain-identifier', bundleId];
  const inventory = await retry(() => call(['info', 'files'], domain, 35));
  const files = {};
  for (const root of durableRoots) {
    const entries = inventory.files.filter(({ relativePath }) => relativePath.startsWith(`${root}/`));
    if (!entries.length) continue;
    for (const entry of entries) {
      if (entry.relativePath.split('/').some(part => !part || part === '..' || part === '.') || entry.resources?.isSymbolicLink) {
        throw new Error('Unexpected path in the iPhone data container');
      }
    }
    const dest = join(directory, root);
    await mkdir(dest, { recursive: true, mode: 0o700 });
    try {
      await call(['copy', 'from'], [...domain, '--source', root, '--destination', dest], 35);
    } catch {
      // A wireless transfer can stop halfway. Reuse complete files and fetch the remainder below.
    }
    for (const entry of entries.filter(({ resources }) => !resources?.isDirectory)) {
      const path = join(directory, entry.relativePath);
      const hasFullFile = async () => {
        const stat = await lstat(path).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        return stat?.isFile() && stat.size === entry.metadata?.size;
      };
      if (!await hasFullFile()) {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await retry(async () => {
          await rm(path, { force: true });
          await call(['copy', 'from'], [...domain, '--source', entry.relativePath, '--destination', path], 45);
          if (!await hasFullFile()) throw new Error(`Incomplete iPhone data transfer: ${entry.relativePath}`);
        });
      }
      files[entry.relativePath] = await sha256(path);
    }
  }
  await writeJson(`${directory}-sha256.json`, files);
  return files;
}

function compareData(before, after) {
  const missing = Object.keys(before).filter(path => !(path in after));
  const changed = Object.keys(before).filter(path => path in after && before[path] !== after[path]);
  const extra = Object.keys(after).filter(path => !(path in before));
  return { filesBefore: Object.keys(before).length, filesAfter: Object.keys(after).length,
    missing, changed, extra, verified: !missing.length && !changed.length && !extra.length };
}

async function launchInstalled(call, app, manifest, path) {
  const sameVersion = app && String(app.bundleVersion) === manifest.build && app.version === manifest.version;
  if (!sameVersion) throw new Error('The installed iPhone app differs from this release. Select the correct release directory and phone.');
  let process;
  try {
    if (!(await runningProcesses(call, app)).length) {
      await call(['process', 'launch'], [manifest.bundleId], 25);
      await delay(3000);
    }
    [process] = await runningProcesses(call, app);
    if (!process) throw new Error('The iPhone app did not stay running after launch');
  } catch (error) {
    manifest.installation = 'installed';
    manifest.launchVerified = false;
    manifest.launchBlocked = { IOS_DEVICE_LOCKED: 'locked', IOS_LAUNCH_SECURITY: 'security' }[error.code] ?? 'launch failed';
    manifest.launchError = error.message;
    delete manifest.processIdentifier;
    delete manifest.verifiedAt;
    await writeJson(path, manifest);
    return manifest;
  }
  delete manifest.launchBlocked;
  delete manifest.launchError;
  manifest.installation = 'installed and launched';
  manifest.launchVerified = true;
  manifest.processIdentifier = process.processIdentifier;
  manifest.verifiedAt = new Date().toISOString();
  await writeJson(path, manifest);
  return manifest;
}

async function verifyProfile(run, app, scratch, signing, udid) {
  const decoded = join(scratch, 'embedded-profile.plist');
  await run('security', ['cms', '-D', '-i', join(app, 'embedded.mobileprovision'), '-o', decoded], { capture: true });
  const extract = async (key, format = 'raw') =>
    (await run('plutil', ['-extract', key, format, '-o', '-', decoded], { capture: true })).trim();
  const expiry = await extract('ExpirationDate');
  if (!(Date.parse(expiry) > Date.now())) throw new Error('The signed app has an expired provisioning profile');
  const team = await extract('TeamIdentifier.0');
  const prefix = await extract('ApplicationIdentifierPrefix.0');
  const identifier = await extract('Entitlements.application-identifier');
  if (team !== signing.DEVELOPMENT_TEAM || identifier !== `${prefix}.${signing.PRODUCT_BUNDLE_IDENTIFIER}`) {
    throw new Error('The signed provisioning profile differs from the Xcode app identity');
  }
  const provisioned = JSON.parse(await extract('ProvisionedDevices', 'json'));
  if (!provisioned.some(value => value.toUpperCase() === udid.toUpperCase())) {
    throw new Error('The provisioning profile does not include the selected iPhone. Register it with the Xcode signing team.');
  }
  return expiry;
}

export async function releaseIos({ root, output, run, pnpm, options = {} }) {
  return withScratch(async scratch => {
    const native = join(root, 'apps/mobile/ios/App');
    const workspace = join(native, 'App.xcworkspace');
    try {
      await lstat(workspace);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error('Set up the local Capacitor iOS project and Xcode signing before releasing to iPhone');
    }
    const buildArgs = ['-workspace', workspace, '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS'];
    const targets = JSON.parse(await run('xcodebuild', [...buildArgs, '-showBuildSettings', '-json'], { cwd: root, capture: true }));
    const signing = targets.find(({ buildSettings }) => buildSettings?.PRODUCT_TYPE === 'com.apple.product-type.application')?.buildSettings;
    const bundleId = signing?.PRODUCT_BUNDLE_IDENTIFIER;
    const product = signing?.FULL_PRODUCT_NAME;
    if (!bundleId || !signing.DEVELOPMENT_TEAM || !product?.endsWith('.app') || basename(product) !== product) {
      throw new Error('Set the local App target’s signing team and bundle identifier in Xcode');
    }
    const device = await selectIphone(run, scratch, options.device);
    const call = onDevice(run, scratch, device);
    const { apps } = await retry(() => call(['info', 'apps']));
    const previous = apps.find(app => app.bundleIdentifier === bundleId);
    if (!previous && apps.some(app => app.bundleIdentifier === appId || app.bundleIdentifier?.startsWith(`${appId}.`))) {
      throw new Error('A related iPhone app uses a different bundle identifier. Set the local Xcode App target to that identifier to update its data container.');
    }
    const oldBuild = Number(previous?.bundleVersion ?? 0);
    const configuredBuild = Number(signing.CURRENT_PROJECT_VERSION);
    if (!Number.isSafeInteger(oldBuild) || oldBuild < 0 || !Number.isSafeInteger(configuredBuild) || configuredBuild < 0) {
      throw new Error('The iPhone release command expects integer Xcode and installed build numbers');
    }
    const build = String(Math.max(1, configuredBuild, oldBuild + 1));
    const web = join(scratch, 'web');
    await pnpm(['--filter', '@nexus/mobile', 'run', 'build:web', '--outDir', web, '--emptyOutDir'], { cwd: root });
    const www = join(root, 'apps/mobile/www');
    await rm(www, { recursive: true, force: true });
    await cp(web, www, { recursive: true });
    await pnpm(['--filter', '@nexus/mobile', 'exec', 'cap', 'sync', 'ios'], { cwd: root });
    await run('node', [join(root, 'apps/mobile/scripts/configure-ios.mjs')], { cwd: root });
    const derived = join(scratch, 'derived');
    await run('xcodebuild', [...buildArgs, '-derivedDataPath', derived, '-allowProvisioningUpdates', `CURRENT_PROJECT_VERSION=${build}`, 'build'], { cwd: root });
    const artifact = join(output, product);
    await run('ditto', [join(derived, 'Build/Products/Release-iphoneos', product), artifact], { cwd: root });
    await run('codesign', ['--verify', '--deep', '--strict', artifact], { capture: true });
    const info = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', join(artifact, 'Info.plist')], { capture: true }));
    if (info.CFBundleIdentifier !== bundleId || String(info.CFBundleVersion) !== build) throw new Error('The signed app bundle identity or build differs from the requested release');
    const profileExpiresAtUTC = await verifyProfile(run, artifact, scratch, signing, device.udid);
    const resources = await hashes(web);
    for (const [path, digest] of Object.entries(resources)) {
      if (await sha256(join(artifact, 'public', path)) !== digest) throw new Error(`Bundled iOS resource differs from the current web build: ${path}`);
    }
    await writeJson(join(output, 'mobile-resource-sha256.json'), resources);
    const path = join(output, 'release-manifest.json');
    const manifest = {
      schemaVersion: 1, platform: 'ios', device, bundleId, build, artifact, version: info.CFBundleShortVersionString,
      previousBuild: previous?.bundleVersion ?? null, profileExpiresAtUTC, signatureVerified: true,
      resourcesVerified: Object.keys(resources).length, installation: 'pending', launchVerified: false,
    };
    await writeJson(path, manifest);

    const current = await installedApp(call, bundleId);
    if (current?.bundleVersion !== previous?.bundleVersion || current?.url !== previous?.url) {
      throw new Error('The iPhone app changed during the build. Start the release again.');
    }
    let before = {};
    if (current) {
      for (const process of await runningProcesses(call, current)) {
        await call(['process', 'terminate'], ['--pid', String(process.processIdentifier)]);
      }
      await retry(async () => {
        if ((await runningProcesses(call, current)).length) throw new Error('The iPhone app did not exit before backup. Close it and retry.');
      });
      before = await snapshotData(call, bundleId, join(output, 'app-data-before'));
      if ((await runningProcesses(call, current)).length) throw new Error('The app opened during backup. Close it and restart the release.');
    }
    await call(['install', 'app'], [artifact], 90);
    manifest.installation = 'installed';
    await writeJson(path, manifest);
    const installed = await installedApp(call, bundleId);
    if (!installed || String(installed.bundleVersion) !== build || installed.version !== manifest.version) {
      throw new Error('Could not verify the installed iPhone app and build');
    }
    if (current && (await runningProcesses(call, installed)).length) throw new Error('The app opened before data verification completed');
    const after = current ? await snapshotData(call, bundleId, join(output, 'app-data-after')) : {};
    manifest.dataPreservation = compareData(before, after);
    await writeJson(path, manifest);
    if (!manifest.dataPreservation.verified) throw new Error('iPhone app data differs after installation. Check the release manifest and backup.');
    return launchInstalled(call, installed, manifest, path);
  });
}

export async function verifyIosLaunch({ output, run, options = {} }) {
  const path = join(output, 'release-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'ios' || !manifest.bundleId || !manifest.build
      || !manifest.dataPreservation?.verified || !['installed', 'installed and launched'].includes(manifest.installation)) {
    throw new Error('Select an iOS release directory containing a verified installation');
  }
  return withScratch(async scratch => {
    const device = await selectIphone(run, scratch, options.device ?? manifest.device.udid);
    if (device.udid !== manifest.device.udid) throw new Error('This release was installed on another iPhone');
    const call = onDevice(run, scratch, device);
    return launchInstalled(call, await installedApp(call, manifest.bundleId), manifest, path);
  });
}
