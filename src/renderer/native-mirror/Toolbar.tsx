import { observer } from 'mobx-react-lite'
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import { t } from 'common/util'
import type { MirrorSession } from 'common/types'
import FloatingStyle from '../screencast/components/Toolbar.module.scss'
import MirrorToolsPanel, { MirrorToolsSelect } from '../screencast/components/MirrorToolsPanel'
import ToolbarToggle from '../screencast/components/ToolbarToggle'

interface IosTools {
  mode: MirrorSession['videoMode']
  busy: boolean
  connected: boolean
  onVideo: (enabled: boolean) => void
  onHome: () => void
  onSetup: () => void
}

interface AndroidTools {
  connected: boolean
  onKey: (keyCode: number) => void
}

export default observer(function Toolbar(props: IosTools | AndroidTools) {
  const ios = 'onSetup' in props ? props : undefined
  const { connected } = props
  const busy = ios?.busy ?? false
  const mode = ios?.mode
  const panelId = ios ? 'ios-mirror-tools' : 'android-mirror-tools'
  const transitioning = busy || mode === 'video-starting'
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const keyboardInteraction = useRef(false)
  useEffect(() => {
    if (!expanded || hovered || focused || busy) return
    const timer = setTimeout(() => setExpanded(false), 2000)
    return () => clearTimeout(timer)
  }, [expanded, hovered, focused, busy])

  return <div className={FloatingStyle.overlay}
    onMouseEnter={() => { setHovered(true) }}
    onMouseLeave={() => setHovered(false)}
    onPointerDownCapture={event => { keyboardInteraction.current = false; setFocused((event.target as HTMLElement).matches('select')) }}
    onFocusCapture={event => setFocused(keyboardInteraction.current || event.target.matches('select'))}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget) && !toggle.current?.contains(event.relatedTarget)) setFocused(false) }}
    onKeyDown={event => {
      keyboardInteraction.current = true; setFocused(true)
      if (event.key === 'Escape' && expanded) {
        event.preventDefault(); event.stopPropagation(); setExpanded(false); toggle.current?.focus()
      }
    }}>
    {createPortal(<div className={FloatingStyle.entry}>
      <ToolbarToggle ref={toggle} expanded={expanded}
        controls={panelId} onClick={() => setExpanded(!expanded)} />
    </div>, document.body)}
    <MirrorToolsPanel id={panelId} expanded={expanded} footer={ios && <>
      <span className={FloatingStyle.status} role="status"
        title={t(mode === 'video' ? 'plusIosVideoMode' : 'plusIosScreenshotMode')}>
        {transitioning ? t('plusSessionStarting') : mode === 'video' ? 'ReplayKit' : 'WDA'}
      </span>
      <MirrorToolsSelect label={t('plusIosMirrorMode')} disabled={transitioning || !connected}
        value={mode === 'video-starting' ? 'video' : mode || 'screenshot'}
        onChange={event => {
          ios.onVideo(event.currentTarget.value === 'video')
          if (!keyboardInteraction.current) setFocused(false)
        }}>
        {mode === 'video-error' && <option value="video-error" disabled>{t('plusIosChooseMode')}</option>}
        <option value="video">{t('plusIosVideoOption')}</option>
        <option value="screenshot">{t('plusIosScreenshotOption')}</option>
      </MirrorToolsSelect>
      {mode === 'video-error' && <p className={FloatingStyle.modeHint} role="alert">{t('plusIosVideoFailed')}</p>}
      {mode === 'screenshot' && <p className={FloatingStyle.modeHint}>{t('plusIosBroadcastHint')}</p>}
    </>}>
      {ios && <>
        <ToolbarIcon icon="circle" title={t('plusIosHome')} disabled={transitioning || !connected} onClick={ios.onHome} />
        <ToolbarIcon icon="setting" title={t('iosSetupTitle')} onClick={() => {
          toggle.current?.focus()
          setExpanded(false)
          ios.onSetup()
        }} />
      </>}
      {'onKey' in props && <>
        <ToolbarIcon icon="back" title={t('back')} disabled={!connected} onClick={() => props.onKey(4)} />
        <ToolbarIcon icon="circle" title={t('home')} disabled={!connected} onClick={() => props.onKey(3)} />
        <ToolbarIcon icon="volume" title={t('volumeUp')} disabled={!connected} onClick={() => props.onKey(24)} />
        <ToolbarIcon icon="volume-down" title={t('volumeDown')} disabled={!connected} onClick={() => props.onKey(25)} />
      </>}
    </MirrorToolsPanel>
  </div>
})
