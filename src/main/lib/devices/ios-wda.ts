import http from 'node:http'
import { waitForSetup } from '../ios-provisioning/manager'
import { connectIos } from './ios-usbmux'

const MAX_RESPONSE = 48 * 1024 * 1024
export interface WdaResponse { value: any; sessionId?: string | null }
export class WdaClient {
  private sessionCommands: Promise<unknown> = Promise.resolve()
  constructor(readonly udid: string) {}
  // One USB socket per request. Neither HTTP redirects nor failed writes are retried.
  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 10000): Promise<WdaResponse> {
    if (!/^\/[a-zA-Z0-9_/?=.-]*$/.test(path)) throw new Error('Invalid WDA route')
    if (!path.startsWith('/session/')) return this.exchange(method, path, body, signal, timeoutMs)
    // The Runner executes session commands serially. Start the transport timeout
    // when this command can run, so a slow hierarchy does not disconnect a mirror.
    const work = this.sessionCommands.then(() => {
      signal?.throwIfAborted()
      // Once XCTest starts snapshotting, closing its socket does not cancel the
      // device-side work. Let it drain while its caller can leave immediately.
      const hierarchy = method === 'GET' && path.endsWith('/source?format=json')
      return this.exchange(method, path, body, hierarchy ? undefined : signal, timeoutMs)
    })
    this.sessionCommands = work.catch(() => {})
    return waitForSetup(work, signal)
  }
  private async exchange(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<WdaResponse> {
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('WDA request cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(new Error('WDA request timed out')), timeoutMs)
    const agent = new http.Agent({ keepAlive: false })
    let socket: Awaited<ReturnType<typeof connectIos>> | undefined
    try {
      socket = await connectIos(this.udid, 8100, controller.signal)
      controller.signal.throwIfAborted()
      const connected = socket
      agent.createConnection = () => connected
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      if (bytes && bytes.length > 1024 * 1024) throw new Error('WDA request too large')
      return await new Promise<WdaResponse>((resolve, reject) => {
        const req = http.request({ hostname: 'localhost', port: 8100, agent, method, path, signal: controller.signal,
          headers: { connection: 'close', 'content-type': 'application/json', ...(bytes ? { 'content-length': bytes.length } : {}) } }, res => {
          let size = 0
          const chunks: Buffer[] = []
          const fail = (error: Error) => { res.destroy(); req.destroy(); reject(error) }
          if (res.statusCode !== 200) { fail(new Error(`WDA HTTP ${res.statusCode}`)); return }
          if (Number(res.headers['content-length']) > MAX_RESPONSE) { fail(new Error('WDA response too large')); return }
          res.on('error', reject)
          res.on('aborted', () => reject(new Error('WDA response interrupted')))
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE) { fail(new Error('WDA response too large')); return }
            chunks.push(chunk)
          })
          res.on('end', () => {
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'value')) throw new Error('Invalid WDA response')
              if (result.value?.error) throw new Error(`WDA: ${String(result.value.error).slice(0, 100)}`)
              resolve(result)
            } catch (error) { reject(error) }
          })
        })
        req.on('error', error => reject(controller.signal.aborted ? controller.signal.reason : error))
        req.end(bytes)
        connected.resume()
      })
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      socket?.destroy(); agent.destroy()
    }
  }
}

export function pngSize(data: Uint8Array) {
  const bytes = Buffer.from(data)
  if (bytes.length < 45 || bytes.length > 32 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid WDA PNG')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000) throw new Error('Invalid WDA screenshot dimensions')
  return { width, height }
}
