import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Adb, AdbNoneProtocolProcess } from '@yume-chan/adb'
import log from 'share/common/log'
import { sendTo } from 'share/main/lib/window'
import { acquireAndroidAdb } from './android'

type ShellProcess = Awaited<ReturnType<Adb['subprocess']['noneProtocol']['pty']>>
type StreamProcess = Pick<AdbNoneProtocolProcess, 'kill' | 'output'> & {
  exited: Promise<unknown>
  input?: ShellProcess['input']
  resize?(rows: number, cols: number): Promise<void>
}

// logcat -B writes logger_entry frames. Using the header length also handles
// older devices, whose 20-byte headers store zero in the hdr_size field.
class LogcatDecoder {
  private pending: Buffer

  constructor() {
    this.pending = Buffer.alloc(0)
  }

  *read(chunk: Uint8Array) {
    const bytes = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let offset = 0
    while (bytes.length - offset >= 4) {
      const header = bytes.readUInt16LE(offset + 2) || 20
      const size = bytes.readUInt16LE(offset)
      const end = offset + header + size
      if (header < 20 || size < 3 || header + size > 5 * 1024)
        throw new Error('Invalid Android logcat record')
      if (end > bytes.length) break
      const payload = bytes.subarray(offset + header, end)
      const tagEnd = payload.indexOf(0, 1)
      if (tagEnd !== -1) {
        const pid = bytes.readInt32LE(offset + 4)
        yield {
          date: new Date(
            bytes.readUInt32LE(offset + 12) * 1000 +
              bytes.readUInt32LE(offset + 16) / 1e6,
          ),
          pid,
          tid: bytes.readUInt32LE(offset + 8),
          level: payload[0],
          tag: payload.toString('utf8', 1, tagEnd),
          message: payload.toString(
            'utf8',
            tagEnd + 1,
            payload.at(-1) === 0 ? payload.length - 1 : payload.length,
          ),
          bundleName: String(pid),
        }
      }
      offset = end
    }
    this.pending = Buffer.from(bytes.subarray(offset))
  }
}

const logger = log('android-streams')
const sessions = new Map<string, AndroidStream>()
const pending = new Map<AbortController, Promise<string>>()

class AndroidStream {
  readonly id: string
  paused = false
  private reading = false
  private closing?: Promise<void>
  private reader: ReturnType<StreamProcess['output']['getReader']>
  private writer?: ReturnType<ShellProcess['input']['getWriter']>

  constructor(
    private kind: 'shell' | 'logcat',
    private process: StreamProcess,
    private release: () => Promise<void>,
  ) {
    this.id = 'android:' + kind + ':' + randomUUID()
    this.reader = process.output.getReader()
    this.writer = process.input?.getWriter()
    // The PTY exit promise can reject on disconnect. Its output exposes the
    // same failure after any remaining data has been consumed.
    void process.exited.catch(() => {})
  }

  start() {
    if (this.reading) return
    this.reading = true
    void this.read()
      .finally(async () => {
        if (!sessions.has(this.id)) return
        try {
          const event = this.kind === 'shell' ? 'shellEnded' : 'hilogEnded'
          sendTo('main', event, this.id)
        } finally {
          await this.close()
        }
      })
      .catch(error => logger.warn('Android device stream ended', error))
  }

  private async read() {
    const text = new StringDecoder('utf8')
    const logcat = new LogcatDecoder()
    while (sessions.has(this.id)) {
      const { done, value } = await this.reader.read()
      if (!sessions.has(this.id)) return
      if (this.kind === 'shell') {
        const data = done ? text.end() : text.write(value)
        if (data) sendTo('main', 'shellData', this.id, data)
      } else if (!done) {
        for (const entry of logcat.read(value)) {
          if (!this.paused) sendTo('main', 'hilogEntry', this.id, entry)
        }
      }
      if (done) return
    }
  }

  async write(data: string | Uint8Array) {
    if (!this.writer) throw new Error('Android shell unavailable')
    this.start()
    if (data.length) {
      await this.writer.write(typeof data === 'string' ? Buffer.from(data) : data)
    }
  }

  async resize(rows: number, cols: number) {
    if (this.kind !== 'shell') throw new Error('Android shell unavailable')
    // Legacy ADB PTYs have no window-size command.
    await this.process.resize?.(rows, cols)
  }

  close() {
    if (this.closing) return this.closing
    sessions.delete(this.id)
    this.closing = (async () => {
      try {
        await Promise.allSettled([
          this.reader.cancel(),
          Promise.resolve().then(() => this.process.kill()),
        ])
      } finally {
        this.reader.releaseLock()
        this.writer?.releaseLock()
        await this.release()
      }
    })()
    return this.closing
  }
}

async function openStream(key: string, kind: 'shell' | 'logcat', signal: AbortSignal) {
  const { adb, release } = await acquireAndroidAdb(key, signal)
  let cancel: (() => void) | undefined
  try {
    signal.throwIfAborted()
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason)
      signal.addEventListener('abort', cancel, { once: true })
    })
    const subprocess = adb.subprocess
    const opening = kind === 'logcat'
      ? subprocess.noneProtocol.spawn(['logcat', '-B', '-T', '1', '-b', 'main', '-b', 'system', '-b', 'crash'])
      : subprocess.shellProtocol?.pty({ terminalType: 'xterm-256color' }) ?? subprocess.noneProtocol.pty()
    return await Promise.race([interrupted, opening.then(async child => {
      // A pending PTY socket open can finish after its renderer has gone.
      if (signal.aborted) {
        void child.exited.catch(() => {})
        await child.kill()
        throw signal.reason
      }
      signal.removeEventListener('abort', cancel!)
      const session = new AndroidStream(kind, child, release)
      sessions.set(session.id, session)
      return session.id
    })])
  } catch (error) {
    await release()
    throw error
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel)
  }
}

function open(key: string, kind: 'shell' | 'logcat') {
  const controller = new AbortController()
  const opening = openStream(key, kind, controller.signal).finally(() => pending.delete(controller))
  pending.set(controller, opening)
  return opening
}

export function androidCreateShell(key: string) {
  return open(key, 'shell')
}
export function androidOpenHilog(key: string) {
  return open(key, 'logcat')
}

export async function androidWriteShell(id: string, data: string | Uint8Array) {
  const shell = sessions.get(id)
  if (!shell) throw new Error('Android shell closed')
  await shell.write(data)
}

export async function androidKillShell(id: string) {
  await sessions.get(id)?.close()
}
export async function androidResizeShell(id: string, rows: number, cols: number) {
  if (![rows, cols].every(value => Number.isInteger(value) && value > 0 && value <= 65535))
    throw new Error('Invalid terminal size')
  const shell = sessions.get(id)
  if (!shell) throw new Error('Android shell closed')
  await shell.resize(rows, cols)
}
export const androidCloseHilog = androidKillShell

function setLogPaused(id: string, paused: boolean) {
  const session = sessions.get(id)
  if (!session) return
  session.paused = paused
  session.start()
}

export async function androidPauseHilog(id: string) {
  setLogPaused(id, true)
}
export async function androidResumeHilog(id: string) {
  setLogPaused(id, false)
}

export async function closeAndroidStreams() {
  const opening = [...pending.values()]
  for (const controller of pending.keys()) controller.abort(new Error('Renderer closed'))
  await Promise.allSettled(
    [...opening, ...Array.from(sessions.values(), session => session.close())],
  )
}
