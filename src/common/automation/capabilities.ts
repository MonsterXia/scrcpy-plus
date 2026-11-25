import type { ITarget } from '../types'
export interface Capability { supported: boolean; available: boolean; reason?: string }
const platformOperations: Record<string, readonly string[]> = {
  'sessions.start': ['android', 'harmony', 'ios'],
  'screen.capture': ['android', 'harmony', 'ios'],
  'input.tap': ['android', 'harmony', 'ios'], 'input.swipe': ['android', 'harmony', 'ios'],
  'input.scroll': ['android', 'harmony', 'ios'], 'input.text': ['android', 'harmony', 'ios'], 'input.key': ['android', 'harmony', 'ios'],
  'screen.snapshot': ['android', 'harmony'], 'webviews.list': ['android'],
  'apps.start': ['android', 'harmony'], 'apps.stop': ['android', 'harmony'], 'apps.install': ['android', 'harmony'], 'apps.uninstall': ['android', 'harmony'], 'apps.clear-data': ['android', 'harmony'], 'apps.clear-cache': ['android', 'harmony'],
  'overview.get': ['android', 'harmony', 'ios'], 'apps.list': ['android', 'harmony'], 'apps.info': ['android', 'harmony'], 'apps.top': ['android', 'harmony'], 'processes.list': ['android', 'harmony'], 'logs.capture': ['android', 'harmony'], 'layout.dump': ['android', 'harmony'], 'shell.run': ['android', 'harmony'], 'ports.list': ['harmony'], 'ports.add': ['harmony'], 'ports.remove': ['harmony'],
}
export function deviceCapabilities(target: Pick<ITarget, 'key' | 'platform' | 'state' | 'transport'>, enabled: ReadonlySet<string>, running = false): Record<string, Capability> {
  return Object.fromEntries(Object.entries(platformOperations).map(([operation, platforms]) => {
    const needsFrame = operation.startsWith('input.') || operation === 'screen.capture'
    const sessionReady = running && (needsFrame || operation === 'sessions.start')
    const receiverStart = operation === 'sessions.start' && target.key === 'ios:airplay-receiver'
    if ((operation.startsWith('input.') || operation === 'overview.get') && target.platform === 'ios' && target.transport !== 'usb') return [operation, { supported: false, available: false, reason: 'platform-unsupported' }]
    if (!target.platform || !platforms.includes(target.platform)) return [operation, { supported: false, available: false, reason: 'platform-unsupported' }]
    if (!enabled.has(operation)) return [operation, { supported: false, available: false, reason: 'not-implemented' }]
    if (target.state !== 'ready' && !receiverStart && !sessionReady) return [operation, { supported: true, available: false, reason: target.state || 'unavailable' }]
    if (needsFrame && !running) return [operation, { supported: true, available: false, reason: 'session-required' }]
    return [operation, { supported: true, available: true }]
  }))
}
