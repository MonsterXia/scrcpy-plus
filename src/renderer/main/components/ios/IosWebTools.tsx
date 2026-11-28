import { useEffect, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t } from 'common/util'
import type { IosWebPage } from 'common/iosWorkspace'
import { deviceErrorText } from './deviceErrorText'
import Style from './IosWebTools.module.scss'

type Request = { op: 'webPages' } | { op: 'webDom'; targetId: string }

function errorText(error: string) {
  if (error.endsWith('web-unavailable')) return t('iosWebDisabled')
  if (error.endsWith('web-busy')) return t('iosWebBusy')
  if (error.endsWith('web-stale')) return t('iosWebStale')
  if (error.endsWith('device-locked')) return t('iosSetupUnlock')
  if (error.endsWith('trust-computer')) return t('iosSetupTrustComputer')
  if (error.endsWith('timeout')) return t('iosSetupTimeout')
  return deviceErrorText(error)
}

export default observer(function IosWebTools({ deviceKey }: { deviceKey: string }) {
  const [request, setRequest] = useState<Request>({ op: 'webPages' })
  const [pages, setPages] = useState<IosWebPage[]>([])
  const [markup, setMarkup] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const selected = request.op === 'webDom'
    ? pages.find(page => page.targetId === request.targetId)
    : undefined

  function read(next: Request) {
    setError('')
    setLoading(true)
    setMarkup('')
    setTruncated(false)
    if (next.op === 'webPages') setPages([])
    setRequest(next)
  }

  useEffect(() => {
    const id = window.crypto.randomUUID()
    let active = true
    let pending = true
    async function run() {
      try {
        if (request.op === 'webPages') {
          const rows = await main.runIosWorkspace(deviceKey, request, id)
          if (active) setPages(rows)
        } else {
          const rows = await main.runIosWorkspace(deviceKey, request, id)
          if (active) {
            setMarkup(rows.map(row => row.html).join(''))
            setTruncated(rows.some(row => row.truncated))
          }
        }
      } catch (cause) {
        if (active) setError(String(cause))
      } finally {
        pending = false
        if (active) setLoading(false)
      }
    }
    void run()
    return () => {
      active = false
      if (pending) void main.cancelIosWorkspace(id).catch(() => {})
    }
  }, [deviceKey, request])

  return (
    <section className={Style.page} data-ios-web aria-busy={loading}>
      <header className={Style.header}>
        <div>
          <h1>{t('webview')}</h1>
          <p>{t('iosWebDescription')}</p>
        </div>
        <button type="button" disabled={loading && request.op === 'webPages'}
          onClick={() => read({ op: 'webPages' })}>{t('iosWebRefreshPages')}</button>
      </header>
      {error && <p className={Style.error} role="alert">{errorText(error)}</p>}
      {loading && request.op === 'webPages' &&
        <p className={Style.hint} role="status">{t('webviewReading')}</p>}
      {!loading && !error && !pages.length &&
        <p className={Style.hint}>{t('iosWebEmpty')}</p>}
      {pages.length === 128 && <p className={Style.hint}>{t('iosWebPageLimit')}</p>}
      {pages.length > 0 && (
        <div className={Style.body}>
          <ul className={Style.pages} aria-label={t('iosWebPages')}>
            {pages.map(page => (
              <li key={page.targetId}>
                <button type="button" aria-pressed={selected?.targetId === page.targetId}
                  onClick={() => read({ op: 'webDom', targetId: page.targetId })}>
                  <strong>{page.title || t('iosWebUntitled')}</strong>
                  <span>{page.app}</span>
                  <small>{page.url}</small>
                </button>
              </li>
            ))}
          </ul>
          <section className={Style.document} aria-label={t('iosWebDocument')}>
            <div className={Style.documentHeader}>
              <h2>{t('iosWebDocument')}</h2>
              {selected && <button type="button" disabled={loading}
                onClick={() => read({ op: 'webDom', targetId: selected.targetId })}>
                {t('iosWebRefreshDom')}
              </button>}
            </div>
            {selected ? (
              <>
                <p className={Style.identity}>{selected.title || selected.url || t('iosWebUntitled')}</p>
                {loading && <p className={Style.hint} role="status">{t('iosWebReadingDom')}</p>}
                {!loading && !error && <pre tabIndex={0}>{markup}</pre>}
                {truncated && <p className={Style.hint}>{t('iosWebTruncated')}</p>}
              </>
            ) : <p className={Style.hint}>{t('iosWebSelect')}</p>}
          </section>
        </div>
      )}
    </section>
  )
})
