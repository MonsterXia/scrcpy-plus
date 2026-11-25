import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Adb } from '@yume-chan/adb'
import { ReadableStream } from '@yume-chan/stream-extra'
import { resolveResources } from 'share/main/lib/util'
import { readAndroidShell } from './androidShell'

export async function readPackageMetadata(adb: Adb, user: string, names: string[]): Promise<unknown[]> {
  const jar = await readFile(resolveResources('android/scrcpy-server'))
  const path = `/data/local/tmp/scrcpy-plus-apps-${randomUUID()}.jar`
  try {
    const sync = await adb.sync()
    try {
      // A read-only, request-owned JAR works alongside the mirroring server.
      await sync.write({
        filename: path,
        permission: 0o444,
        file: ReadableStream.from([jar]),
      })
    } finally {
      await sync.dispose()
    }
    // user and package arguments are validated by androidGetBundleInfos.
    const output = await readAndroidShell(adb,
      `CLASSPATH=${path} app_process / com.genymobile.scrcpy.WorkspaceApps ${user} ${names.join(' ')}`,
      8 * 1024 * 1024, 30000)
    const prefix = 'SCRCPY_WORKSPACE_APPS '
    const line = output.split(/\r?\n/).find(line => line.startsWith(prefix))
    if (!line) throw new Error('Android package metadata unavailable')
    const apps = JSON.parse(line.slice(prefix.length))
    if (!Array.isArray(apps)) throw new Error('Unexpected Android package metadata')
    return apps
  } finally {
    await adb.rm(path, { force: true }).catch(error =>
      console.warn('Could not remove Android package metadata helper', error))
  }
}
