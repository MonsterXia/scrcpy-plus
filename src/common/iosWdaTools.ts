export type IosWdaPanel = 'layout' | 'screenshot'

export interface IosElementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface IosLayoutElement {
  type: string
  name?: string
  label?: string
  rect?: IosElementRect
  depth: number
}

export interface IosWdaSnapshot {
  png: string
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  elements?: IosLayoutElement[]
}

export type IpcIosWdaSnapshot = (deviceKey: string, panel: IosWdaPanel, requestId: string) => Promise<IosWdaSnapshot>
export type IpcCancelIosWdaSnapshot = (requestId: string) => Promise<void>
