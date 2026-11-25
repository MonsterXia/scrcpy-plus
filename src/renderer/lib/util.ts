import { t } from 'common/util'
import isEmpty from 'licia/isEmpty'
import { isObservable, toJS } from 'mobx'
import { notify } from 'share/renderer/lib/util'
import escape from 'licia/escape'

export async function installDroppedBundles(connectKey: string | undefined, files: Iterable<File>) {
  if (!connectKey) {
    notify(t('installDropNoDevice'), { icon: 'error' })
    return false
  }
  const extension = connectKey.startsWith('android:') ? '.apk' : '.hap'
  const paths: string[] = []
  let unreadable = false
  for (const file of files) {
    try {
      const path = preload.getPathForFile(file)
      if (path.toLowerCase().endsWith(extension)) paths.push(path)
    } catch {
      unreadable = true
    }
  }
  if (unreadable) notify(t('installDropReadFailed'), { icon: 'error' })
  if (paths.length === 0) {
    if (!unreadable) notify(t(extension === '.apk' ? 'apkDropUnsupported' : 'installDropUnsupported'), { icon: 'error' })
    return false
  }
  return installBundles(connectKey, paths)
}

export async function setMainStore(name: string, val: any) {
  await main.setMainStore(name, isObservable(val) ? toJS(val) : val)
}

export async function installBundles(connectKey: string, packagePaths?: string[]) {
  let hasSuccess = false

  if (!packagePaths) {
    const android = connectKey.startsWith('android:')
    const { filePaths } = await main.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: t(android ? 'apkFile' : 'hapFile'), extensions: [android ? 'apk' : 'hap'] }],
    })
    if (isEmpty(filePaths)) {
      return hasSuccess
    }
    packagePaths = filePaths
  }

  for (const filePath of packagePaths) {
    notify(escape(t('bundleInstalling', { path: filePath })), { icon: 'info' })
    try {
      await main.installBundle(connectKey, filePath)
      hasSuccess = true
      notify(escape(t('bundleInstalled', { path: filePath })), { icon: 'success' })
    } catch {
      notify(t('installBundleErr'), { icon: 'error' })
    }
  }

  return hasSuccess
}
