const assert = require('node:assert/strict')
const { test } = require('node:test')
const { once, EventEmitter } = require('node:events')
const http = require('node:http')
const net = require('node:net')
const { Duplex } = require('node:stream')
const load = require('./helpers/load-automation.cjs')

const fixture = (read, adb = {}) => ({
  './androidShell': { readAndroidShellOutput: async (_, command) => Buffer.from(await read(command)) },
  './android': { withAndroidAdb: (_, fn) => fn(adb) },
})
const base = 'src/main/lib/devices/'

test('direct USB sends a terminated abstract socket name on modern adbd', async () => {
  const { AdbPacketDispatcher } = await import('@yume-chan/adb/esm/daemon/dispatcher.js')
  const { AdbCommand } = await import('@yume-chan/adb/esm/daemon/packet.js')
  const { Consumable, ReadableStream } = await import('@yume-chan/stream-extra')
  const services = []
  let incoming
  const dispatcher = new AdbPacketDispatcher({
    readable: new ReadableStream({ start(controller) { incoming = controller } }),
    writable: new Consumable.WritableStream({
      write(packet) {
        if (packet.command === AdbCommand.Open) {
          services.push(Buffer.from(packet.payload).toString())
          incoming.enqueue({ command: AdbCommand.Okay, arg0: 9, arg1: packet.arg0, payload: new Uint8Array() })
        }
      },
    }),
  }, { appendNullToServiceString: false, calculateChecksum: false, initialDelayedAckBytes: 0, maxPayloadSize: 4096 })
  try {
    await dispatcher.createSocket('localabstract:webview_devtools_remote_123')
    await dispatcher.createSocket('shell:echo ok')
    assert.deepEqual(services, ['localabstract:webview_devtools_remote_123\0', 'shell:echo ok'])
  } finally {
    await dispatcher.close()
  }
})

test('Android returns original PNG bytes and rejects failed or truncated screencaps', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5f0AAAAASUVORK5CYII=', 'base64')
  let output = png
  const api = load(base + 'androidInspection.ts', fixture(command => {
    assert.equal(command, 'screencap -p')
    return output
  }))
  assert.equal(await api.androidScreencap('android:a'), png.toString('base64'))
  output = png.subarray(0, -4)
  await assert.rejects(api.androidScreencap('android:a'), /PNG/)
  output = 'Permission denied'
  await assert.rejects(api.androidScreencap('android:a'), /PNG/)
})

test('UI Automator exports original hierarchy and uses a distinct shell-cleaned path for each request', async () => {
  const xml = '<?xml version="1.0"?><hierarchy rotation="1"><node bounds="[-23,0][400,320]"/></hierarchy>'
  const paths = []
  let output = xml
  const api = load(base + 'androidInspection.ts', fixture(command => {
    const path = command.match(/uiautomator dump (\S+)/)[1]
    assert.ok(command.includes(`trap 'rm -f ${path}' EXIT`))
    assert.ok(command.includes(`uiautomator dump ${path} >/dev/null 2>&1`))
    assert.ok(command.includes(`cat ${path}`))
    paths.push(path)
    return output
  }))
  assert.deepEqual(await Promise.all([api.androidDumpLayout('a'), api.androidDumpLayout('a')]), [xml, xml])
  assert.notEqual(paths[0], paths[1])
  output = 'ERROR: null root node returned'
  await assert.rejects(api.androidDumpLayout('a'), /hierarchy/)
})

