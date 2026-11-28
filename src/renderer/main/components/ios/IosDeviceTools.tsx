import { useCallback, useEffect, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { t } from 'common/util'
import type { IosAppRow, IosFileRow, IosLogRow, IosProcessRow, IosWorkspaceRequest } from 'common/iosWorkspace'
import { deviceErrorText } from './deviceErrorText'
import ConfirmDialog from '../workspace/ConfirmDialog'
import Style from './IosDeviceTools.module.scss'

type DevicePanel = 'application' | 'process' | 'shell' | 'hilog'
interface Props { deviceKey: string; panel: DevicePanel }

// Track every request until completion so leaving the page also cancels a file picker or log stream.
function useDeviceRequests(key: string) {
  const pending = useRef(new Set<string>())
  useEffect(() => {
    const ids = pending.current
    return () => {
      for (const id of ids) void main.cancelIosWorkspace(id).catch(() => {})
      ids.clear()
    }
  }, [key])
  return useCallback(async <R extends IosWorkspaceRequest>(request: R, id = window.crypto.randomUUID()) => {
    pending.current.add(id)
    try {
      const result = await main.runIosWorkspace(key, request, id)
      if (!pending.current.has(id)) throw Error('cancelled')
      return result
    } finally {
      pending.current.delete(id)
    }
  }, [key])
}

const Logs = observer(function Logs({ deviceKey }: { deviceKey: string }) {
  const [rows, setRows] = useState<IosLogRow[]>([])
  const [streaming, setStreaming] = useState(true)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    if (!streaming) return
    const id = window.crypto.randomUUID()
    let active = true
    const off = main.on('ios:workspaceLogs', (source: string, batch: IosLogRow[]) => {
      if (source === id && active) setRows(old => old.concat(batch).slice(-1000))
    })
    setError('')
    void main.runIosWorkspace(deviceKey, { op: 'logs' }, id)
      .catch(cause => { if (active) setError(String(cause)) })
      .finally(() => { if (active) setStreaming(false) })
    return () => {
      active = false
      off()
      void main.cancelIosWorkspace(id).catch(() => {})
    }
  }, [deviceKey, streaming])
  const alert = error && deviceErrorText(error)
  const match = query.trim().toLowerCase()
  const lines = rows.map(row => [row.timestamp, row.process, row.pid, row.level, row.message].join('  '))
    .filter(line => line.toLowerCase().includes(match))
  return <section className={Style.page} data-ios-tool="hilog">
    <h1>{t('iosDeviceLogs')}</h1>
    <div className={Style.toolbar}>
      <Filter value={query} change={setQuery} />
      <button onClick={() => setStreaming(!streaming)}>{t(streaming ? 'iosToolsPause' : 'iosToolsResume')}</button>
      <button disabled={!rows.length} onClick={() => setRows([])}>{t('iosToolsClear')}</button>
    </div>
    {alert && <p role="alert">{alert}</p>}
    <pre className={Style.logs} tabIndex={0}>{lines.length ? lines.join('\n') :
      t(query ? 'iosToolsNoMatch' : streaming ? 'iosToolsWaitingLogs' : 'iosToolsNoLogs')}</pre>
  </section>
})

function Filter({ value, change }: { value: string; change: (value: string) => void }) {
  return <input type="search" aria-label={t('iosToolsFilter')} placeholder={t('iosToolsFilter')}
    value={value} onChange={event => change(event.target.value)} />
}

const Files = observer(function Files({ deviceKey }: { deviceKey: string }) {
  const run = useDeviceRequests(deviceKey)
  const [apps, setApps] = useState<IosAppRow[]>([])
  const [bundleId, setBundle] = useState('')
  const [path, setPath] = useState('/')
  const [revision, setRevision] = useState(0)
  const [files, setFiles] = useState<IosFileRow[]>([])
  const [error, setError] = useState('')
  const [appError, setAppError] = useState('')
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    let active = true
    setAppError('')
    void run({ op: 'apps' }).then(list => { if (active) setApps(list.filter(app => app.fileSharing)) })
      .catch(cause => { if (active) setAppError(String(cause)) })
    return () => { active = false }
  }, [run, revision])
  useEffect(() => {
    let active = true
    const id = window.crypto.randomUUID()
    setBusy(true)
    setFiles([])
    setError('')
    void run({ op: 'files', path, ...(bundleId ? { bundleId } : {}) }, id)
      .then(list => { if (active) setFiles(list.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))) })
      .catch(cause => { if (active) setError(String(cause)) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false; void main.cancelIosWorkspace(id).catch(() => {}) }
  }, [run, bundleId, path, revision])
  return <section className={Style.page} data-ios-tool="shell">
    <h1>{t('iosDeviceFiles')}</h1><p>{t('iosToolsFilesHint')}</p>
    <div className={Style.toolbar}>
      <select aria-label={t('iosToolsLocation')} value={bundleId} onChange={e => { setBundle(e.target.value); setPath('/') }}>
        <option value="">{t('iosToolsMedia')}</option>
        {apps.map(app => <option key={app.bundleId} value={app.bundleId}>{app.name} ({app.bundleId})</option>)}
      </select>
      <button disabled={path === '/'} onClick={() => setPath(path.slice(0, path.lastIndexOf('/')) || '/')}>{t('iosToolsParent')}</button>
      <button disabled={busy} onClick={() => setRevision(n => n + 1)}>{t('refresh')}</button>
    </div>
    <code>{path}</code>
    {(error || appError) && <p role="alert">{deviceErrorText(error || appError)}</p>}
    {busy ? <p role="status">{t('iosToolsLoading')}</p> : !error && !files.length ? <p>{t('iosToolsEmpty')}</p> :
      <ul>{files.map(file => <li key={file.name}>
        {file.isDirectory ? <button onClick={() => setPath((path === '/' ? '' : path) + '/' + file.name)}>{file.name} /</button>
          : <><span>{file.name}</span><small>{t('iosToolsBytes', { size: file.size })}</small></>}
      </li>)}</ul>}
  </section>
})

