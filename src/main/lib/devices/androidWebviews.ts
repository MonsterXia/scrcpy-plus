import type { Adb, AdbSocket } from '@yume-chan/adb'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { Duplex } from 'node:stream'
import { acquireAndroidAdb, withAndroidAdb } from './android'
import { foregroundProcesses } from './androidInspection'
import { readAndroidShellOutput } from './androidShell'

interface Page {
  id: string
  title: string
  url: string
  type: string
  pid: number
  path: string
}

async function webviewSocket(adb: Adb, pid: number, signal: AbortSignal) {
  signal.throwIfAborted()
  let cancel: () => void = () => {}
  try {
    const socket = await Promise.race([
      adb.createSocket(`localabstract:webview_devtools_remote_${pid}`).then(async opened => {
        if (signal.aborted) {
          await opened.close()
          throw signal.reason
        }
        return opened
      }),
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason)
        signal.addEventListener('abort', cancel, { once: true })
      }),
    ])
    // Tango uses the runtime's native Web Streams. Its declarations omit
    // Node's asyncDispose iterator method; the writer accepts raw Uint8Arrays.
    const streams = socket as unknown as Parameters<typeof Duplex.fromWeb>[0]
    const stream = Duplex.fromWeb(streams)
    let closing: Promise<void> | undefined
    const close = () => {
      if (!closing) {
        stream.destroy()
        closing = closeAdbSocket(socket)
      }
      return closing
    }
    stream.once('close', () => { void close().catch(() => {}) })
    return { stream, close }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

async function closeAdbSocket(socket: AdbSocket) {
  // close() sends CLSE. closed resolves when the daemon acknowledges it.
  // A missing confirmation must not indefinitely retain an inspector lease.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve(socket.close()).then(() => socket.closed),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Android WebView socket close timed out')), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function readPages(adb: Adb, pid: number): Promise<Page[]> {
  const signal = AbortSignal.timeout(5000)
  const connection = await webviewSocket(adb, pid, signal)
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get({
        path: '/json/list', headers: { Host: 'localhost', Connection: 'close' },
        createConnection: () => connection.stream, signal,
      }, resolve).once('error', reject)
    })
    if (response.statusCode !== 200) throw new Error('Unable to list Android WebViews')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of response) {
      length += chunk.length
      if (length > 2 * 1024 * 1024) throw new Error('Android WebView list is too large')
      chunks.push(chunk)
    }
    const list: unknown = JSON.parse(Buffer.concat(chunks).toString())
    if (!Array.isArray(list)) throw new Error('Invalid Android WebView list')
    return list.flatMap(item => {
      if (item?.type !== 'page' || typeof item.id !== 'string' ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(item.id) || typeof item.webSocketDebuggerUrl !== 'string') return []
      let advertised: URL
      try { advertised = new URL(item.webSocketDebuggerUrl) } catch { return [] }
      const path = `/devtools/page/${item.id}`
      if (advertised.protocol !== 'ws:' || advertised.pathname !== path || advertised.search || advertised.hash) return []
      return [{
        // IDs are local to the WebView process.
        id: `${pid}:${item.id}`, pid, path, type: 'page',
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.url === 'string' ? item.url : '',
      }]
    })
  } finally {
    await connection.close()
  }
}

async function discoverPages(adb: Adb, foregroundPid: number) {
  if (!Number.isSafeInteger(foregroundPid) || foregroundPid <= 0) return []
  const { pids } = await foregroundProcesses(adb)
  if (pids[0] !== foregroundPid) return []
  const sockets = (await readAndroidShellOutput(adb, 'cat /proc/net/unix', 4 * 1024 * 1024, 8000)).toString()
  if (!/^Num\s+RefCount\s+Protocol\s+Flags\s+Type\s+St\s+Inode/m.test(sockets)) {
    throw new Error('Android did not return a Unix socket list')
  }
  const listening = new Set<number>()
  for (const line of sockets.split('\n')) {
    const match = line.trim().match(/^[\da-f]+:\s+[\da-f]+\s+0+\s+0*10000\s+0*1\s+0*1\s+\d+\s+@webview_devtools_remote_(\d+)$/i)
    if (match) listening.add(Number(match[1]))
  }
  const pages = await Promise.allSettled(pids.filter(pid => listening.has(pid)).map(pid => readPages(adb, pid)))
  const results = pages.flatMap(result => result.status === 'fulfilled' ? result.value : [])
  if (pages.length && pages.every(result => result.status === 'rejected')) throw pages[0].reason
  return results
}