test('debug-enabled foreground WebView pages use a selected-page loopback relay owned by the inspector window', async t => {
  const touched = [], upgrades = [], windows = []
  let released = 0
  let closeGate
  const device = http.createServer((req, res) => {
    assert.equal(req.url, '/json/list')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([
      { id: 'p1', type: 'page', title: 'WebView', url: 'https://example.test',
        webSocketDebuggerUrl: 'ws://localhost/devtools/page/p1' },
      { id: 'bogus', type: 'page', webSocketDebuggerUrl: 'ws://example.test/devtools/browser/x' },
    ]))
  })
  device.on('upgrade', (req, socket) => {
    upgrades.push(req.url)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', data => socket.write(data))
    socket.on('error', () => {})
    socket.on('end', () => socket.destroy())
  })
  device.listen(0, '127.0.0.1')
  await once(device, 'listening')
  t.after(() => { device.closeAllConnections(); device.close() })
  const adb = {
    disconnected: new Promise(() => {}),
    async createSocket(service) {
      touched.push(service)
      const socket = net.connect(device.address().port, '127.0.0.1')
      await once(socket, 'connect')
      const gate = closeGate
      let resolveClosed
      const closed = new Promise(resolve => { resolveClosed = resolve })
      return {
        ...Duplex.toWeb(socket), closed,
        close: () => {
          socket.destroy()
          if (gate) {
            gate.started()
            void gate.acknowledged.then(resolveClosed)
          } else resolveClosed()
        },
      }
    },
  }
  let listening = false
  const mocks = fixture(command => {
    if (command.startsWith('dumpsys activity activities')) return 'topResumedActivity=ActivityRecord{abcd u0 test.app/.Main t1}'
    if (command.startsWith('dumpsys activity processes test.app |')) {
      // ActivityManager's package filter excludes PID 99 (a separate app with
      // a similar process name), but can include the same app in another user.
      return [
        '    *APP* UID 10000 ProcessRecord{135 9:test.app/u0a0}',
        '        - ActivityRecord{abcd u0 test.app/.Main t1} flags=host',
        '    *APP* UID 10000 ProcessRecord{baa 20:custom.web.worker/u0a0}',
        '    *PERS* UID 10000 ProcessRecord{ffd 10:custom.main/u0a0}',
        '        - ActivityRecord{abcd u0 test.app/.Main t1}',
        '    *APP* UID 1010000 ProcessRecord{dbc 100:test.app/u10a0}',
      ].join('\n')
    }
    assert.equal(command, 'cat /proc/net/unix')
    return [
      'Num RefCount Protocol Flags Type St Inode Path',
      '00: 02 00 00010000 0001 01 3 @webview_devtools_remote_99',
      '00: 02 00 00010000 0001 01 4 @webview_devtools_remote_100',
      listening && '00: 02 00 00010000 0001 01 5 @webview_devtools_remote_20',
    ].filter(Boolean).join('\n')
  }, adb)
  mocks['./android'].acquireAndroidAdb = async () => ({ adb, release: async () => { released++ } })
  mocks.electron = { BrowserWindow: class extends EventEmitter {
    constructor() {
      super()
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = () => {}
      windows.push(this)
    }
    isDestroyed() { return this.closed }
    destroy() { this.closed = true; this.emit('closed') }
    loadURL(url) { this.url = url }
  } }
  const api = load(base + 'androidWebviews.ts', mocks)
  assert.deepEqual(await api.androidGetWebviews('a', 10), [])
  assert.deepEqual(touched, [])
  listening = true
  // A successful HTTP body can arrive before the underlying ADB close has
  // completed. Don't let the next poll/inspection start from a partial teardown.
  let acknowledge, started
  const closeStarted = new Promise(resolve => { started = resolve })
  closeGate = { started, acknowledged: new Promise(resolve => { acknowledge = resolve }) }
  let listed = false
  const listing = api.androidGetWebviews('a', 10).then(result => { listed = true; return result })
  await closeStarted
  await new Promise(resolve => setImmediate(resolve))
  const returnedBeforeClose = listed
  acknowledge()
  const pages = await listing
  assert.equal(returnedBeforeClose, false, 'listing must await the owned ADB socket close')
  closeGate = undefined
  assert.deepEqual(pages.map(page => page.id), ['20:p1'])
  await assert.rejects(api.androidInspectWebview('a', 10, '20:missing'), /unavailable/)
  assert.equal(released, 1)
  await api.androidInspectWebview('a', 10, pages[0].id)
  const win = windows[0]
  t.after(() => { if (!win.isDestroyed()) win.destroy() })
  const endpoint = new URL('http://' + new URL(win.url).searchParams.get('ws'))
  assert.equal(endpoint.hostname, '127.0.0.1')
  const denied = await new Promise(resolve => http.get(endpoint, res => { resolve(res.statusCode); res.resume() }))
  assert.equal(denied, 404)
  let acknowledgeUpgrade, upgradeCloseStarted
  const waitingForUpgradeClose = new Promise(resolve => { upgradeCloseStarted = resolve })
  closeGate = {
    started: upgradeCloseStarted,
    acknowledged: new Promise(resolve => { acknowledgeUpgrade = resolve }),
  }
  const req = http.get(endpoint, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
  const [, socket] = await once(req, 'upgrade')
  t.after(() => socket.destroy())
  socket.write('test')
  const [data] = await once(socket, 'data')
  assert.equal(data.toString(), 'test')
  assert.deepEqual(upgrades, ['/devtools/page/p1'])
  assert.ok(touched.every(name => name === 'localabstract:webview_devtools_remote_20'))
  const closed = once(socket, 'close')
  win.destroy()
  await waitingForUpgradeClose
  await closed
  assert.equal(released, 1, 'hold inspector lease until the relay socket confirms CLSE')
  acknowledgeUpgrade()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(released, 2)
  await assert.rejects(new Promise((resolve, reject) => http.get(endpoint, resolve).once('error', reject)), /ECONNREFUSED/)
})
