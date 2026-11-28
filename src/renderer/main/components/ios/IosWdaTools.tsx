import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import type { IosWdaPanel, IosWdaSnapshot } from 'common/iosWdaTools'
import { t } from 'common/util'
import { PannelLoading } from '../common/loading'
import Style from './IosWdaTools.module.scss'

type Props = { deviceKey: string; panel: IosWdaPanel }

export default function IosWdaTools(props: Props) {
  return <SnapshotPanel key={props.deviceKey + props.panel} {...props} />
}

const SnapshotPanel = observer(function SnapshotPanel({ deviceKey, panel }: Props) {
  const [snapshot, setSnapshot] = useState<IosWdaSnapshot>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'capture' | 'save'>()
  const [selected, setSelected] = useState<number>()
  const request = useRef<string | undefined>(undefined)
  const mounted = useRef(false)
  const list = useRef<HTMLDivElement>(null)
  const layout = panel === 'layout'
  const element = selected !== undefined ? snapshot?.elements?.[selected] : undefined
  const bounds = element?.rect

  const cancel = useCallback(() => {
    if (request.current) {
      void main.cancelIosWdaSnapshot(request.current).catch(() => {})
      request.current = undefined
    }
  }, [])

  const capture = useCallback(async () => {
    if (request.current) return
    const id = crypto.randomUUID()
    request.current = id
    setLoading(true)
    setError(undefined)
    try {
      const result = await main.iosWdaSnapshot(deviceKey, panel, id)
      if (request.current !== id) return
      setSnapshot(result)
      setSelected(undefined)
    } catch {
      if (request.current === id) setError('capture')
    } finally {
      if (request.current === id) {
        request.current = undefined
        setLoading(false)
      }
    }
  }, [deviceKey, panel])

  useEffect(() => {
    mounted.current = true
    void capture()
    return () => { mounted.current = false; cancel() }
  }, [capture, cancel])

  async function save() {
    if (!snapshot || saving) return
    setSaving(true)
    setError(undefined)
    try {
      const result = await main.showSaveDialog({
        defaultPath: 'screenshot.png', filters: [{ name: 'PNG', extensions: ['png'] }],
      })
      if (mounted.current && !result.canceled && result.filePath) await node.writeFile(result.filePath, snapshot.png, 'base64')
    } catch {
      if (mounted.current) setError('save')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  function pick(event: React.MouseEvent<SVGSVGElement>) {
    if (!snapshot?.elements) return
    const matrix = event.currentTarget.getScreenCTM()
    if (!matrix) return
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    let match = -1, depth = -1
    snapshot.elements.forEach(({ rect, depth: level }, index) => {
      if (rect && level >= depth && point.x >= rect.x && point.x < rect.x + rect.width &&
          point.y >= rect.y && point.y < rect.y + rect.height) {
        match = index
        depth = level
      }
    })
    setSelected(match >= 0 ? match : undefined)
    list.current?.children[match]?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <section className={Style.panel} data-ios-wda-panel={panel}>
      <header className={Style.header}>
        <h1>{t(layout ? 'layout' : 'screenshot')}</h1>
        <div>
          {!layout && <button type="button" disabled={!snapshot || saving} onClick={() => void save()}>{t('save')}</button>}
          {loading
            ? <button type="button" onClick={() => { cancel(); setLoading(false) }}>{t('cancel')}</button>
            : <button type="button" className={Style.primary} onClick={() => void capture()}>{t(layout ? 'refresh' : 'recapture')}</button>}
        </div>
      </header>
      {error && <p role="alert" className={Style.error}>{t(error === 'save' ? 'iosScreenshotSaveFailed' : 'iosWdaSnapshotFailed')}</p>}
      <div className={Style.body} aria-busy={loading}>
        {snapshot ? (
          <>
            <figure className={Style.preview}>
              <svg viewBox={`0 0 ${snapshot.screenWidth} ${snapshot.screenHeight}`} role="img" aria-label={t('screenshot')} onClick={layout ? pick : undefined}>
                <image width={snapshot.screenWidth} height={snapshot.screenHeight} href={`data:image/png;base64,${snapshot.png}`} preserveAspectRatio="none" />
                {bounds && <rect {...bounds} className={Style.highlight} vectorEffect="non-scaling-stroke" />}
              </svg>
              <figcaption>
                {element ? [element.type, element.name, element.label !== element.name && element.label].filter(Boolean).join(' · ') : `${snapshot.width} × ${snapshot.height} · PNG`}
                {bounds && <span>{t('iosLayoutBounds', bounds)}</span>}
              </figcaption>
            </figure>
            {snapshot.elements && <section className={Style.tree}>
              <h2>{t('layoutTree')}</h2>
              <div ref={list} className={Style.rows}>
                {snapshot.elements.map((item, i) => (
                  <button key={i} type="button" aria-pressed={selected === i} onClick={() => setSelected(i)}
                    style={{ paddingInlineStart: 10 + Math.min(12, item.depth) * 12 }}>
                    <span>{item.type}</span>
                    {(item.name || item.label) && <strong>{item.name || item.label}</strong>}
                  </button>
                ))}
              </div>
            </section>}
          </>
        ) : loading ? <PannelLoading showLabel /> : <p className={Style.empty}>{t(layout ? 'layoutEmpty' : 'workspaceNoScreenshot')}</p>}
      </div>
    </section>
  )
})
