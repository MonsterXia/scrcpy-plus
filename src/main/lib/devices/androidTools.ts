import { ipcMain, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import { isDev } from 'share/common/util'
import { resolve } from 'share/main/lib/util'
import { sendAll } from 'share/main/lib/window'
import { acquireAndroidAdb, installAndroidApk } from './android'
import {
  androidCleanBundleCache, androidCleanBundleData, androidGetBundleInfos, androidGetBundles,
  androidGetProcesses, androidStartBundle, androidStopBundle, androidUninstallBundle,
} from './androidApps'
import { androidDumpLayout, androidScreencap, androidGetTopBundle } from './androidInspection'
import { androidGetWebviews, androidInspectWebview } from './androidWebviews'
import {
  androidCreateShell, androidWriteShell, androidResizeShell, androidKillShell, androidOpenHilog, androidCloseHilog,
  androidPauseHilog, androidResumeHilog, closeAndroidStreams,
} from './androidStreams'

let workspaceOpening: AbortController | undefined
let workspaceLease: ReturnType<typeof acquireAndroidAdb> | undefined

async function releaseWorkspace() {
  workspaceOpening?.abort()
  workspaceOpening = undefined
  const lease = workspaceLease
  workspaceLease = undefined
  await (await lease?.catch(() => undefined))?.release()
}

async function selectTools(key: string | null) {
  const released = releaseWorkspace()
  if (key === null) return released
  workspaceOpening = new AbortController()
  const opening = acquireAndroidAdb(key, workspaceOpening.signal)
  workspaceLease = opening
  await Promise.all([released, opening])
}

async function installBundle(key: string, filePath: string) {
  await installAndroidApk(key, filePath)
  sendAll('bundleInstalled', key)
}

export async function disposeAndroidTools() {
  await Promise.all([releaseWorkspace(), closeAndroidStreams()])
}

export function initAndroidTools(contents: WebContents) {
  const mainUrl = isDev() ? 'http://localhost:8080/' : pathToFileURL(resolve('renderer/index.html')).href
  const handlers = {
    selectTools, installBundle,
    getBundles: androidGetBundles, getBundleInfos: androidGetBundleInfos, startBundle: androidStartBundle,
    stopBundle: androidStopBundle, cleanBundleCache: androidCleanBundleCache, cleanBundleData: androidCleanBundleData,
    uninstallBundle: androidUninstallBundle, getProcesses: androidGetProcesses,
    screencap: androidScreencap, dumpWindowHierarchy: (key: string) => androidDumpLayout(key), getTopBundle: androidGetTopBundle,
    getWebviews: androidGetWebviews, inspectWebview: androidInspectWebview,
    createShell: androidCreateShell, writeShell: androidWriteShell, resizeShell: androidResizeShell, killShell: androidKillShell,
    openHilog: androidOpenHilog, closeHilog: androidCloseHilog, pauseHilog: androidPauseHilog, resumeHilog: androidResumeHilog,
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('android:' + name, (event, ...args) => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame?.url !== mainUrl) {
        throw Error('Android tool window unavailable')
      }
      return Reflect.apply(handler, undefined, args)
    })
  }
  const cleanup = () => { void disposeAndroidTools().catch(error => console.warn('Android tool cleanup failed', error)) }
  contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) cleanup() })
  contents.on('render-process-gone', cleanup)
  contents.once('destroyed', cleanup)
}
