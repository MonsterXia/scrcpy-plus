import type { IosLayoutElement } from 'common/iosWdaTools'

// WDA returns the active application's XCTest snapshot in screen points.
// Keep device text as plain data and bound the amount sent to the renderer.
export function parseIosLayout(root: unknown): IosLayoutElement[] {
  const result: IosLayoutElement[] = []
  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== 'object' || depth > 128 || result.length >= 10000) {
      throw new Error('Invalid or oversized XCTest hierarchy')
    }
    const { type, name, label, rect, children } = value as Record<string, any>
    if (typeof type !== 'string' || !type || (children !== undefined && !Array.isArray(children))) {
      throw new Error('Invalid XCTest element')
    }
    const element: IosLayoutElement = { type: type.slice(0, 128), depth }
    if (typeof name === 'string' && name) element.name = name.slice(0, 512)
    if (typeof label === 'string' && label) element.label = label.slice(0, 512)
    if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0) {
      element.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    result.push(element)
    for (const child of children || []) visit(child, depth + 1)
  }
  visit(root, 0)
  return result
}
