import type { Adb } from '@yume-chan/adb'

// Only the short-lived shell is cancelled; the shared video transport stays alive.
export async function readAndroidShellOutput(
  adb: Adb, command: string, maxBytes = 256 * 1024, timeout = 7500, signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const scoped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let child: Awaited<ReturnType<Adb['subprocess']['noneProtocol']['spawn']>> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const operation = (async () => {
    child = await adb.subprocess.noneProtocol.spawn(command, scoped)
    void child.exited.catch(() => {})
    if (scoped.aborted) { await child.kill(); throw scoped.reason }
    const reader = child.output.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return Buffer.concat(chunks, size)
        size += chunk.value.byteLength
        if (size > maxBytes) throw new Error('Android shell output too large')
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
  })()
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Android shell timed out')
        controller.abort(error); reject(error)
      }, timeout)
    })])
  } finally {
    clearTimeout(timer)
    await child?.kill()
  }
}

export async function readAndroidShell(adb: Adb, command: string, maxBytes?: number, timeout?: number) {
  return (await readAndroidShellOutput(adb, command, maxBytes, timeout)).toString('utf8')
}
