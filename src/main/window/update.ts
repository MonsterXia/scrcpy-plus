import { BrowserWindow, ipcMain, screen } from 'electron'
import path from 'path'
import type { UpdateAction, UpdateState } from 'common/types'
import * as window from 'share/main/lib/window'
import { isDev } from 'share/common/util'

let win: BrowserWindow | null = null
let present: (() => void) | undefined
let current: UpdateState
let onAction: (action: UpdateAction) => void | Promise<void>
let registered = false

function size(state: UpdateState) {
  if (state.status === 'checking') return { width: 400, height: 146 }
  if (state.status === 'available') return { width: 280, height: 286 }
  return { width: 260, height: state.status === 'error' || state.status === 'unavailable' ? 250 : 234 }
}

function bounds(width: number, height: number, parent?: BrowserWindow | null) {
  const old = parent?.getBounds()
  const area = old ? screen.getDisplayMatching(old).workArea : screen.getPrimaryDisplay().workArea
  const x = old ? old.x + (old.width - width) / 2 : area.x + (area.width - width) / 2
  const y = old ? old.y + (old.height - height) / 2 : area.y + (area.height - height) / 2
  return { width, height, x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))) }
}

export function showUpdateWindow(state: UpdateState, action: typeof onAction) {
  if (win && !win.isDestroyed()) { focusUpdateWindow(); return }
  current = state
  onAction = action
  if (!registered) {
    registered = true
    const guard = (event) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
        throw new Error('Update controls require the active update window')
      }
    }
    ipcMain.handle('getUpdateState', (event) => { guard(event); return current })
    ipcMain.handle('updateAction', async (event, value: unknown) => {
      guard(event)
      if (!['cancel', 'close', 'openRelease'].includes(value as string)) throw new Error('Invalid update action')
      await onAction(value as UpdateAction)
    })
  }
  const focused = BrowserWindow.getFocusedWindow() || window.getWin('main')
  const parent = focused && !focused.isDestroyed() ? focused : undefined
  if (parent?.isMinimized()) parent.restore()
  parent?.show()
  const { width, height } = size(state)
  // AppKit throttles dragging an attached child window. Keep the owner for
  // placement and lifecycle, but let WindowServer move this window independently.
  const macOwner = process.platform === 'darwin' ? parent : undefined
  const instance = new BrowserWindow({
    ...bounds(width, height, parent),
    parent: macOwner ? undefined : parent,
    show: false,
    frame: false,
    transparent: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: parent?.isAlwaysOnTop() || false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false },
  })
  win = instance
  instance.setMenu(null)
  let ready = false
  if (macOwner) {
    const hide = () => instance.hide()
    const restore = () => { if (ready) instance.showInactive() }
    const syncPin = () => {
      const pinned = macOwner.isAlwaysOnTop()
      if (instance.isAlwaysOnTop() !== pinned) instance.setAlwaysOnTop(pinned)
    }
    const raise = () => {
      syncPin()
      if (instance.isVisible()) instance.moveTop()
    }
    const close = () => instance.destroy()
    macOwner.on('hide', hide).on('minimize', hide)
    macOwner.on('show', restore).on('restore', restore)
    macOwner.on('always-on-top-changed', syncPin)
    macOwner.on('focus', raise).once('closed', close)
    instance.once('closed', () => {
      macOwner.off('hide', hide).off('minimize', hide)
      macOwner.off('show', restore).off('restore', restore)
      macOwner.off('always-on-top-changed', syncPin)
      macOwner.off('focus', raise).off('closed', close)
    })
  }
  const show = () => {
    if (!ready || instance.isDestroyed() || (macOwner && (!macOwner.isVisible() || macOwner.isMinimized()))) return
    instance.show()
    instance.focus()
  }
  present = show
  instance.once('ready-to-show', () => {
    ready = true
    show()
  })
  instance.on('closed', () => {
    if (win !== instance) return
    win = null
    present = undefined
    void onAction('close')
  })
  instance.webContents.on('did-finish-load', () => {
    if (win === instance) instance.webContents.send('updateState', current)
  })
  instance.webContents.on('render-process-gone', () => instance.destroy())
  const loaded = isDev()
    ? instance.loadURL('http://localhost:8080/?page=update')
    : instance.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { page: 'update' } })
  void loaded.catch(() => { if (!instance.isDestroyed()) instance.destroy() })
}

export function setUpdateState(state: UpdateState) {
  current = state
  if (!win || win.isDestroyed()) return
  const { width, height } = size(state)
  win.setBounds(bounds(width, height, win))
  win.webContents.send('updateState', state)
}

export function focusUpdateWindow() {
  present?.()
}

export function closeUpdateWindow() {
  const instance = win
  // This window has no editable state. Detach before destruction so a new
  // check cannot reuse a closing window or inherit its delayed closed event.
  win = null
  present = undefined
  if (instance && !instance.isDestroyed()) instance.destroy()
}
