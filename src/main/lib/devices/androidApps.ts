import type { Adb } from '@yume-chan/adb'
import type { IBundleInfo } from 'common/types'
import { withAndroidAdb } from './android'
import { readAndroidShell } from './androidShell'
import { readPackageMetadata } from './androidAppMetadata'

const packagePattern = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*$/

export function packageArgument(value: string) {
  if (typeof value !== 'string' || !packagePattern.test(value))
    throw new Error('Invalid Android package name')
  return value
}

async function shell(adb: Adb, command: string, timeout = 15000) {
  // The exec protocol is available on older devices but omits the exit code.
  const output = await readAndroidShell(adb,
    `${command}; printf '\\nSCRCPY_EXIT:%d\\n' "$?"`, 8 * 1024 * 1024, timeout)
  const status = /\nSCRCPY_EXIT:(\d+)\r?\n?$/.exec(output)
  if (!status || status[1] !== '0') throw new Error('Android command failed')
  return output.slice(0, status.index).trim()
}

async function currentUser(adb: Adb) {
  const user = await shell(adb, 'am get-current-user')
  if (!/^\d+$/.test(user)) throw new Error('Cannot determine active Android user')
  return user
}

function parsePackages(output: string) {
  const packages = new Map<string, string | undefined>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^package:(\S+?)(?:\s+uid:\s*(\d+))?\s*$/.exec(line)
    if (!match || !packagePattern.test(match[1]))
      throw new Error('Unexpected Android package list')
    packages.set(match[1], match[2])
  }
  return packages
}

export function androidGetBundles(key: string, system = true) {
  return withAndroidAdb(key, async adb => {
    const user = await currentUser(adb)
    const output = await shell(adb, `pm list packages${system ? '' : ' -3'} --user ${user}`)
    return [...parsePackages(output).keys()].sort()
  })
}

async function supportsCacheOnly(adb: Adb) {
  const help = await shell(adb, 'pm help')
  return /^\s*(?:pm\s+)?clear\s+[^\n]*\[--cache-only\]/m.test(help)
}

function parseBundle(name: string, dump: string, user: string, supportsCleanCache: boolean): IBundleInfo {
  const packages = dump.split(/^Packages:\s*$/m)[1]
  if (!packages) throw new Error('Missing Android package metadata')
  const block = packages.trimStart().split(/\n(?=\S| {2}Package \[)/)[0]
  if (!block.startsWith(`Package [${name}]`))
    throw new Error('Android package metadata does not match requested package')
  const users = block.split(/^\s*User (\d+):/m)
  const userIndex = users.findIndex((id, index) => index % 2 === 1 && id === user)
  const installedAt = (userIndex > 0 ? users[userIndex + 1] : '').match(/\bfirstInstallTime=([^\r\n]+)/)?.[1]
    || users[0].match(/\bfirstInstallTime=([^\r\n]+)/)?.[1]
  const flags = block.match(/^\s*(?:pkgFlags|flags)=\[([^\]]*)\]/m)?.[1]
  return {
    bundleName: name, label: name, icon: '', vendor: '', releaseType: '',
    versionName: block.match(/^\s*versionName=(.+)$/m)?.[1]?.trim() || '',
    apiTargetVersion: Number(block.match(/\btargetSdk=(\d+)/)?.[1]) || 0,
    system: /\bSYSTEM\b/.test(flags || ''),
    installTime: installedAt ? Date.parse(installedAt.trim().replace(' ', 'T')) || 0 : 0,
    supportsCleanCache,
  }
}

export function isActivity(name: string, component: string) {
  return typeof component === 'string' && component.startsWith(`${name}/`) &&
    /^\.?[\w$]+(?:\.[\w$]+)*$/.test(component.slice(name.length + 1))
}

function mapPackageRecord(record: unknown, names: string[], supportsCleanCache: boolean): IBundleInfo {
  if (!record || typeof record !== 'object') throw new Error('Missing Android package')
  const fields = record as Record<string, unknown>
  const name = fields.bundleName
  if (typeof name !== 'string' || !names.includes(name) || typeof fields.system !== 'boolean')
    throw new Error('Unexpected Android package')
  const png = fields.png
  const icon = typeof png === 'string' && png.length < 40000 && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(png)
    ? `data:image/png;base64,${png}` : ''
  return {
    bundleName: name,
    label: typeof fields.label === 'string' && fields.label.trim() ? fields.label.trim() : name,
    system: fields.system,
    versionName: typeof fields.versionName === 'string' ? fields.versionName : '',
    installTime: typeof fields.installTime === 'number' ? fields.installTime : 0,
    apiTargetVersion: typeof fields.apiTargetVersion === 'number' ? fields.apiTargetVersion : 0,
    mainAbility: typeof fields.mainAbility === 'string' && isActivity(name, fields.mainAbility) ? fields.mainAbility : undefined,
    icon, supportsCleanCache, vendor: '', releaseType: '',
  }
}

