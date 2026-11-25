import { withAndroidAdb, getAndroidOverview, installAndroidApk } from '../../lib/devices/android'
import {
  androidGetBundles, androidGetBundleInfos, androidGetProcesses, androidStartBundle, androidStopBundle,
  androidUninstallBundle, androidCleanBundleData, androidCleanBundleCache, AndroidCacheUnsupportedError, packageArgument, isActivity,
} from '../../lib/devices/androidApps'
import { androidDumpLayout, androidGetTopBundle, captureAndroidPng } from '../../lib/devices/androidInspection'
import { androidGetWebviews } from '../../lib/devices/androidWebviews'
import { readAndroidShellOutput } from '../../lib/devices/androidShell'
import { AutomationFault, checkContext, MAX_IMAGE_BYTES, MAX_REQUEST_BYTES } from '../../../common/automation/protocol'
import type { AutomationContext } from '../../../common/automation/protocol'
import type { TargetOperation, TargetTools } from './harmonyTools'
import { runOneShotShell } from './oneShotShell'
import { waitForRead } from './waitForRead'
import { withInstallationSource } from './installSource'
import { workspaceArtifact } from './workspaceArtifacts'
import { captureLogcat } from './logcat'

function packageName(value: unknown) {
  try { return packageArgument(value as string) }
  catch { throw new AutomationFault('INVALID_ARGUMENT', 'Invalid Android package name') }
}

// Check again at the device write, after opening ADB, resolving the active user,
// or waiting in the APK install queue. Never replay a disconnected write.
async function write<T>(context: AutomationContext, operation: (dispatch: () => void) => Promise<T>) {
  let sent = false
  const dispatch = () => { checkContext(context); sent = true }
  try {
    return await waitForRead(context, () => operation(dispatch))
  } catch (error) {
    if (!sent) {
      if (error instanceof AndroidCacheUnsupportedError) throw new AutomationFault('UNSUPPORTED', error.message)
      throw error
    }
    const code = error instanceof AutomationFault ? error.code : 'OUTCOME_UNKNOWN'
    throw new AutomationFault(code, 'Android operation completion is unconfirmed', 'unknown')
  }
}

function appAction(action: typeof androidStopBundle): TargetOperation {
  return async (params, context, target) => {
    const name = packageName(params.bundle)
    await write(context, dispatch => action(target.key, name, dispatch))
    return { completed: true }
  }
}

export const androidTools: TargetTools = {
  'overview.get': (_p, c, target) => waitForRead(c, () => getAndroidOverview(target)),
  'apps.list': (p, c, target) => waitForRead(c, () => androidGetBundles(target.key, p.userOnly !== true)),
  'apps.info': async (p, c, target) => {
    const [info] = await waitForRead(c, () => androidGetBundleInfos(target.key, [packageName(p.bundle)]))
    if (!info) throw new AutomationFault('UNAVAILABLE', 'Application metadata is unavailable')
    return info
  },
  'apps.top': (_p, c, target) => waitForRead(c, () => androidGetTopBundle(target.key)),
  'processes.list': (_p, c, target) => waitForRead(c, () => androidGetProcesses(target.key)),
  'apps.start': async (p, c, target) => {
    const name = packageName(p.bundle)
    const activity = p.ability as string
    if (!isActivity(name, activity)) throw new AutomationFault('INVALID_ARGUMENT', 'Use the package/activity component from apps.info')
    await write(c, dispatch => androidStartBundle(target.key, name, activity, dispatch))
    return { completed: true }
  },
  'apps.stop': appAction(androidStopBundle),
  'apps.uninstall': appAction(androidUninstallBundle),
  'apps.clear-data': appAction(androidCleanBundleData),
  'apps.clear-cache': appAction(androidCleanBundleCache),
  'apps.install': async (p, c, target) => {
    const deadline = AbortSignal.timeout(Math.max(1, c.deadline - Date.now()))
    const signal = AbortSignal.any([c.signal, deadline])
    const result = await write(c, dispatch => withInstallationSource(p.path as string, { ...c, signal },
      file => installAndroidApk(target.key, file, dispatch, signal), '.apk'))
    return { completed: true, cleanupConfirmed: result.cleanupConfirmed }
  },
  'shell.run': (p, c, target) => write(c, dispatch =>
    runOneShotShell(p.command as string, Number(p.maxBytes ?? 131072), c, command =>
      withAndroidAdb(target.key, async adb => {
        dispatch()
        const bytes = await readAndroidShellOutput(adb, command, 16 * 1024 * 1024, c.deadline - Date.now(), c.signal)
        return bytes.toString('utf8')
      }))),
  'logs.capture': (p, c, target) => waitForRead(c, () => withAndroidAdb(target.key, adb =>
    captureLogcat(adb, Number(p.durationMs ?? 5000), Number(p.maxBytes ?? 1048576), c))),
  'layout.dump': async (_p, c, target) => workspaceArtifact('application/xml',
    Buffer.from(await waitForRead(c, () => androidDumpLayout(target.key, MAX_REQUEST_BYTES, c.signal)))),
  'screen.snapshot': async (_p, c, target) => workspaceArtifact('image/png',
    await waitForRead(c, () => captureAndroidPng(target.key, MAX_IMAGE_BYTES, c.signal))),
  'webviews.list': async (_p, c, target) => {
    const { pid } = await waitForRead(c, () => androidGetTopBundle(target.key))
    return pid ? waitForRead(c, () => androidGetWebviews(target.key, pid)) : []
  },
}
