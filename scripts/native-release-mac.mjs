import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const findBundlesScript = `
ObjC.import('Foundation')
function run([identifier, ...paths]) {
  return JSON.stringify(paths.filter(path => ObjC.unwrap($.NSBundle.bundleWithPath(path).bundleIdentifier) === identifier))
}`

const runningAppsScript = `
ObjC.import('AppKit')
function run([identifier, executableToQuit]) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(identifier)
  const matches = []
  for (let i = 0; i < Number(apps.count); i++) {
    const app = apps.objectAtIndex(i)
    if (app.terminated) continue
    const executable = ObjC.unwrap(app.executableURL.path)
    if (executable === executableToQuit) app.terminate
    matches.push({ pid: Number(app.processIdentifier), executable, finishedLaunching: app.finishedLaunching })
  }
  return JSON.stringify(matches)
}`

// The staging directory is on the same volume as the install path.
const renameBundleScript = `
ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']])
function run([source, destination, mode]) {
  const RENAME_SWAP = 2
  const RENAME_EXCL = 4
  const flags = mode === 'swap' ? RENAME_SWAP : RENAME_EXCL
  if ($.renamex_np(source, destination, flags) !== 0) throw Error('Could not move the macOS app bundle to ' + destination)
}`

async function appDirectories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
      .map(entry => join(directory, entry.name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function findInstallPath(run, identifier, bundleName) {
  const locations = await Promise.all([appDirectories('/Applications'), appDirectories(join(homedir(), 'Applications'))])
  const paths = JSON.parse(await run('osascript', ['-l', 'JavaScript', '-e', findBundlesScript, identifier, ...locations.flat()], { capture: true }))
  if (paths.length > 1) throw new Error(`Multiple installed macOS apps have bundle ID ${identifier}: ${paths.join(', ')}`)
  return paths[0] ?? join('/Applications', bundleName)
}

async function existingPath(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function readBundle(run, path, identifier) {
  const plist = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', join(path, 'Contents', 'Info.plist')], { capture: true }))
  if (plist.CFBundleIdentifier !== identifier) throw new Error(`Unexpected macOS app bundle ID at ${path}`)
  const executable = plist.CFBundleExecutable
  if (!executable || basename(executable) !== executable) throw new Error(`Invalid macOS app executable at ${path}`)
  await access(join(path, 'Contents', 'MacOS', executable))
  return { executable, version: plist.CFBundleShortVersionString, name: plist.CFBundleDisplayName ?? plist.CFBundleName }
}

async function signature(run, path) {
  const details = await run('/bin/sh', ['-c', '/usr/bin/codesign --display --verbose=4 "$1" 2>&1', 'codesign', path], { capture: true })
  if (/^Signature=adhoc$/m.test(details)) return { type: 'ad-hoc' }
  const authority = details.match(/^Authority=(.+)$/m)?.[1]
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1]
  if (!authority || !team || team === 'not set') throw new Error(`Could not identify macOS signing certificate at ${path}`)
  return { type: 'certificate', authority, team }
}

async function verifySignature(run, path) {
  await run('codesign', ['--verify', '--deep', '--strict', path])
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function dataManifest(directory, paths) {
  const entries = []
  async function visit(relative, stat) {
    const path = join(directory, relative)
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' })
      for (const child of (await readdir(path)).sort()) {
        const childPath = join(relative, child)
        await visit(childPath, await lstat(join(directory, childPath)))
      }
    } else if (stat.isFile()) {
      entries.push({ path: relative, type: 'file', sha256: await hashFile(path) })
    } else if (stat.isSymbolicLink()) {
      entries.push({ path: relative, type: 'symlink', target: await readlink(path) })
    } else {
      throw new Error(`Cannot back up macOS app data entry ${relative}`)
    }
  }
  for (const path of paths) {
    const stat = await existingPath(join(directory, path))
    if (stat) await visit(path, stat)
  }
  return entries
}

async function backupData(run, output, identifier) {
  const library = join(homedir(), 'Library')
  const paths = [
    `Application Support/${identifier}`,
    `Caches/${identifier}`,
    `Containers/${identifier}`,
    `Cookies/${identifier}.binarycookies`,
    `HTTPStorages/${identifier}`,
    `HTTPStorages/${identifier}.binarycookies`,
    `Preferences/${identifier}.plist`,
    `Saved Application State/${identifier}.savedState`,
    `WebKit/${identifier}`,
  ]
  const before = await dataManifest(library, paths)
  const directory = join(output, 'mac-data')
  await mkdir(directory, { mode: 0o700 })
  for (const relative of paths) {
    if (!before.some(entry => entry.path === relative)) continue
    const destination = join(directory, relative)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await run('ditto', [join(library, relative), destination])
  }
  const expected = JSON.stringify(before)
  if (JSON.stringify(await dataManifest(directory, paths)) !== expected) throw new Error('macOS app data backup does not match the original')
  const manifest = join(output, 'mac-data-sha256.json')
  await writeFile(manifest, `${JSON.stringify(before, null, 2)}\n`, { mode: 0o600 })
  return {
    directory,
    manifest,
    files: before.filter(entry => entry.type === 'file').length,
    async verifyOriginal() {
      if (JSON.stringify(await dataManifest(library, paths)) !== expected) throw new Error('macOS app data changed before launch')
    },
  }
}

async function runningApps(run, identifier, executableToQuit) {
  const args = ['-l', 'JavaScript', '-e', runningAppsScript, identifier]
  if (executableToQuit) args.push(executableToQuit)
  return JSON.parse(await run('osascript', args, { capture: true }))
}

async function quitApp(run, identifier, executable) {
  await runningApps(run, identifier, executable)
  const end = Date.now() + 15_000
  do {
    const apps = await runningApps(run, identifier)
    if (apps.some(app => app.executable !== executable)) throw new Error(`Quit the other running app with bundle ID ${identifier} before installing`)
    if (apps.length === 0) return
    await wait(250)
  } while (Date.now() < end)
  throw new Error('The installed macOS app did not quit. Close it and retry the release.')
}

async function launchApp(run, identifier, path, executable) {
  await run('open', ['-a', path])
  const end = Date.now() + 15_000
  do {
    const apps = await runningApps(run, identifier)
    const launched = apps.find(app => app.executable === executable && app.finishedLaunching)
    if (launched) {
      await wait(1500)
      const current = await runningApps(run, identifier)
      if (current.some(app => app.pid === launched.pid && app.executable === executable)) return launched
    }
    await wait(250)
  } while (Date.now() < end)
  throw new Error(`The installed macOS app did not stay running at ${path}`)
}

export async function releaseMac({ root, output, run, pnpm }) {
  if (process.platform !== 'darwin') throw new Error('The macOS release requires macOS')
  const desktop = join(root, 'apps', 'desktop')
  const tauri = join(desktop, 'src-tauri')
  const config = JSON.parse(await readFile(join(tauri, 'tauri.conf.json'), 'utf8'))
  const { name: packageName } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
  const identifier = config.identifier
  const bundleName = `${config.productName}.app`
  const installPath = await findInstallPath(run, identifier, bundleName)
  const installed = await existingPath(installPath)
  if (installed && !installed.isDirectory()) throw new Error(`The macOS installation path is occupied: ${installPath}`)
  const previous = installed ? await readBundle(run, installPath, identifier) : null
  const oldExecutable = previous && join(installPath, 'Contents', 'MacOS', previous.executable)
  const previousSha256 = oldExecutable && await hashFile(oldExecutable)
  const previousSignature = previous ? await signature(run, installPath) : null

  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || previousSignature?.authority || config.bundle?.macOS?.signingIdentity
  const useAdHoc = !signingIdentity || signingIdentity === '-'
  const targetDir = resolve(root, process.env.CARGO_TARGET_DIR ?? join(tauri, 'target'))
  const target = process.env.CARGO_BUILD_TARGET
  const args = ['--filter', packageName, 'exec', 'tauri', 'build', '--bundles', 'app']
  if (useAdHoc) args.push('--no-sign')
  if (target) args.push('--target', target)
  args.push('--', '--locked')
  const env = { CARGO_TARGET_DIR: targetDir }
  if (signingIdentity) env.APPLE_SIGNING_IDENTITY = signingIdentity
  await pnpm(args, { cwd: root, env })

  const built = join(targetDir, ...(target ? [target] : []), 'release', 'bundle', 'macos', bundleName)
  const app = join(output, bundleName)
  await run('ditto', [built, app])
  const candidate = await readBundle(run, app, identifier)
  if (useAdHoc) await run('codesign', ['--force', '--sign', '-', app])
  await verifySignature(run, app)
  const candidateSignature = await signature(run, app)
  if (previousSignature && JSON.stringify(previousSignature) !== JSON.stringify(candidateSignature)) {
    throw new Error('The macOS build signature differs from the installed app identity. Check the selected signing certificate.')
  }
  const binarySha256 = await hashFile(join(app, 'Contents', 'MacOS', candidate.executable))
  const evidence = { app, identifier, name: candidate.name, version: candidate.version, signature: candidateSignature.type, binarySha256 }
  if (previous && await hashFile(oldExecutable) !== previousSha256) {
    throw new Error('The installed macOS app changed during the build. Start the release again.')
  }
  const executable = join(installPath, 'Contents', 'MacOS', candidate.executable)
  const oldRunning = await runningApps(run, identifier)
  if (oldRunning.some(process => process.executable !== oldExecutable)) throw new Error(`Quit the other running app with bundle ID ${identifier} before installing`)
  const staging = await mkdtemp(join(dirname(installPath), '.native-release-'))
  const staged = join(staging, basename(installPath))
  const moveBundle = (source, destination) => run('osascript', ['-l', 'JavaScript', '-e', renameBundleScript, source, destination, previous ? 'swap' : 'move'])
  let replaced = false
  let preserveStaging = false
  try {
    await run('ditto', [app, staged])
    await verifySignature(run, staged)
    if (previous) await quitApp(run, identifier, oldExecutable)
    const data = await backupData(run, output, identifier)
    let rollbackApp = null
    if (previous) {
      const rollbackDirectory = join(output, 'previous-app')
      await mkdir(rollbackDirectory, { mode: 0o700 })
      rollbackApp = join(rollbackDirectory, basename(installPath))
      await run('ditto', [installPath, rollbackApp])
      await readBundle(run, rollbackApp, identifier)
      await verifySignature(run, rollbackApp)
    }
    if ((await runningApps(run, identifier)).length) throw new Error('The macOS app reopened during backup. Close it and retry the release.')
    await moveBundle(staged, installPath)
    replaced = true
    await verifySignature(run, installPath)
    if (await hashFile(executable) !== binarySha256) throw new Error('Installed macOS executable does not match the build')
    await data.verifyOriginal()
    if ((await runningApps(run, identifier)).length) throw new Error('The macOS app reopened before install verification completed')
    const launch = await launchApp(run, identifier, installPath, executable)
    const result = {
      ...evidence,
      installed: true,
      installPath,
      rollbackApp,
      dataBackup: data.directory,
      dataManifest: data.manifest,
      verifiedDataFiles: data.files,
      launch,
    }
    await writeFile(join(output, 'release.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    return result
  } catch (error) {
    try {
      if (replaced) {
        await quitApp(run, identifier, executable)
        await moveBundle(installPath, staged)
      }
      if (oldRunning.length && !(await runningApps(run, identifier)).length) await launchApp(run, identifier, installPath, oldExecutable)
    } catch (rollbackError) {
      preserveStaging = true
      throw new AggregateError([error, rollbackError], `macOS install failed and rollback was incomplete. Review ${staging} and ${output}.`)
    }
    throw error
  } finally {
    if (!preserveStaging) {
      await rm(staging, { recursive: true, force: true }).catch(error => {
        console.warn(`Could not remove macOS staging directory ${staging}: ${error.message}`)
      })
    }
  }
}
