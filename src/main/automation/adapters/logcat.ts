import type { Adb } from '@yume-chan/adb'
import { AutomationFault, checkContext } from '../../../common/automation/protocol'
import type { AutomationContext } from '../../../common/automation/protocol'
import { closeAndroidChannel, waitForAndroidOperation } from '../../lib/devices/androidShell'
import { workspaceArtifact } from './workspaceArtifacts'

export async function captureLogcat(adb: Adb, durationMs: number, maxBytes: number, context: AutomationContext) {
  checkContext(context)
  const controller = new AbortController()
  const deadline = AbortSignal.timeout(Math.max(1, context.deadline - Date.now()))
  const signal = AbortSignal.any([context.signal, deadline, controller.signal])
  const child = await waitForAndroidOperation(signal, async () => {
    const process = await adb.subprocess.noneProtocol.spawn('logcat -v threadtime -T 1 -b main -b system -b crash')
    void process.exited.catch(() => {})
    if (signal.aborted) {
      await closeAndroidChannel(() => process.kill())
      throw signal.reason
    }
    return process
  })
  const reader = child.output.getReader()
  // ADB close can wait for the peer. Cancel a pending Web Streams read as
  // soon as this capture expires, even on a silent device.
  const cancelRead = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancelRead, { once: true })
  const chunks: Buffer[] = []
  const start = Date.now()
  const timer = setTimeout(() => controller.abort(), durationMs)
  let size = 0, truncated = false
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) {
        if (!signal.aborted) throw new AutomationFault('UNAVAILABLE', 'Android log reader ended early')
        break
      }
      const length = Math.min(value.length, maxBytes - size)
      chunks.push(Buffer.from(value.subarray(0, length)))
      size += length
      if (size === maxBytes) { truncated = true; break }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancelRead)
    reader.releaseLock()
    await closeAndroidChannel(() => child.kill())
  }
  checkContext(context)
  return workspaceArtifact('text/plain', Buffer.concat(chunks, size), { truncated, durationMs: Date.now() - start })
}
