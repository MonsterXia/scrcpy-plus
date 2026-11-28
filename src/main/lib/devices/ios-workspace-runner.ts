import { spawn } from 'node:child_process'
import type { IosWorkspaceRequest, IosWorkspaceRows } from 'common/iosWorkspace'

type Row = IosWorkspaceRows[keyof IosWorkspaceRows]

// The frozen device helper emits one JSON record per line. Keep streams and
// terminal operations on the selected USB device for the life of this process.
export async function runIosHelper(
  executable: string, udid: string, request: (IosWorkspaceRequest & { path?: string }) | { op: 'cleanupStaging' },
  signal: AbortSignal, onRow: (row: Row) => void, stagingRoot?: string,
) {
  signal.throwIfAborted()
  const child = spawn(executable, ['--workspace', '--cancel-on-eof'], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    env: stagingRoot ? { ...process.env, SCRCPY_PLUS_IOS_STAGING_ROOT: stagingRoot } : process.env,
  })
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  // Spawn failure can precede the end of stdout.
  void exit.catch(() => {})
  let force: ReturnType<typeof setTimeout> | undefined
  const kill = () => {
    // EOF lets Python unwind open USB services and partial IPA uploads on Windows too.
    if (!child.stdin.writableEnded) child.stdin.end()
    force ??= setTimeout(() => child.kill('SIGKILL'), 5000)
  }
  signal.addEventListener('abort', kill, { once: true })
  child.stdin.on('error', () => {})
  child.stdout.setEncoding('utf8')
  let pending = '', done = false
  try {
    child.stdin.write(JSON.stringify({ ...request, udid }) + '\n')
    for await (const chunk of child.stdout) {
      pending += chunk
      let boundary: number
      while ((boundary = pending.indexOf('\n')) >= 0) {
        if (done || boundary > 128 * 1024) throw Error('protocol')
        const record = JSON.parse(pending.slice(0, boundary))
        pending = pending.slice(boundary + 1)
        if (typeof record.error === 'string') throw Error(record.error)
        if (record.done === true) done = true
        else if (record.row && typeof record.row === 'object') onRow(record.row)
        else throw Error('protocol')
      }
      if (pending.length > 128 * 1024) throw Error('protocol')
    }
    const code = await exit
    signal.throwIfAborted()
    if (code !== 0 || !done || pending.trim()) throw Error('device-error')
  } finally {
    signal.removeEventListener('abort', kill)
    if (child.exitCode === null && !child.signalCode) kill()
    await exit.catch(() => {})
    clearTimeout(force)
  }
}
