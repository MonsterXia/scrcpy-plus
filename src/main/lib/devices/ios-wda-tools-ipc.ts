import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import type { ITarget } from 'common/types'
import type { IosWdaPanel } from 'common/iosWdaTools'
import { isDev } from 'share/common/util'
import { resolve } from 'share/main/lib/util'
import { getWin } from 'share/main/lib/window'
import { nativeMirrors } from '../../window/nativeMirror'

export function initIosWdaTools(find: (key: string) => ITarget | undefined) {
  const calls = new Map<string, { key: string; controller: AbortController }>()
  const mainUrl = isDev() ? 'http://localhost:8080/' : pathToFileURL(resolve('renderer/index.html')).href
  function checkOwner(event: IpcMainInvokeEvent) {
    if (event.sender !== getWin('main')?.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== mainUrl) {
      throw Error('iOS tool window unavailable')
    }
  }
  ipcMain.handle('ios:wdaSnapshot', async (event, key: string, panel: IosWdaPanel, requestId: string) => {
    checkOwner(event)
    const target = typeof key === 'string' && find(key)
    if (!target || (panel !== 'layout' && panel !== 'screenshot') ||
        target.platform !== 'ios' || target.transport !== 'usb' || target.state !== 'ready' ||
        typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId) || calls.has(requestId) || calls.size >= 4) {
      throw Error('Invalid iOS snapshot request')
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const navigate = (details: Electron.WebContentsDidStartNavigationEventParams) => {
      if (details.isMainFrame && !details.isSameDocument) cancel()
    }
    calls.set(requestId, { key, controller })
    event.sender.on('did-start-navigation', navigate)
    event.sender.once('destroyed', cancel)
    event.sender.once('render-process-gone', cancel)
    try {
      return await nativeMirrors.iosWorkspaceSnapshot(target, panel, controller.signal)
    } finally {
      calls.delete(requestId)
      event.sender.removeListener('did-start-navigation', navigate)
      event.sender.removeListener('destroyed', cancel)
      event.sender.removeListener('render-process-gone', cancel)
    }
  })
  ipcMain.handle('ios:cancelWdaSnapshot', (event, requestId: string) => {
    checkOwner(event)
    calls.get(requestId)?.controller.abort()
  })
  return (targets: ITarget[]) => {
    const ready = new Set(targets.filter(target => target.transport === 'usb' && target.state === 'ready').map(target => target.key))
    for (const { key, controller } of calls.values()) if (!ready.has(key)) controller.abort()
  }
}
