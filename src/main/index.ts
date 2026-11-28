import './automation/profile'
import { app } from 'electron'
import * as menu from './lib/menu'
import * as main from './window/main'
import * as terminal from 'share/main/window/terminal'
import * as hdc from './lib/hdc'
import * as devices from './lib/devices'
import { initIosWorkspace } from './lib/devices/ios-workspace'
import { initIosWdaTools } from './lib/devices/ios-wda-tools-ipc'
import { initAndroidTools, disposeAndroidTools } from './lib/devices/androidTools'
import { getWin } from 'share/main/lib/window'
import * as updater from './lib/updater'
import * as screencastPreparation from './lib/screencastPreparation'
import log from 'share/common/log'
import 'share/main'
import { randomUUID } from 'node:crypto'
import { getUserDataPath } from 'share/main/lib/util'
import { createAutomationRuntime } from './automation/runtime'
import { startAutomationServer } from './automation/server'
import { attachAutomationLifecycle } from './automation/lifecycle'

const logger = log('main')
logger.info('start')

app.on('ready', () => {
  logger.info('app ready')

  updater.init()
  terminal.init()
  hdc.init()
  const instanceId = randomUUID()
  const service = createAutomationRuntime(instanceId, app.getVersion())
  attachAutomationLifecycle(app, () => {
    return startAutomationServer({ profilePath: getUserDataPath(''), instanceId, recoverStaleLock: true, dispatch: service.dispatch })
  }, code => logger.error(code))
  screencastPreparation.init()
  main.showWin()
  const iosWorkspace = initIosWorkspace(getWin('main').webContents, devices.getCurrentDevice)
  const reconcileWdaTools = initIosWdaTools(devices.getCurrentDevice)
  devices.init(async () => {
    await Promise.all([iosWorkspace.stopAll(), disposeAndroidTools()])
  }, targets => {
    iosWorkspace.reconcile(targets)
    reconcileWdaTools(targets)
  })
  initAndroidTools(getWin('main').webContents)
  menu.init()
})
