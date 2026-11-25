import type { Adb } from '@yume-chan/adb'

export async function waitForAndroidOperation<T>(signal: AbortSignal, operation: () => Promise<T>) {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const cancel = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  try { return await Promise.race([operation(), cancelled.promise]) }
  finally { signal.removeEventListener('abort', cancel) }
}

export function closeAndroidChannel(close: () => void | PromiseLike<void>) {
  return waitForAndroidOperation(AbortSignal.timeout(5000), async () => { await close() })
}

// Only the short-lived shell is cancelled; the shared video transport stays alive.
export async function readAndroidShellOutput(
  adb: Adb, command: string, maxBytes = 256 * 1024, timeout = 7500, signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  const deadline = AbortSignal.timeout(Math.max(1, timeout))
  const scoped = signal ? AbortSignal.any([signal, deadline]) : deadline
  return waitForAndroidOperation(scoped, async () => {
    // Own this process through a late socket open. Tango's signal rejects
    // exited, but a read of a silent peer can still be pending.
    const child = await adb.subprocess.noneProtocol.spawn(command)
    void child.exited.catch(() => {})
    const reader = child.output.getReader()
    const cancelRead = () => { void reader.cancel().catch(() => {}) }
    scoped.addEventListener('abort', cancelRead, { once: true })
    try {
      scoped.throwIfAborted()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const chunk = await reader.read()
        scoped.throwIfAborted()
        if (chunk.done) return Buffer.concat(chunks, size)
        size += chunk.value.byteLength
        if (size > maxBytes) throw new Error('Android shell output too large')
        chunks.push(chunk.value)
      }
    } finally {
      scoped.removeEventListener('abort', cancelRead)
      reader.releaseLock()
      await child.kill()
    }
  })
}

export async function readAndroidShell(adb: Adb, command: string, maxBytes?: number, timeout?: number, signal?: AbortSignal) {
  return (await readAndroidShellOutput(adb, command, maxBytes, timeout, signal)).toString('utf8')
}
