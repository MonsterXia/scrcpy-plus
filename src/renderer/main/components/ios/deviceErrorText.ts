import { t } from 'common/util'

// Electron prefixes a rejected invoke with its channel and the error name.
export function deviceErrorText(error: string) {
  switch (error.split(': ').pop()) {
    case 'cancelled': return ''
    case 'device-locked': return t('iosToolsLocked')
    case 'trust-computer': return t('iosToolsTrust')
    case 'disconnected': return t('iosToolsDisconnected')
    case 'developer-services': return t('iosToolsDeveloper')
    case 'file-access': return t('iosToolsFileError')
    case 'app-unavailable': return t('iosToolsAppError')
    case 'process-changed': return t('iosToolsProcessChanged')
    case 'install-failed': return t('iosToolsInstallError')
    case 'helper-unavailable': return t('iosSetupHelperMissing')
    case 'timeout': return t('iosToolsTimeout')
    case 'result-limit': return t('iosToolsLimit')
    case 'busy': return t('iosToolsBusy')
    default: return t('iosToolsError')
  }
}
