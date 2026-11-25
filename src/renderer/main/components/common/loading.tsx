import { observer } from 'mobx-react-lite'
import { t } from 'common/util'
import { StatusIcon } from '../../../components/MirrorStatus'
import Style from '../../../components/MirrorStatus.module.scss'

export const PannelLoading = observer(function PannelLoading({ showLabel = false }: { showLabel?: boolean }) {
  const label = t('workspaceLoading')
  return (
    <div className={`panel-loading ${Style.theme}`} role="status" aria-label={label}>
      <StatusIcon busy />
      {showLabel && <span>{label}</span>}
    </div>
  )
})
