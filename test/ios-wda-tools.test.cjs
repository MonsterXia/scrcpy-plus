const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { EventEmitter } = require('node:events')
const load = require('./helpers/load-ios.cjs')

test('WDA tool IPC accepts ready USB devices from the workspace and cancels reads on navigation or request', async () => {
  const sender = Object.assign(new EventEmitter(), { mainFrame: { url: 'http://localhost:8080/' } })
  const handlers = new Map()
  const { initIosWdaTools } = load('src/main/lib/devices/ios-wda-tools-ipc.ts', {
    electron: { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } },
    'share/common/util': { isDev: () => true },
    'share/main/lib/util': {},
    'share/main/lib/window': { getWin: () => ({ webContents: sender }) },
    '../../window/nativeMirror': { nativeMirrors: {
      iosWorkspaceSnapshot(_target, _panel, signal) {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled'))))
      },
    } },
  })
  const key = 'ios:01234567'
  const reconcile = initIosWdaTools(id => id === key ? { key, platform: 'ios', transport: 'usb', state: 'ready' } : undefined)
  const read = handlers.get('ios:wdaSnapshot'), cancel = handlers.get('ios:cancelWdaSnapshot')
  const event = { sender, senderFrame: sender.mainFrame }
  await assert.rejects(read({ ...event, senderFrame: {} }, key, 'layout', randomUUID()), /window/)
  await assert.rejects(read(event, 'ios:airplay-receiver', 'layout', randomUUID()), /Invalid/)
  await assert.rejects(read(event, key, 'shell', randomUUID()), /Invalid/)
  const id = randomUUID()
  const pending = read(event, key, 'layout', id)
  await assert.rejects(read(event, key, 'layout', id), /Invalid/)
  cancel(event, id)
  await assert.rejects(pending, /cancelled/)
  const unplugged = read(event, key, 'layout', randomUUID())
  reconcile([])
  await assert.rejects(unplugged, /cancelled/)
  const next = read(event, key, 'screenshot', id)
  sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await assert.rejects(next, /cancelled/)
  assert.equal(sender.listenerCount('did-start-navigation'), 0)
  assert.equal(sender.listenerCount('render-process-gone'), 0)
})
