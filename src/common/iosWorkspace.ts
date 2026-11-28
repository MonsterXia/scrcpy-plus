export interface IosAppRow {
  bundleId: string
  name: string
  version: string
  user: boolean
  fileSharing?: boolean
}
export interface IosProcessRow { pid: number; name: string; bundleId?: string }
export interface IosFileRow { name: string; isDirectory: boolean; size?: number }
export interface IosLogRow { timestamp: string; process: string; pid: number; level: string; message: string }
export interface IosWebPage { targetId: string; app: string; title: string; url: string }
export interface IosWebDom { html: string; truncated: boolean }

export type IosWorkspaceRequest =
  | { op: 'apps' | 'processes' | 'logs' | 'webPages' | 'install' }
  | { op: 'files'; path: string; bundleId?: string }
  | { op: 'launch' | 'uninstall'; bundleId: string }
  | { op: 'terminate'; pid: number; bundleId: string }
  | { op: 'webDom'; targetId: string }

export interface IosWorkspaceRows {
  apps: IosAppRow
  processes: IosProcessRow
  files: IosFileRow
  logs: IosLogRow
  webPages: IosWebPage
  webDom: IosWebDom
  install: never
  launch: never
  uninstall: never
  terminate: never
}

export type RunIosWorkspace = <R extends IosWorkspaceRequest>(
  key: string, request: R, id: string,
) => Promise<IosWorkspaceRows[R['op']][]>
