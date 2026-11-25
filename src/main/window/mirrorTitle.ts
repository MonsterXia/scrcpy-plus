import type { ITarget, MirrorTarget } from 'common/types'

const platforms = { android: 'Android', harmony: 'HarmonyOS', ios: 'iOS' }

export function createMirrorTarget(target: ITarget, openTitles: string[]): MirrorTarget {
  const platform = platforms[target.platform ?? 'harmony']
  const [name, model] = [target.name, target.model].map(value => {
    const text = value?.trim()
    return text === target.key || text === target.connectionId ? undefined : text
  })
  const identity = target.platform === 'ios' ? [model, name] : [name, model]
  const base = [...new Set([...identity, platform].filter(Boolean))].join(' · ')
  const primary = name || model || platform
  const detail = [...new Set([model, platform])].filter(text => text && text !== primary).join(' · ')
  let prefix = ''
  let mirrorTitle = base
  // Allocate once per window so closing or rearranging its neighbours never renumbers it.
  for (let index = 2; openTitles.includes(mirrorTitle); index++) {
    prefix = `#${index} · `
    mirrorTitle = prefix + base
  }
  return { ...target, mirrorTitle, mirrorHeading: { name: prefix + primary, detail } }
}
