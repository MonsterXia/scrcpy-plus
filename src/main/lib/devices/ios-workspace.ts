import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { pathToFileURL } from 'node:url'
import type { ITarget } from 'common/types'
import type { IosWorkspaceRequest, IosWorkspaceRows } from 'common/iosWorkspace'
import { isDev } from 'share/common/util'
import { resolve } from 'share/main/lib/util'
import { getIosHelper } from '../ios-provisioning'
import { runIosHelper } from './ios-workspace-runner'

function validate(request: IosWorkspaceRequest): IosWorkspaceRequest {
  const bundle = (value: string) => {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,254}$/i.test(value)) throw Error('protocol')
    return value
  }
  switch (request?.op) {
    case 'install': case 'processes': case 'logs': case 'apps': case 'webPages':
      return { op: request.op }
    case 'launch': case 'uninstall':
      return { op: request.op, bundleId: bundle(request.bundleId) }
    case 'terminate':
      if (!Number.isSafeInteger(request.pid) || request.pid <= 1 || request.pid > 0x7fffffff) break
      return { op: 'terminate', pid: request.pid, bundleId: bundle(request.bundleId) }
    case 'files': {
      const path = request.path
      if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') ||
          (path !== '/' && path.slice(1).split('/').some(part =>
            !part || part.length > 255 || part === '.' || part === '..' || /[\\\p{Cc}]/u.test(part)))) break
      return { op: 'files', path, ...(request.bundleId === undefined ? {} : { bundleId: bundle(request.bundleId) }) }
    }
    case 'webDom':
      if (typeof request.targetId !== 'string' || !request.targetId.length || request.targetId.length > 256 || /\p{Cc}/u.test(request.targetId)) break
      return { op: 'webDom', targetId: request.targetId }
  }
  throw Error('protocol')
}

export function initIosWorkspace(contents: WebContents, find: (key: string) => ITarget | undefined) {
  const calls = new Map<string, { key: string; abort: AbortController; mutation: boolean }>()
  const running = new Set<Promise<void>>()
  const url = isDev() ? 'http://localhost:8080/' : pathToFileURL(resolve('renderer/index.html')).href
  function owner(event: IpcMainInvokeEvent) {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame?.url !== url) throw Error('protocol')
  }
  function device(key: string) {
    const target = find(key)
    if (!target || target.platform !== 'ios' || target.transport !== 'usb' || target.state !== 'ready' ||
        !target.connectionId || key !== 'ios:' + target.connectionId) throw Error('disconnected')
    return target.connectionId
  }
  function stopAll() {
    for (const { abort } of calls.values()) abort.abort(Error('cancelled'))
    return Promise.allSettled([...running])
  }
  contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) stopAll() })
  contents.on('render-process-gone', stopAll)
  contents.once('destroyed', stopAll)
  ipcMain.handle('ios:cancelWorkspace', (event, id: string) => {
    owner(event)
    calls.get(id)?.abort.abort(Error('cancelled'))
  })
  ipcMain.handle('ios:workspace', async (event, key: string, input: IosWorkspaceRequest, id: string) => {
    owner(event)
    const request = validate(input)
    device(key)
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(id) || calls.has(id) || calls.size >= 16) throw Error('protocol')
    const mutation = ['install', 'uninstall', 'launch', 'terminate'].includes(request.op)
    if (mutation && [...calls.values()].some(call => call.key === key && call.mutation)) throw Error('busy')
    const abort = new AbortController()
    calls.set(id, { key, abort, mutation })
    type Row = IosWorkspaceRows[keyof IosWorkspaceRows]
    let rows: Row[] = [], bytes = 0
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      clearTimeout(flushTimer)
      flushTimer = undefined
      if (rows.length && !contents.isDestroyed() && !abort.signal.aborted) contents.send('ios:workspaceLogs', id, rows)
      rows = []
    }
    try {
      let helperInput: IosWorkspaceRequest & { path?: string } = request
      if (request.op === 'install') {
        const win = BrowserWindow.fromWebContents(contents)
        if (!win) throw Error('cancelled')
        const choice = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'IPA', extensions: ['ipa'] }] })
        if (choice.canceled || !choice.filePaths[0]) throw Error('cancelled')
        helperInput = { op: 'install', path: choice.filePaths[0] }
      }
      abort.signal.throwIfAborted()
      const timeout = request.op === 'install' ? 600000 : request.op === 'files' ? 125000 : 60000
      if (request.op !== 'logs') deadline = setTimeout(() => abort.abort(Error('timeout')), timeout)
      const executable = await getIosHelper().deviceExecutable()
      abort.signal.throwIfAborted()
      const work = runIosHelper(executable, device(key), helperInput, abort.signal, row => {
        if (request.op === 'logs') {
          rows.push(row)
          if (rows.length > 300) rows.shift()
          if (!flushTimer) flushTimer = setTimeout(flush, 120)
        } else {
          bytes += Buffer.byteLength(JSON.stringify(row))
          if (rows.length >= 10000 || bytes > 16 * 1024 * 1024) throw Error('result-limit')
          rows.push(row)
        }
      })
      running.add(work)
      try { await work } finally { running.delete(work) }
      if (request.op === 'logs') flush()
      return rows
    } catch (error) {
      abort.signal.throwIfAborted()
      throw error
    } finally {
      clearTimeout(deadline)
      clearTimeout(flushTimer)
      calls.delete(id)
    }
  })
  return {
    stopAll,
    reconcile(targets: ITarget[]) {
      const ready = new Set(targets.filter(target => target.transport === 'usb' && target.state === 'ready').map(target => target.key))
      for (const call of calls.values()) if (!ready.has(call.key)) call.abort.abort(Error('disconnected'))
    },
  }
}