export function androidGetWebviews(key: string, pid: number) {
  return withAndroidAdb(key, async adb =>
    (await discoverPages(adb, pid)).map(({ id, type, title, url }) => ({ id, type, title, url })))
}

// A shared ADB connection can outlive many inspector windows. Attach one
// promise callback per transport and remove each window from its observer set.
const disconnectObservers = new WeakMap<Adb, Set<() => void>>()

function onDisconnect(adb: Adb, callback: () => void) {
  let observers = disconnectObservers.get(adb)
  if (!observers) {
    observers = new Set()
    disconnectObservers.set(adb, observers)
    const notify = () => {
      disconnectObservers.delete(adb)
      for (const observer of observers!) observer()
      observers!.clear()
    }
    void adb.disconnected.then(notify, notify)
  }
  observers.add(callback)
  return () => observers.delete(callback)
}

export async function androidInspectWebview(key: string, pid: number, id: string) {
  const { adb, release } = await acquireAndroidAdb(key)
  const server = http.createServer((_, response) => { response.writeHead(404).end() })
  const connections = new Set<Duplex>()
  const remotes = new Set<Awaited<ReturnType<typeof webviewSocket>>>()
  const controller = new AbortController()
  let win: BrowserWindow | undefined
  let closing: Promise<void> | undefined
  let unsubscribe: (() => void) | undefined
  function close() {
    if (!closing) closing = Promise.resolve().then(async () => {
      unsubscribe?.()
      controller.abort()
      server.close()
      for (const connection of connections) connection.destroy()
      if (win && !win.isDestroyed()) win.destroy()
      try {
        await Promise.all([...remotes].map(remote => remote.close()))
      } finally {
        await release()
      }
    })
    return closing
  }
  const end = () => { void close().catch(() => {}) }
  try {
    const pages = await discoverPages(adb, pid)
    const selected = pages.find(page => page.id === id)
    if (!selected) throw new Error('The selected Android WebView is unavailable')
    const ticket = '/' + randomUUID()
    server.on('connection', client => {
      connections.add(client)
      client.on('error', () => client.destroy())
      client.once('close', () => connections.delete(client))
    })
    server.on('upgrade', async (request, client, head) => {
      if (request.method !== 'GET' || request.url !== ticket || request.headers.upgrade?.toLowerCase() !== 'websocket' ||
          (request.headers.origin && request.headers.origin !== 'devtools://devtools')) {
        client.destroy()
        return
      }
      let remote: Awaited<ReturnType<typeof webviewSocket>> | undefined
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        remote = await webviewSocket(adb, selected.pid, signal)
        if (client.destroyed || controller.signal.aborted) { await remote.close(); return }
        remotes.add(remote)
        const owned = remote
        const socket = owned.stream
        client.once('close', () => { void owned.close().catch(() => {}) })
        socket.once('close', () => {
          client.destroy()
          const remove = () => remotes.delete(owned)
          void owned.close().then(remove, remove)
        })
        socket.on('error', () => client.destroy())
        // Forward only the selected page and the normal WebSocket handshake.
        const headers = ['Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket']
        for (const header of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'origin']) {
          if (request.headers[header]) headers.push(`${header}: ${request.headers[header]}`)
        }
        socket.write(`GET ${selected.path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
        if (head.length) socket.write(head)
        socket.pipe(client).pipe(socket)
      } catch {
        client.destroy()
        await remote?.close().catch(() => {})
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    server.on('error', end)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Android WebView relay did not start')
    win = new BrowserWindow({
      width: 1000, height: 760, autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    win.once('closed', end)
    win.webContents.once('render-process-gone', end)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    unsubscribe = onDisconnect(adb, end)
    await win.loadURL(`devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${address.port}${ticket}`)
  } catch (error) {
    await close()
    throw error
  }
}