type Mutation = { op: 'install' } | { op: 'launch' | 'uninstall'; bundleId: string } | { op: 'terminate'; bundleId: string; pid: number }
const Lists = observer(function Lists({ deviceKey, panel }: Props) {
  const run = useDeviceRequests(deviceKey)
  const applications = panel === 'application'
  const [apps, setApps] = useState<IosAppRow[]>([])
  const [processes, setProcesses] = useState<IosProcessRow[]>([])
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<{ request: Mutation; name: string }>()
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    setBusy(true)
    setError('')
    setApps([])
    setProcesses([])
    const read = applications ? run({ op: 'apps' }).then(list => { if (active) setApps(list.sort((a,b) => a.name.localeCompare(b.name))) }) :
      run({ op: 'processes' }).then(list => { if (active) setProcesses(list.sort((a,b) => a.pid - b.pid)) })
    void read.catch(cause => { if (active) setError(String(cause)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [run, applications, revision])
  async function apply(request: Mutation) {
    setConfirm(undefined)
    setBusy(true)
    setNotice('')
    setError('')
    try {
      await run(request)
      setNotice(t('iosToolsDone'))
      setRevision(n => n + 1)
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  const alert = error && deviceErrorText(error)
  const match = query.trim().toLowerCase()
  const selectedApps = apps.filter(a => (a.name + ' ' + a.bundleId).toLowerCase().includes(match))
  const selectedProcesses = processes.filter(p => (p.pid + ' ' + p.name + ' ' + (p.bundleId || '')).toLowerCase().includes(match))
  const action = t(confirm?.request.op === 'terminate' ? 'iosToolsTerminate' : 'iosToolsUninstall')
  return <section className={Style.page} data-ios-tool={panel} aria-busy={busy}>
    <h1>{t(applications ? 'application' : 'process')}</h1>
    <div className={Style.toolbar}><Filter value={query} change={setQuery} />
      <button disabled={busy} onClick={() => setRevision(n => n + 1)}>{t('refresh')}</button>
      {applications && <button disabled={busy} onClick={() => void apply({ op: 'install' })}>{t('iosToolsInstall')}</button>}
    </div>
    {alert && <p role="alert">{alert}</p>}
    {(busy || notice) && <p role="status">{busy ? t('iosToolsLoading') : notice}</p>}
    {!busy && !error && !(applications ? selectedApps : selectedProcesses).length && <p>{t('iosToolsNoMatch')}</p>}
    <ul>{applications ? selectedApps.map(app => <li key={app.bundleId}>
      <div><strong>{app.name}</strong><small>{[app.bundleId, app.version].filter(Boolean).join(' · ')}</small></div>
      <span className={Style.actions}>
        <button disabled={busy} onClick={() => void apply({ op: 'launch', bundleId: app.bundleId })}>{t('iosToolsLaunch')}</button>
        {app.user && <button disabled={busy} onClick={() => setConfirm({ name: app.name, request: { op: 'uninstall', bundleId: app.bundleId } })}>{t('iosToolsUninstall')}</button>}
      </span>
    </li>) : selectedProcesses.map(process => <li key={process.pid}>
      <div><strong>{process.name}</strong><small>{[t('iosToolsPid', { pid: process.pid }), process.bundleId].filter(Boolean).join(' · ')}</small></div>
      {process.bundleId && <button disabled={busy} onClick={() => setConfirm({ name: process.name + ' (PID ' + process.pid + ')',
        request: { op: 'terminate', pid: process.pid, bundleId: process.bundleId! } })}>{t('iosToolsTerminate')}</button>}
    </li>)}</ul>
    <ConfirmDialog visible={!!confirm} title={action} confirmLabel={action}
      message={t(confirm?.request.op === 'terminate' ? 'iosToolsConfirmTerminate' : 'iosToolsConfirmUninstall', { name: confirm?.name || '' })}
      onConfirm={() => { if (confirm) void apply(confirm.request) }} onCancel={() => setConfirm(undefined)} />
  </section>
})

export default function IosDeviceTools(props: Props) {
  if (props.panel === 'hilog') return <Logs deviceKey={props.deviceKey} />
  if (props.panel === 'shell') return <Files deviceKey={props.deviceKey} />
  return <Lists {...props} />
}
