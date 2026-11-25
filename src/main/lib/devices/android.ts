import { Adb, AdbDaemonTransport } from '@yume-chan/adb'
import type { AdbCredentialStore, AdbPrivateKey, AdbSocket } from '@yume-chan/adb'
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb'
import type { AdbDaemonWebUsbDevice } from '@yume-chan/adb-daemon-webusb'
import type { AndroidKeyCode } from '@yume-chan/scrcpy'
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy'
import { ReadableStream, WritableStream } from '@yume-chan/stream-extra'
import { createRequire } from 'node:module'
import { generateKeyPairSync, randomInt, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { open, readFile, writeFile, mkdir, link, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { ITarget, NativeMirrorInput } from 'common/types'
import { getUserDataPath, resolveResources } from 'share/main/lib/util'
import type { NativeFrame } from './media'
import { readAndroidOverview } from './androidOverview'
import { closeAndroidChannel, readAndroidShellOutput, waitForAndroidOperation } from './androidShell'
import { connectLocalAdb, discoverLocalAdb } from './androidServer'

export class FileAdbCredentials implements AdbCredentialStore {
  constructor(private file: string) {}
  async *iterateKeys(): AsyncGenerator<AdbPrivateKey> {
    try { yield { buffer: await readFile(this.file), name: 'Scrcpy Plus' } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async generateKey(): Promise<AdbPrivateKey> {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048, publicExponent: 65537,
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    })
    await mkdir(path.dirname(this.file), { recursive: true })
    // Publish only a complete key. An exclusive final-path write exposes an
    // empty/partial file to a second device authorizing at the same time.
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, privateKey, { mode: 0o600, flag: 'wx' })
      try { await link(temporary, this.file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    } finally { await unlink(temporary).catch(() => {}) }
    return { buffer: await readFile(this.file), name: 'Scrcpy Plus' }
  }
}
let manager: AdbDaemonWebUsbDeviceManager | undefined
const configuredUsb = new WeakSet<USBDevice>()
function usbDisconnected(error: unknown) {
  return error instanceof Error && /device disconnected|\bdisconnected\b|no such device|device.*not found|LIBUSB.*NO_DEVICE/i.test(error.message)
}
export function configureAndroidUsb(raw: USBDevice) {
  if (configuredUsb.has(raw)) return
  configuredUsb.add(raw)
  // Poll bulk reads through RSA/idle periods. A finite native deadline lets
  // shutdown drain I/O even if the disconnected endpoint cannot clear its halt.
  const transferIn = raw.transferIn.bind(raw) as (endpoint: number, length: number, timeout: number) => Promise<USBInTransferResult>
  const transferOut = raw.transferOut.bind(raw)
  const close = raw.close.bind(raw), open = raw.open.bind(raw)
  const claim = raw.claimInterface.bind(raw), release = raw.releaseInterface.bind(raw)
  const claimed = new Set<number>()
  const pending = new Set<Promise<unknown>>()
  const endpointDevice = raw as USBDevice & { getEndpoint?: (address: number) => { timeout: number } }
  function prepareEndpoint(number: number, input: boolean) {
    // libusb WebUSB uses endpoint timeouts rather than a third transfer arg.
    if (endpointDevice.getEndpoint) endpointDevice.getEndpoint(number | (input ? 0x80 : 0)).timeout = 1000
  }
  let closed = false, closing: Promise<void> | undefined
  async function track<T>(operation: () => Promise<T>) {
    if (closed) throw new Error('Android USB connection closed')
    const promise = operation(); pending.add(promise)
    try { return await promise } finally { pending.delete(promise) }
  }
  raw.transferIn = async (endpoint, length) => {
    while (!closed) {
      try { return await track(() => { prepareEndpoint(endpoint, true); return transferIn(endpoint, length, 1000) }) }
      catch (error) {
        if (closed || !(error instanceof Error) || !/Cancelled|timed?[\s_]*out/i.test(error.message)) throw error
      }
    }
    throw new Error('Android USB connection closed')
  }
  raw.transferOut = (endpoint, data) => track(() => { prepareEndpoint(endpoint, false); return transferOut(endpoint, data) })
  raw.claimInterface = async number => { await claim(number); claimed.add(number) }
  raw.releaseInterface = async number => { await release(number); claimed.delete(number) }
  raw.open = async () => { await closing; await open(); closed = false; closing = undefined }
  raw.close = () => {
    if (closing) return closing
    closed = true
    closing = (async () => {
      await Promise.allSettled([...pending])
      let failure: unknown
      // Reading configuration here invokes native string-descriptor getters.
      // A detached device cannot answer them, so release only interfaces that
      // this connection successfully claimed, and always close the handle.
      for (const number of claimed) {
        try { await release(number); claimed.delete(number) }
        catch (error) {
          if (usbDisconnected(error)) claimed.delete(number)
          else failure ||= error
        }
      }
      try { await close() } catch (error) { if (!usbDisconnected(error)) failure ||= error }
      if (failure) throw failure
    })().catch(error => { closing = undefined; throw error })
    return closing
  }
}
async function deviceManager() {
  // Discover through USB without starting an adb server or executable.
  if (!manager) {
    const { WebUSB } = createRequire(__filename)('usb')
    manager ||= new AdbDaemonWebUsbDeviceManager(new WebUSB({ allowAllDevices: true, deviceTimeout: 5000 }))
  }
  return manager
}
let enumeration: Promise<AdbDaemonWebUsbDevice[]> | undefined
function usbIdentity(device: AdbDaemonWebUsbDevice) {
  const raw = device.raw as { serialNumber?: string | null; bus?: string; address?: number; ports?: number[];
    device?: { busNumber: number; deviceAddress: number; portNumbers?: number[] } }
  const bus = raw.bus || raw.device?.busNumber?.toString()
  const ports = raw.ports || raw.device?.portNumbers
  const address = raw.address ?? raw.device?.deviceAddress
  if (!raw.serialNumber && bus && (ports?.length || address !== undefined)) {
    return `usb:${device.serial}:${bus}:${ports?.join('.') || address}`
  }
  return device.serial
}
async function usbDevices() {
  if (!enumeration) enumeration = deviceManager().then(manager => manager.getDevices()).finally(() => { enumeration = undefined })
  // Enumeration owns no claimed interface. Retain a late native request instead
  // of starting another one after the display deadline.
  return deadline(enumeration, () => {}, 5000)
}
export async function discoverAndroid(): Promise<ITarget[]> {
  const [usb, local] = await Promise.allSettled([usbDevices(), discoverLocalAdb()])
  const shared = local.status === 'fulfilled' ? local.value : []
  if (usb.status === 'rejected' && !shared.length) throw usb.reason
  const targets: ITarget[] = shared.map(device => ({
    key: `android:${device.serial}`, connectionId: device.serial,
    name: device.model || device.serial, model: device.model,
    platform: 'android', transport: 'usb',
    state: device.state === 'device' ? 'ready' : device.state as 'unauthorized' | 'offline',
    ohosVersion: '', sdkVersion: '',
  }))
  for (const device of usb.status === 'fulfilled' ? usb.value : []) {
    if (shared.some(item => item.serial === device.serial)) continue
    targets.push({
      key: `android:${usbIdentity(device)}`, connectionId: usbIdentity(device), name: device.name || device.serial,
      brand: device.raw.manufacturerName || undefined,
      platform: 'android', transport: 'usb', state: 'ready', ohosVersion: '', sdkVersion: '',
    })
  }
  return targets
}

async function deadline<T>(promise: Promise<T>, cancel: () => void, milliseconds = 30000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancel(); reject(new Error('Android connection timed out')) }, milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
const connections = new Map<string, AndroidConnection>()
const overviewReads = new Map<string, Promise<Awaited<ReturnType<typeof readAndroidOverview>>>>()

export async function acquireAndroidAdb(key: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (typeof key !== 'string' || !key.startsWith('android:') || key.length <= 8) throw Error('Invalid Android device')
  let connection = connections.get(key)
  while (connection?.closed) {
    const timeout = AbortSignal.timeout(30000)
    const wait = signal ? AbortSignal.any([signal, timeout]) : timeout
    const retiring = connection
    await waitForAndroidOperation(wait, () => retiring.retire())
    signal?.throwIfAborted()
    connection = connections.get(key)
  }
  if (!connection) {
    connection = new AndroidConnection(key)
    connections.set(key, connection)
  }
  const owner = connection
  owner.users++
  let released = false
  const release = async () => {
    if (!released) { released = true; owner.users-- }
    if (!owner.users) await owner.close()
  }
  try {
    const adb = signal ? await waitForAndroidOperation(signal, () => owner.connect()) : await owner.connect()
    return { adb, release, installApk: (filePath: string, beforeInstall?: () => void, signal?: AbortSignal) => owner.installApk(filePath, beforeInstall, signal) }
  } catch (error) {
    await release()
    throw error
  }
}

export async function withAndroidAdb<T>(key: string, operation: (adb: Adb) => Promise<T>, signal?: AbortSignal) {
  const lease = await acquireAndroidAdb(key, signal)
  try { signal?.throwIfAborted(); return await operation(lease.adb) }
  finally { await lease.release() }
}

export async function installAndroidApk(key: string, filePath: string, beforeInstall?: () => void, signal?: AbortSignal) {
  const lease = await acquireAndroidAdb(key, signal)
  try { await lease.installApk(filePath, beforeInstall, signal) }
  finally { await lease.release() }
}

export function getAndroidOverview(target: ITarget) {
  const pending = overviewReads.get(target.key)
  if (pending) return pending
  const request = withAndroidAdb(target.key, readAndroidOverview).finally(() => overviewReads.delete(target.key))
  overviewReads.set(target.key, request)
  return request
}

const MAX_INSTALL_DURATION_MS = 600000
const APK_CLEANUP_TIMEOUT_MS = 5000

async function pushApk(adb: Adb, file: FileHandle, remote: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const channel = adb.sync()
  const source = file.createReadStream()
  try {
    await waitForAndroidOperation(signal, async () => {
      const sync = await channel
      signal.throwIfAborted()
      // A local read error can precede ADB's DONE packet.
      await Promise.race([
        new Promise<never>((_, reject) => source.once('error', reject)),
        sync.write({ filename: remote, permission: 0o644, file: ReadableStream.from<Uint8Array>(source) }),
      ])
    })
  } finally {
    source.destroy()
    // A late channel open still gets its own dispose, even after the cleanup budget.
    const cleanup = channel.then(sync => sync.dispose(), () => {})
    await closeAndroidChannel(() => cleanup)
  }
}

class AndroidConnection {
  private device?: AdbDaemonWebUsbDevice
  private adb?: Adb
  private connecting?: Promise<Adb>
  private handshake?: Promise<unknown>
  private drained?: Promise<void>
  private closing?: Promise<void>
  private installTail = Promise.resolve()
  users = 0
  closed = false
  constructor(private key: string) {}
  private check() { if (this.closed) throw new Error('Android connection closed') }
  connect(): Promise<Adb> {
    this.check()
    if (this.adb) return Promise.resolve(this.adb)
    if (!this.connecting) this.connecting = (async () => {
      this.check()
      // Use a stable serial identity regardless of who owns the USB transport.
      // Probe the existing server before opening or claiming any native handle.
      const serial = this.key.slice(8)
      if (/^[a-zA-Z0-9_.-]{1,128}$/.test(serial)) {
        try { this.adb = await connectLocalAdb(serial) }
        catch { this.check() }
        if (this.adb) {
          if (this.closed) { await this.adb.close(); this.check() }
          return this.adb
        }
      }
      const devices = await usbDevices()
      this.check()
      this.device = devices.find(device => usbIdentity(device) === this.key.slice(8))
      if (!this.device) throw new Error('Android device disconnected')
      configureAndroidUsb(this.device.raw)
      this.check()
      const opening = this.device.connect().then(async connection => {
        if (this.closed) { await this.device?.raw.close(); this.check() }
        return connection
      })
      this.handshake = opening
      const connection = await deadline(opening, () => {})
      this.check()
      const authenticating = AdbDaemonTransport.authenticate({
        serial: this.device.serial, connection,
        credentialStore: new FileAdbCredentials(getUserDataPath('data/android-adbkey.pk8')),
      }).then(async transport => {
        if (this.closed) { await transport.close(); this.check() }
        return transport
      })
      this.handshake = authenticating
      const transport = await deadline(authenticating, () => {})
      this.adb = new Adb(transport); this.check()
      return this.adb

    })().then(adb => {
      const disconnected = () => { void this.close().catch(error => console.warn('Android disconnect cleanup failed', error)) }
      adb.disconnected?.then(disconnected, disconnected)
      return adb
    })
    return this.connecting
  }
  installApk(filePath: string, beforeInstall?: () => void, ownerSignal?: AbortSignal) {
    const adb = this.adb
    if (this.closed || !adb) return Promise.reject(new Error('Android session unavailable'))
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.apk') {
      return Promise.reject(new Error('Expected a local APK file'))
    }
    const budget = AbortSignal.timeout(MAX_INSTALL_DURATION_MS)
    const signal = ownerSignal ? AbortSignal.any([budget, ownerSignal]) : budget
    const previous = this.installTail
    const install = previous.then(async () => {
      signal.throwIfAborted()
      this.check()
      const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        if (!(await file.stat()).isFile()) throw new Error('Expected a regular APK file')
        const remote = `/data/local/tmp/scrcpy-plus-${randomUUID()}.apk`
        try {
          await pushApk(adb, file, remote, signal)
          signal.throwIfAborted()
          this.check()
          beforeInstall?.()
          const result = (await readAndroidShellOutput(adb,
            `pm install --user current -r ${remote}`, 64 * 1024, MAX_INSTALL_DURATION_MS, signal)).toString('utf8')
          if (result.trim().split(/\r?\n/).pop()?.trim() !== 'Success') {
            throw new Error(result.trim() || 'Android package manager returned no result')
          }
        } finally {
          // Cleanup has its own budget even if the installation was cancelled.
          await readAndroidShellOutput(adb, `rm -f ${remote}`, 4096, APK_CLEANUP_TIMEOUT_MS)
            .catch(error => console.warn('Could not remove temporary APK', error))
        }
      } finally { await file.close() }
    })
    this.installTail = install.catch(() => {})
    // Release queued callers promptly, but keep FIFO ordering for their successors.
    return waitForAndroidOperation(signal, () => previous).then(() => install)
  }
  async retire() {
    await this.close()
    await this.drained
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = Promise.resolve().then(async () => {
      try { await this.adb?.close() }
      finally { await this.device?.raw.close() }
      // A new owner may claim the same native USB handle after this entry is
      // removed. Drain the interrupted handshake before allowing that claim.
      this.drained = Promise.allSettled([this.connecting, this.handshake]).then(() => {
        if (connections.get(this.key) === this) connections.delete(this.key)
      })
    }).catch(error => { this.closing = undefined; throw error })
    return this.closing
  }
}

