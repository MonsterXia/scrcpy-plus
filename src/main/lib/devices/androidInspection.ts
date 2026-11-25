import type { Adb } from '@yume-chan/adb'
import { randomUUID } from 'node:crypto'
import { withAndroidAdb } from './android'
import { readAndroidShellOutput } from './androidShell'

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const pngEnd = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])

export function captureAndroidPng(key: string, maxBytes = 64 * 1024 * 1024, signal?: AbortSignal) {
  return withAndroidAdb(key, async adb => {
    const bytes = await readAndroidShellOutput(adb, 'screencap -p', maxBytes, 20000, signal)
    if (!bytes.subarray(0, 8).equals(pngSignature) || !bytes.subarray(-12).equals(pngEnd)) {
      throw new Error('Android did not return a complete PNG capture')
    }
    return bytes
  })
}

export async function androidScreencap(key: string) {
  return (await captureAndroidPng(key)).toString('base64')
}

export function androidDumpLayout(key: string, maxBytes = 16 * 1024 * 1024, signal?: AbortSignal) {
  return withAndroidAdb(key, async adb => {
    const file = `/data/local/tmp/scrcpy-plus-ui-${randomUUID()}.xml`
    // Each invocation owns its temporary file, including concurrent captures.
    // Some OEM builds emit launcher/theme stack traces even on successful dumps.
    // Return only the captured XML and clean up on normal exit or interruption.
    const command = `trap 'rm -f ${file}' EXIT; uiautomator dump ${file} >/dev/null 2>&1 && cat ${file}`
    const xml = (await readAndroidShellOutput(adb, command, maxBytes, 30000, signal)).toString('utf8').trim()
    if (!/^(?:<\?xml[^?]*\?>\s*)?<hierarchy\b/.test(xml) || !xml.endsWith('</hierarchy>')) {
      throw new Error('Android did not return a UI Automator hierarchy')
    }
    return xml
  })
}

export async function foregroundProcesses(adb: Adb) {
  const activities = (await readAndroidShellOutput(adb,
    "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity|ResumedActivity:'", 1024 * 1024, 8000)).toString()
  const records = activities.split('\n')
  const record = records.find(line => /topResumedActivity=ActivityRecord/.test(line))
    ?? records.find(line => /ResumedActivity[:=]\s*ActivityRecord/.test(line))
  const activity = record?.match(/ActivityRecord\{(\w+)\s+u(\d+)\s+([\w.]+)\//)
  if (!activity) return { name: '', pids: [] as number[] }
  const [, token, user, name] = activity
  // ActivityManager filters by the packages actually hosted in each process,
  // including custom process names and apps that share a UID. Filter the user
  // separately because this dump spans all profiles.
  const command = `dumpsys activity processes ${name} | grep -E '^[[:space:]]*[*](APP|PERS)[*] UID |^[[:space:]]*- ActivityRecord'`
  const list = (await readAndroidShellOutput(adb, command, 1024 * 1024, 8000)).toString()
  const processes: { pid: number; priority: number }[] = []
  let current: typeof processes[number] | undefined
  for (const line of list.trim().split(/\r?\n/)) {
    const header = /^\s*\*(?:APP|PERS)\* UID (\d+) ProcessRecord\{\w+ (\d+):([^/\s]+)\//.exec(line)
    if (header) {
      const [, uid, pid, processName] = header
      current = undefined
      if (Number(pid) > 0 && Math.floor(Number(uid) / 100000) === Number(user)) {
        current = { pid: Number(pid), priority: processName === name ? 1 : 0 }
        processes.push(current)
      }
    } else if (current && line.trimStart().startsWith(`- ActivityRecord{${token} `) && line.trimEnd().endsWith('}')) {
      // Remote/embedded activity references carry trailing flags; only the
      // owning process lists the activity record itself here.
      current.priority = 2
    }
  }
  processes.sort((a, b) => b.priority - a.priority || a.pid - b.pid)
  return { name, pids: processes.map(process => process.pid) }
}

export function androidGetTopBundle(key: string) {
  return withAndroidAdb(key, async adb => {
    const { name, pids } = await foregroundProcesses(adb)
    return { name, pid: pids[0] ?? 0 }
  })
}
