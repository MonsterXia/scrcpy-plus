const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const { transformSync } = require('esbuild')

const code = transformSync(readFileSync('src/main/lib/devices/androidApps.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
const key = 'android:fixture'
const pkg = 'com.example.app'
const activity = `${pkg}/.Main$Launcher`
const resolver = `cmd package resolve-activity --brief --user 12 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${pkg}`
const supported = '  clear [--user USER_ID] [--cache-only] PACKAGE\n'
const metadata = `Activity Resolver Table:
  Android.intent.action.MAIN:
Packages:
  Package [${pkg}] (4321):
    versionCode=18 minSdk=25 targetSdk=34
    versionName=1.8
    flags=[ SYSTEM HAS_CODE ]
    User 0: installed=true
      firstInstallTime=2020-05-06 12:14:00
    User 12: installed=true
      firstInstallTime=2023-08-03 01:02:03
Hidden system packages:
  Package [${pkg}] (ffff):
    versionName=1.0`

function fixture(responses, metadataReader, checkLeaseSignal = () => {}) {
  const module = { exports: {} }
  const calls = []
  const deps = {
    './androidAppMetadata': { readPackageMetadata: metadataReader || (async () => { throw new Error('not available') }) },
    './android': { withAndroidAdb: async (value, fn, signal) => {
      assert.equal(value, key)
      checkLeaseSignal(signal)
      return fn({})
    } },
    './androidShell': { readAndroidShell: async (_adb, script, _limit, _timeout, signal) => {
      signal?.throwIfAborted()
      const suffix = "; printf '\\nSCRCPY_EXIT:%d\\n' \"$?\""
      assert.ok(script.endsWith(suffix), 'operation must preserve remote exit status')
      const command = script.slice(0, -suffix.length)
      calls.push(command)
      const configured = responses[command]
      const response = typeof configured === 'function' ? await configured(signal)
        : configured ?? (command === 'am get-current-user' ? '12' : undefined)
      if (response === undefined) throw new Error(`unexpected command ${command}`)
      const [output, exit] = Array.isArray(response) ? response : [response, 0]
      return `${output}\nSCRCPY_EXIT:${exit}\n`
    } },
  }
  vm.runInNewContext(code, { module, exports: module.exports, AbortSignal, require: id => deps[id] })
  return { apps: module.exports, calls }
}

test('lists active-user packages and filters system packages on the device', async () => {
  const { apps } = fixture({
    'pm list packages --user 12': `package:${pkg}\npackage:android\n`,
    'pm list packages -3 --user 12': `package:${pkg}\n`,
  })
  assert.deepEqual([...await apps.androidGetBundles(key)], ['android', pkg])
  assert.deepEqual([...await apps.androidGetBundles(key, false)], [pkg])
})

test('reads installed metadata and launcher for the selected user while tolerating a removed package', async () => {
  const { apps } = fixture({
    'pm help': supported, [resolver]: `priority=0\n${activity}\n`,
    [`dumpsys package ${pkg}`]: metadata, 'dumpsys package removed': 'Unable to find package: removed',
  })
  const [info, missing] = await apps.androidGetBundleInfos(key, [pkg, 'removed'])
  assert.equal(info.bundleName, pkg)
  assert.equal(info.versionName, '1.8')
  assert.equal(info.apiTargetVersion, 34)
  assert.equal(info.installTime, new Date(2023, 7, 3, 1, 2, 3).getTime())
  assert.equal(info.system, true)
  assert.equal(info.mainAbility, activity)
  assert.equal(info.supportsCleanCache, true)
  assert.equal(missing, undefined)
})

test('older devices and packages without launchers retain accurate available actions', async () => {
  const { apps, calls } = fixture({
    'pm help': '  clear PACKAGE', [resolver]: 'another.app/.Resolver',
    [`dumpsys package ${pkg}`]: metadata,
  })
  const [info] = await apps.androidGetBundleInfos(key, [pkg])
  assert.equal(info.supportsCleanCache, false)
  assert.equal(info.mainAbility, undefined)
  await assert.rejects(apps.androidCleanBundleCache(key, pkg), /unavailable/)
  assert.ok(!calls.some(command => command.startsWith('pm clear')))
})

test('package dump fallback ignores packages missing or uninstalled for the selected user', async () => {
  for (const state of ['User 12: installed=false', 'User 13: installed=true']) {
    const { apps, calls } = fixture({
      'pm help': supported,
      [`dumpsys package ${pkg}`]: metadata.replace('User 12: installed=true', state),
    })
    assert.equal((await apps.androidGetBundleInfos(key, [pkg])).length, 0)
    assert.ok(!calls.includes(resolver))
  }
})

test('package mutations confirm results and act only on the current user', async () => {
  const { apps } = fixture({
    'pm help': supported,
    [`am start --user 12 -n '${activity}'`]: 'Starting: Intent { cmp=... }',
    [`am force-stop --user 12 ${pkg}`]: '',
    [`pm clear --cache-only --user 12 ${pkg}`]: 'Success',
    [`pm clear --user 12 ${pkg}`]: 'Success',
    [`pm uninstall --user 12 ${pkg}`]: 'Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]',
  })
  await apps.androidStartBundle(key, pkg, activity)
  await apps.androidStopBundle(key, pkg)
  await apps.androidCleanBundleCache(key, pkg)
  await apps.androidCleanBundleData(key, pkg)
  await assert.rejects(apps.androidUninstallBundle(key, pkg), /failed/)
  const failed = fixture({ [`am force-stop --user 12 ${pkg}`]: ['', 1] })
  await assert.rejects(failed.apps.androidStopBundle(key, pkg), /failed/)
})

test('rejects invalid package and component arguments before opening ADB', async () => {
  const { apps, calls } = fixture({})
  assert.throws(() => apps.androidGetBundleInfos(key, [pkg, '-x']))
  assert.throws(() => apps.androidStartBundle(key, pkg, 'different.package/.Main'))
  assert.throws(() => apps.androidStartBundle(key, pkg, pkg + "/.Quo'te"))
  await assert.rejects(apps.androidUninstallBundle(key, pkg + '\n'))
  assert.deepEqual(calls, [])
})

test('only associates processes whose name and UID match the active user package', async () => {
  const { apps } = fixture({
    'pm list packages -U --user 12': `package:${pkg} uid:1210020\n`,
    'ps -A -o PID,UID,USER,PCPU,TIME,RSS,NAME 2>/dev/null || ps': [
      'PID UID USER %CPU TIME RSS NAME',
      `45 1210020 u12_a20 2.5 00:00:05 3488 ${pkg}:worker`,
      `46 10020 u0_a20 0.0 00:00:01 1024 ${pkg}`,
      '47 0 root 0.1 00:00:06 500 kworker/0:1',
    ].join('\n'),
  })
  const [worker, otherUser, kernel] = await apps.androidGetProcesses(key)
  assert.equal(worker.bundleName, pkg)
  assert.equal(worker.res, '3488K')
  assert.equal(worker['%cpu'], '2.5')
  assert.equal(otherUser.bundleName, undefined)
  assert.equal(kernel.bundleName, undefined)
})

test('shows only available process fields on Android devices with the old toolbox ps', async () => {
  const { apps } = fixture({
    'ps -A -o PID,UID,USER,PCPU,TIME,RSS,NAME 2>/dev/null || ps': [
      'USER PID PPID VSIZE RSS WCHAN PC NAME',
      'u0_a31 981 557 71020 9290 ffffffff 00000000 S com.example.app',
    ].join('\n'),
  })
  const [row] = await apps.androidGetProcesses(key)
  assert.equal(row.name, pkg)
  assert.equal(row.pid, '981')
  assert.equal(row.res, '9290K')
  assert.equal(row.bundleName, undefined)
})

test('batches PackageManager metadata and uses resource labels and thumbnails without per-package shell commands', async () => {
  const names = Array.from({length: 67}, (_, i) => 'com.test.app' + i)
  const batches = []
  const { apps, calls } = fixture({ 'pm help': supported }, async (_adb, user, batch) => {
    assert.equal(user, '12')
    batches.push(batch.length)
    return batch.map(name => ({ bundleName: name, label: '本机应用', png: 'iVBORw0KGgo=', system: false,
      apiTargetVersion: 35, installTime: 123456789, versionName: '9', mainAbility: name + '/.Launcher' }))
  })
  const result = await apps.androidGetBundleInfos(key, names)
  assert.equal(result.length, names.length)
  assert.equal(result[4].label, '本机应用')
  assert.equal(result[4].icon, 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(result[4].mainAbility, names[4] + '/.Launcher')
  assert.equal(result[4].installTime, 123456789)
  assert.deepEqual(batches, [64, 3])
  assert.deepEqual(calls, ['am get-current-user', 'pm help'])
})

test('metadata cancellation stops user, capability, helper and fallback reads before the next device command', async () => {
  for (const stage of ['am get-current-user', 'pm help', 'helper', `dumpsys package ${pkg}`, resolver]) {
    const abort = new AbortController()
    const commands = []
    const read = (name, value) => signal => {
      commands.push(name)
      assert.ok(signal)
      if (name === stage) {
        abort.abort(new Error('metadata cancelled'))
        assert.equal(signal.aborted, true)
        throw signal.reason
      }
      return value
    }
    const { apps } = fixture({
      'am get-current-user': read('am get-current-user', '12'),
      'pm help': read('pm help', supported),
      [`dumpsys package ${pkg}`]: read(`dumpsys package ${pkg}`, metadata),
      [resolver]: read(resolver, activity),
    }, async (_adb, _user, _names, signal) => {
      read('helper')(signal)
      throw Error('helper unavailable')
    }, signal => assert.equal(signal, abort.signal))
    await assert.rejects(apps.androidGetBundleInfos(key, [pkg, 'another.package'], abort.signal), /metadata cancelled/)
    assert.equal(commands.at(-1), stage)
  }
})

function loadMetadataHelper(shell) {
  const metadataCode = transformSync(readFileSync('src/main/lib/devices/androidAppMetadata.ts', 'utf8'), {
    loader: 'ts', format: 'cjs',
  }).code
  const module = { exports: {} }
  const deps = {
    'node:crypto': require('node:crypto'),
    'node:fs/promises': { readFile: async () => Buffer.from('test archive') },
    '@yume-chan/stream-extra': { ReadableStream: { from: input => input } },
    'share/main/lib/util': { resolveResources: path => path },
    './androidShell': {
      ...require('./helpers/load-automation.cjs')('src/main/lib/devices/androidShell.ts'),
      readAndroidShell: shell,
    },
  }
  vm.runInNewContext(metadataCode, { module, exports: module.exports, require: id => deps[id] })
  return module.exports.readPackageMetadata
}

test('metadata helper uses a private read-only path per concurrent batch and removes partial uploads', async () => {
  const written = [], removed = []
  let disposed = 0, failUpload = false
  const adb = {
    async sync() {
      return {
        async write(options) {
          written.push(options.filename)
          assert.equal(options.permission, 0o444)
          assert.deepEqual(await Array.fromAsync(options.file), [Buffer.from('test archive')])
          if (failUpload) throw new Error('upload failed')
        },
        async dispose() { disposed++ },
      }
    },
  }
  const metadata = loadMetadataHelper(async (_adb, command) => {
    if (command.startsWith('rm -f ')) return removed.push(command.slice(6))
    assert.match(command, /\.jar app_process \/ com\.genymobile\.scrcpy\.WorkspaceApps 0 com\.example\.app$/)
    return 'SCRCPY_WORKSPACE_APPS []\n'
  })
  const read = () => metadata(adb, '0', [pkg], new AbortController().signal)
  await Promise.all([read(), read()])
  failUpload = true
  await assert.rejects(read(), /upload failed/)
  assert.equal(disposed, 3)
  assert.equal(new Set(written).size, 3)
  assert.deepEqual(removed.sort(), [...written].sort())
  assert.ok(written.every(name => name.startsWith('/data/local/tmp/scrcpy-plus-apps-')))
})

test('cancelled metadata closes a late sync channel or partial upload without running the helper', async () => {
  for (const stage of ['open', 'upload']) {
    const abort = new AbortController()
    const opening = Promise.withResolvers(), started = Promise.withResolvers()
    const commands = []
    let writes = 0, closes = 0
    const channel = {
      write() { writes++; started.resolve(); return new Promise(() => {}) },
      async dispose() { closes++ },
    }
    const adb = { sync() {
      if (stage === 'upload') return Promise.resolve(channel)
      started.resolve()
      return opening.promise
    } }
    const metadata = loadMetadataHelper(async (_adb, command, _max, timeout, signal) => {
      commands.push(command)
      assert.equal(timeout, 5000)
      assert.equal(signal, undefined)
      return ''
    })
    const read = metadata(adb, '0', [pkg], abort.signal)
    await started.promise
    abort.abort(new Error('cancel metadata'))
    opening.resolve(channel)
    await assert.rejects(read, /cancel metadata/)
    assert.equal(closes, 1)
    assert.equal(writes, stage === 'upload' ? 1 : 0)
    assert.equal(commands.length, writes)
    assert.ok(commands.every(command => command.startsWith('rm -f /data/local/tmp/scrcpy-plus-apps-')))
  }
})
