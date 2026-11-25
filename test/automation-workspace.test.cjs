const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-automation.cjs')

const context = (signal = new AbortController().signal) => ({ clientId: 'test', deadline: Date.now() + 2000, signal })
const target = { key: 'android:test', platform: 'android', state: 'ready', transport: 'usb' }

function androidHandlers(overrides = {}) {
  const { androidTools } = load('src/main/automation/adapters/androidTools.ts', {
    '../../lib/devices/android': {},
    '../../lib/devices/androidApps': { packageArgument: value => value },
    '../../lib/devices/androidInspection': {},
    '../../lib/devices/androidWebviews': {},
    ...overrides,
  })
  return androidTools
}

test('advertised Android workspace operations match registered handlers and offline devices reject workspace reads', async () => {
  const { deviceCapabilities } = load('src/common/automation/capabilities.ts')
  const { createDeviceToolHandlers } = load('src/main/automation/adapters/harmonyTools.ts')
  const android = androidHandlers()
  const offline = { ...target, key: 'android:offline', state: 'offline' }
  const ios = { key: 'ios:usb-test', platform: 'ios', transport: 'usb', state: 'ready' }
  const receiver = { ...ios, key: 'ios:airplay-receiver', transport: 'receiver', state: 'waiting' }
  const handlers = createDeviceToolHandlers({
    discover: async () => ({ targets: [target, offline, ios, receiver], errors: [] }),
  }, android, { 'overview.get': async (_p, _c, device) => device.key })
  const enabled = new Set(Object.keys(handlers))
  const caps = deviceCapabilities(target, enabled)
  assert.deepEqual(Object.keys(caps).filter(k => caps[k].supported).sort(), Object.keys(android).sort())
  assert.equal(deviceCapabilities(offline, enabled, true)['apps.list'].available, false)
  assert.equal(deviceCapabilities(receiver, enabled, true)['overview.get'].supported, false)
  assert.equal(await handlers['overview.get']({ device: ios.key }, context()), ios.key)
  for (const [name, device, code] of [['overview.get', receiver, 'UNSUPPORTED'], ['apps.list', ios, 'UNSUPPORTED'], ['apps.list', offline, 'UNAVAILABLE']]) {
    await assert.rejects(handlers[name]({ device: device.key }, context()), { code })
  }
})

test('Android app writes recheck cancellation immediately before device dispatch', async () => {
  let unblock, ready, writes = 0
  const started = new Promise(resolve => { ready = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const android = androidHandlers({
    '../../lib/devices/androidApps': {
      packageArgument: value => value,
      AndroidCacheUnsupportedError: class extends Error {},
      androidStopBundle: async (_key, _name, beforeWrite) => {
        ready()
        await gate
        beforeWrite()
        writes++
        throw Error('lost acknowledgement')
      },
    },
  })
  const abort = new AbortController()
  const params = { bundle: 'example.app' }
  const result = android['apps.stop'](params, context(abort.signal), target)
  await started
  abort.abort()
  await assert.rejects(result, { code: 'CANCELLED', outcome: 'not-started' })
  unblock()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes, 0)
  await assert.rejects(android['apps.stop'](params, context(), target), { code: 'OUTCOME_UNKNOWN', outcome: 'unknown' })
  assert.equal(writes, 1)
})

test('APK cancellation reports whether pm install was dispatched and removes its staged file', async t => {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const { tmpdir } = require('node:os')
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'scrcpy-plus-install-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'test.apk')
  await fs.writeFile(source, Buffer.from([0x50, 0x4b, 3, 4]))
  for (const sent of [false, true]) {
    const abort = new AbortController()
    const started = Promise.withResolvers()
    const android = androidHandlers({
      '../../lib/devices/androidApps': { AndroidCacheUnsupportedError: class extends Error {} },
      '../../lib/devices/android': {
        async installAndroidApk(key, staged, dispatch, signal) {
          assert.equal(key, target.key)
          if (sent) dispatch()
          started.resolve(staged)
          return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        },
      },
    })
    const result = android['apps.install']({ path: source }, context(abort.signal), target)
    const staged = await started.promise
    abort.abort()
    await assert.rejects(result, { code: 'CANCELLED', outcome: sent ? 'unknown' : 'not-started' })
    // The client can finish before request-owned cleanup.
    await require('node:timers/promises').setImmediate()
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 1000
      const check = () => fs.stat(staged).then(() => {
        if (Date.now() >= deadline) reject(new Error('staged file was retained'))
        else setTimeout(check, 5)
      }, error => error.code === 'ENOENT' ? resolve() : reject(error))
      check()
    })
  }
})

