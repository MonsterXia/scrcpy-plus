import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Adb } from '@yume-chan/adb'
import { ReadableStream } from '@yume-chan/stream-extra'
import { resolveResources } from 'share/main/lib/util'
import { closeAndroidChannel, readAndroidShell, waitForAndroidOperation } from './androidShell'

export async function readPackageMetadata(adb: Adb, user: string, names: string[], signal: AbortSignal): Promise<unknown[]> {
  const jar = await readFile(resolveResources('android/scrcpy-server'), { signal })
  signal.throwIfAborted()
  const path = `/data/local/tmp/scrcpy-plus-apps-${randomUUID()}.jar`
  let uploadStarted = false
  const opening = adb.sync()
  try {
    try {
      await waitForAndroidOperation(signal, async () => {
        const sync = await opening
        signal.throwIfAborted()
        uploadStarted = true
        await sync.write({ filename: path, permission: 0o444, file: ReadableStream.from([jar]) })
      })
    } finally {
      // Even a channel that opens after cancellation still belongs to this request.
      await closeAndroidChannel(() => opening.then(sync => sync.dispose(), () => {}))
    }
    signal.throwIfAborted()
    // user and package arguments are validated by androidGetBundleInfos.
    const output = await readAndroidShell(adb,
      `CLASSPATH=${path} app_process / com.genymobile.scrcpy.WorkspaceApps ${user} ${names.join(' ')}`,
      8 * 1024 * 1024, 30000, signal)
    const prefix = 'SCRCPY_WORKSPACE_APPS '
    const line = output.split(/\r?\n/).find(line => line.startsWith(prefix))
    if (!line) throw new Error('Android package metadata unavailable')
    const apps = JSON.parse(line.slice(prefix.length))
    if (!Array.isArray(apps)) throw new Error('Unexpected Android package metadata')
    return apps
  } finally {
    if (uploadStarted) {
      // Removing a partial upload gets a separate deadline even after cancellation.
      await readAndroidShell(adb, `rm -f ${path}`, 4096, 5000).catch(error =>
        console.warn('Could not remove Android package metadata helper', error))
    }
  }
}
