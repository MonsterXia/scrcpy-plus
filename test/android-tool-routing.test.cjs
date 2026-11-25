const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')

test('Android workspace IPC is restricted to the main workspace document and retires a pending lease on reload', async () => {
  const url = 'file:///workspace/renderer/index.html'
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url } })
  const handlers = {}, released = [], calls = []
  let finish
  const mocks = {
    electron: { ipcMain: { handle(name, fn) { handlers[name] = fn } } },
    'share/common/util': { isDev: () => false },
    'share/main/lib/util': { resolve: p => '/workspace/' + p },
    'share/main/lib/window': { sendAll() {} },
    './android': { acquireAndroidAdb: () => new Promise(resolve => { finish = resolve }) },
    './androidApps': { androidGetBundles: async key => { calls.push(key); return ['sample'] } },
    './androidStreams': { closeAndroidStreams: async () => {} },
    './androidInspection': {}, './androidWebviews': {},
  }
  const module = { exports: {} }
  const script = transformSync(fs.readFileSync('src/main/lib/devices/androidTools.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInNewContext(script, { module, exports: module.exports, console, require: id => mocks[id] ?? require(id) })
  module.exports.initAndroidTools(contents)
  const read = handlers['android:getBundles']
  const ev = { sender: contents, senderFrame: contents.mainFrame }
  assert.throws(() => read({ ...ev, sender: {} }, 'android:a'), /unavailable/)
  assert.throws(() => read({ ...ev, senderFrame: { url } }, 'android:a'), /unavailable/)
  contents.mainFrame.url = 'https://example.org/'
  assert.throws(() => read(ev, 'android:a'), /unavailable/)
  contents.mainFrame.url = url
  assert.deepEqual(await read(ev, 'android:a'), ['sample'])
  assert.deepEqual(calls, ['android:a'])
  const opening = handlers['android:selectTools'](ev, 'android:a')
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  finish({ release: async () => released.push('a') })
  await opening
  await new Promise(setImmediate)
  assert.deepEqual(released, ['a'])
})