test('Android WebView enumeration checks foreground PID and snapshot carries no frame reference', async () => {
  const calls = []
  let pid = 0
  const android = androidHandlers({
    '../../lib/devices/androidInspection': {
      androidGetTopBundle: async () => ({ pid }),
      captureAndroidPng: async () => Buffer.from('png fixture'),
    },
    '../../lib/devices/androidWebviews': {
      androidGetWebviews: async (key, pid) => { calls.push([key, pid]); return [{ id: 'page' }] },
    },
  })
  assert.deepEqual(await android['webviews.list']({}, context(), target), [])
  pid = 23
  assert.deepEqual(await android['webviews.list']({}, context(), target), [{ id: 'page' }])
  assert.deepEqual(calls, [[target.key, pid]])
  const image = await android['screen.snapshot']({}, context(), target)
  assert.equal(image.artifact.mimeType, 'image/png')
  assert.equal(image.frame, undefined)
  assert.equal(image.bytes.toString(), 'png fixture')
})

test('finite Logcat captures enforce duration and byte limits, and close only their reader', async () => {
  const { captureLogcat } = load('src/main/automation/adapters/logcat.ts')
  for (const full of [true, false]) {
    let killed = 0
    const adb = { subprocess: { noneProtocol: { spawn: async command => {
      assert.match(command, /^logcat .* -T 1 /)
      return {
        output: new ReadableStream({ start(stream) {
          if (full) stream.enqueue(Buffer.from('abcdef'))
        } }),
        exited: Promise.resolve(), kill: async () => { killed++ },
      }
    } } } }
    const result = await captureLogcat(adb, 10, 3, context())
    assert.equal(result.bytes.toString(), full ? 'abc' : '')
    assert.equal(result.artifact.truncated, full)
    assert.equal(killed, 1)
  }
})

test('runtime routes mirror commands to existing windows and USB iOS overview to the discovered target', async () => {
  let layout = 'independent', focused
  const usb = { key: 'ios:phone', platform: 'ios', state: 'ready', transport: 'usb' }
  const { createAutomationRuntime } = load('src/main/automation/runtime.ts', {
    electron: { ipcMain: { handle() {} } },
    '../window/main': {
      currentMirrorLayout: () => layout,
      setWorkspaceLayout: request => { layout = request.layout },
      focusWorkspaceMirror: key => { focused = key },
    },
    '../window/nativeMirror': { nativeMirrors: { setAutomationHooks() {} } },
    '../window/screencast': { setAutomationHooks() {} },
    '../lib/devices': { getDevices: async () => ({ targets: [usb], errors: [] }) },
    '../lib/devices/ios-usbmux': { getIosOverview: async target => ({ key: target.key }) },
    './adapters/androidTools': { androidTools: {} },
    '../lib/hdc': {}, '../lib/hdc/port': {}, '../lib/hdc/hilog': {}, '../lib/hdc/uitest': {},
    '../lib/hdc/base': {}, '../lib/hdc/bundle': {}, '../lib/hdc/screencastInput': {},
    '../lib/hdc/captureSessions': { setCaptureInputGate() {} },
  })
  const runtime = createAutomationRuntime('workspace-test', 'test')
  const call = (operation, params = {}) => runtime.dispatch({
    apiVersion: 1, requestId: 'workspace-test', clientId: 'test', operation, params,
  }, context())
  assert.deepEqual((await call('mirrors.layout')).data, { layout: 'independent' })
  assert.equal((await call('mirrors.arrange', { layout: 'merged' })).error.code, 'UNAVAILABLE')
  assert.equal((await call('mirrors.focus', { device: usb.key })).error.code, 'NOT_FOUND')
  assert.deepEqual((await call('overview.get', { device: usb.key })).data, { key: usb.key })
  runtime.controller.sessions.register(usb, { close() {}, hide() {}, show() {} })
  assert.deepEqual((await call('mirrors.arrange', { layout: 'merged' })).data, { layout: 'merged' })
  assert.deepEqual((await call('mirrors.focus', { device: usb.key })).data, { completed: true })
  assert.equal(focused, usb.key)
})