type AndroidLease = Awaited<ReturnType<typeof acquireAndroidAdb>>

// Tango creates sync, exec and forward sockets through this Adb instance.
// Keep its ownership independent of workspace shells and the physical transport.
class AndroidMirrorAdb extends Adb {
  private sockets = new Set<AdbSocket>()
  get hasOpenSockets() { return this.sockets.size > 0 }
  constructor(shared: Adb, private signal: AbortSignal) { super(shared.transport) }
  override async createSocket(service: string) {
    this.signal.throwIfAborted()
    const socket = await super.createSocket(service)
    if (this.signal.aborted) {
      await socket.close()
      throw this.signal.reason
    }
    this.sockets.add(socket)
    const remove = () => this.sockets.delete(socket)
    void socket.closed.then(remove, remove)
    return socket
  }
  override async close() {
    await Promise.all(Array.from(this.sockets, async socket => {
      await socket.close()
      await socket.closed
    }))
  }
}

export class AndroidMirror {
  private lease?: AndroidLease
  private acquiring?: Promise<AndroidLease>
  private installs = new Set<Promise<void>>()
  private lifetime = new AbortController()
  private mirrorAdb?: AndroidMirrorAdb
  private pendingServerPath?: string
  private client?: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>>
  private closed = false
  private closing?: Promise<void>
  private width = 0
  private height = 0
  private inputTail = Promise.resolve()
  private pendingInput = 0
  private touchGeneration = 0
  private releaseQueuedFor: number | undefined
  constructor(private target: ITarget) {}
  private check() { if (this.closed) throw new Error('Android session closed') }
  private startupStep<T>(work: () => Promise<T>) {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30000)])
    return waitForAndroidOperation(signal, work)
  }
  async start(frame: (frame: NativeFrame) => void, state: (state: string) => void) {
    try {
      this.check(); state('authorizing')
      this.acquiring = acquireAndroidAdb(this.target.key, this.lifetime.signal)
      this.lease = await this.acquiring
      this.check(); state('starting')
      const server = await this.startupStep(() => readFile(resolveResources('android/scrcpy-server')))
      this.check()
      const adb = this.mirrorAdb = new AndroidMirrorAdb(this.lease.adb, this.lifetime.signal)
      const scid = randomInt(0x80000000).toString(16)
      const serverPath = this.pendingServerPath = `/data/local/tmp/scrcpy-plus-server-${scid}.jar`
      await this.startupStep(() => AdbScrcpyClient.pushServer(adb, new ReadableStream({
        start(controller) { controller.enqueue(server); controller.close() },
      }), serverPath))
      this.check()
      this.client = await this.startupStep(() => AdbScrcpyClient.start(adb, serverPath,
        new AdbScrcpyOptions3_3_3({ scid, video: true, audio: false, control: true,
          videoCodec: 'h264', maxSize: 1920, maxFps: 60, tunnelForward: true })).then(async client => {
        // The metadata read starts in Tango's constructor, including for a
        // late client returned while its sockets are being closed.
        void client.videoStream.catch(() => {})
        if (this.closed) { await client.close(); this.check() }
        return client
      }))
      this.check()
      const client = this.client
      void client.output.pipeTo(new WritableStream({ write() {} })).catch(() => {})
      if (client.clipboard) void client.clipboard.pipeTo(new WritableStream({ write() {} })).catch(() => {})
      const video = await this.startupStep(() => client.videoStream); this.check()
      this.pendingServerPath = undefined // The running scrcpy server unlinks its JAR.
      state('connected')
      void (async () => {
        try {
          for await (const packet of video.stream) {
            if (this.closed) break
            this.width = video.width || video.metadata.width || 0
            this.height = video.height || video.metadata.height || 0
            frame({ data: packet.data, timestamp: packet.type === 'data' ? Number(packet.pts ?? 0n) : 0,
              config: packet.type === 'configuration', keyFrame: packet.type === 'data' && packet.keyframe === true })
          }
          if (!this.closed) state('disconnected')
        } catch { if (!this.closed) state('error') }
      })()
    } catch (error) { await this.close(); throw error }
  }
  installApk(filePath: string) {
    if (this.closed || !this.lease) return Promise.reject(new Error('Android session unavailable'))
    const install = this.lease.installApk(filePath, () => this.check(), this.lifetime.signal)
    this.installs.add(install)
    return install.finally(() => this.installs.delete(install))
  }
  input(message: NativeMirrorInput, expectedGeometry?: { width: number; height: number }) {
    if (this.closed || !this.client?.controller) return Promise.reject(new Error('Android control unavailable'))
    if (this.pendingInput >= 64 && message.type === 'touch' && message.action === 'move') return Promise.resolve()
    const release = message.type === 'touch' && message.action === 'up'
    if (release && this.releaseQueuedFor === this.touchGeneration) return Promise.resolve()
    if (this.pendingInput >= 128 && !release) return Promise.reject(new Error('Android input queue full'))
    if (message.type === 'touch' && message.action === 'down') this.touchGeneration++
    const generation = this.touchGeneration
    if (release) this.releaseQueuedFor = generation
    this.pendingInput++
    const task = this.inputTail.catch(() => {}).then(async () => {
      this.check()
      const controller = this.client!.controller!
      if (message.type === 'text') {
        await controller.setClipboard({ sequence: 0n, paste: true, content: message.text })
      } else if (message.type === 'key') {
        try { await controller.injectKeyCode({ action: 0, keyCode: message.keyCode as AndroidKeyCode, repeat: 0, metaState: 0 }) }
        finally { await controller.injectKeyCode({ action: 1, keyCode: message.keyCode as AndroidKeyCode, repeat: 0, metaState: 0 }) }
      } else {
        if (!this.width || !this.height) throw new Error('Android screen size unavailable')
        // Check at dispatch, after the backend queue: a new SPS can arrive
        // before its keyframe is presented by the renderer. Always allow up.
        if (!release && expectedGeometry && (this.width !== expectedGeometry.width || this.height !== expectedGeometry.height)) throw new Error('Android display geometry changed; capture a new frame')
        const point = { pointerX: Math.min(this.width - 1, Math.round(message.x * this.width)),
          pointerY: Math.min(this.height - 1, Math.round(message.y * this.height)), videoWidth: this.width, videoHeight: this.height }
        if (message.type === 'touch') await controller.injectTouch({ ...point,
          action: message.action === 'down' ? 0 : message.action === 'up' ? 1 : 2,
          pointerId: -2n, pressure: message.action === 'up' ? 0 : 1, actionButton: 0, buttons: 0 })
        else await controller.injectScroll({ ...point, scrollX: message.dx, scrollY: message.dy, buttons: 0 })
      }
    }).finally(() => { this.pendingInput--; if (release && this.releaseQueuedFor === generation) this.releaseQueuedFor = undefined })
    this.inputTail = task
    return task
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      this.lifetime.abort(new Error('Android session closed'))
      // Close partial startup sockets even before Tango returns a server client.
      let closeError: unknown
      try {
        await deadline(Promise.all([this.client?.close(), this.mirrorAdb?.close()]), () => {}, 2000)
      } catch (error) { closeError = error }
      if (this.pendingServerPath && this.lease) {
        await readAndroidShellOutput(this.lease.adb, `rm -f ${this.pendingServerPath}`, 4096, 1500)
          .then(() => { this.pendingServerPath = undefined },
            error => console.warn('Could not remove Android mirror server', error))
      }
      // Dropped packages clean up their device-side staging files over this lease.
      await Promise.allSettled(this.installs)
      const lease = this.lease || await this.acquiring?.catch(() => undefined)
      await lease?.release()
      if (closeError && this.mirrorAdb?.hasOpenSockets) throw closeError
    })().catch(error => { this.closing = undefined; throw error })
    return this.closing
  }
}