export function androidGetBundleInfos(key: string, names: string[]) {
  const packages = names.map(packageArgument)
  return withAndroidAdb(key, async adb => {
    const user = await currentUser(adb)
    const cacheOnly = await supportsCacheOnly(adb).catch(() => false)
    const infos: IBundleInfo[] = []
    for (let start = 0; start < packages.length; start += 64) {
      const batch = packages.slice(start, start + 64)
      try {
        const records = await readPackageMetadata(adb, user, batch)
        const seen = new Set<string>()
        const fromDevice = records.map(record => {
          const info = mapPackageRecord(record, batch, cacheOnly)
          if (seen.has(info.bundleName)) throw new Error('Duplicate Android package metadata')
          seen.add(info.bundleName)
          return info
        })
        infos.push(...fromDevice)
        continue
      } catch {
        // Some OEMs restrict app_process. Keep the package-manager shell path
        // available when the helper cannot run on this device.
      }
      for (const name of batch) {
        try {
          const dump = await shell(adb, `dumpsys package ${name}`)
          const info = parseBundle(name, dump, user, cacheOnly)
          const resolver = await shell(adb,
            `cmd package resolve-activity --brief --user ${user} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p ${name}`
          ).catch(() => '')
          info.mainAbility = resolver.split(/\r?\n/).map(line => line.trim()).find(line => isActivity(name, line))
          infos.push(info)
        } catch {
          // Packages can disappear between enumeration and a metadata request.
          // The applications panel reports the missing records alongside successful ones.
        }
      }
    }
    return infos
  })
}

export function androidStartBundle(key: string, name: string, activity: string, beforeWrite?: () => void) {
  packageArgument(name)
  if (!isActivity(name, activity)) throw new Error('Invalid Android activity')
  return withAndroidAdb(key, async adb => {
    const user = await currentUser(adb)
    beforeWrite?.()
    const output = await shell(adb, `am start --user ${user} -n '${activity}'`)
    if (!/^Starting: Intent\b/m.test(output) || /^\s*(?:Error|Exception|SecurityException)\b/im.test(output))
      throw new Error('Android activity launch failed')
  })
}

export function androidStopBundle(key: string, name: string, beforeWrite?: () => void) {
  packageArgument(name)
  return withAndroidAdb(key, async adb => {
    const user = await currentUser(adb)
    beforeWrite?.()
    const output = await shell(adb, `am force-stop --user ${user} ${name}`)
    if (output) throw new Error('Android force-stop failed')
  })
}

export class AndroidCacheUnsupportedError extends Error {
  constructor() { super('Per-app cache clearing is unavailable') }
}

async function managePackage(key: string, name: string, action: 'clear' | 'clear-cache' | 'uninstall', beforeWrite?: () => void) {
  packageArgument(name)
  await withAndroidAdb(key, async adb => {
    const user = await currentUser(adb)
    if (action === 'clear-cache' && !(await supportsCacheOnly(adb)))
      throw new AndroidCacheUnsupportedError()
    const command = action === 'clear-cache' ? 'clear --cache-only' : action
    beforeWrite?.()
    const output = await shell(adb, `pm ${command} --user ${user} ${name}`, 60000)
    if (output !== 'Success') throw new Error('Android package operation failed')
  })
}

export const androidCleanBundleData = (key: string, name: string, beforeWrite?: () => void) => managePackage(key, name, 'clear', beforeWrite)
export const androidCleanBundleCache = (key: string, name: string, beforeWrite?: () => void) => managePackage(key, name, 'clear-cache', beforeWrite)
export const androidUninstallBundle = (key: string, name: string, beforeWrite?: () => void) => managePackage(key, name, 'uninstall', beforeWrite)

export function androidGetProcesses(key: string) {
  return withAndroidAdb(key, async adb => {
    const user = await currentUser(adb)
    const output = await shell(adb, 'ps -A -o PID,UID,USER,PCPU,TIME,RSS,NAME 2>/dev/null || ps')
    const [header, ...lines] = output.split(/\r?\n/)
    if (!/^\s*PID\s+UID\s+USER\s+(?:PCPU|%CPU)\s+TIME\s+RSS\s+NAME\s*$/.test(header)) {
      // Older toolbox versions have a fixed table and no numeric UID column.
      // Display the available values without associating a package by name alone.
      const fields = header.trim().split(/\s+/)
      const pid = fields.indexOf('PID'), userName = fields.indexOf('USER'), rss = fields.indexOf('RSS')
      if (pid < 0 || userName < 0 || fields.at(-1) !== 'NAME')
        throw new Error('Unexpected Android process table')
      return lines.flatMap(line => {
        const values = line.trim().split(/\s+/)
        if (!/^\d+$/.test(values[pid])) return []
        return [{ pid: values[pid], name: values.at(-1)!, user: values[userName],
          res: /^\d+$/.test(values[rss]) ? `${values[rss]}K` : '' }]
      })
    }

    const packages = await shell(adb, `pm list packages -U --user ${user}`)
      .then(parsePackages).catch(() => new Map<string, string>())
    return lines.flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      if (!match) return []
      const [, pid, uid, userName, cpu, cpuTime, rss, name] = match
      const pkg = name.split(':')[0]
      const bundleName = packages.get(pkg) === uid ? pkg : undefined
      return [{ pid, name, user: userName, '%cpu': cpu, 'time+': cpuTime, res: `${rss}K`, bundleName }]
    })
  })
}
