import type { CSSProperties } from 'react'
import { observer } from 'mobx-react-lite'
import { brandArtwork } from './brandArtwork'
import Style from './Devices.module.scss'

type Brand = keyof typeof brandArtwork
type DeviceIdentity = { platform?: string; brand?: string; name: string }

const brands: [Brand, RegExp][] = [
  ['xiaomi', /^(?:xiaomi|redmi|poco)(?:\b|\d)|^(?:小米|红米)/],
  ['huawei', /^huawei\b|^华为/],
  ['honor', /^honor(?:\b|\d)|^荣耀/],
  ['samsung', /^samsung\b|^三星/],
  ['google', /^google\b|^谷歌/],
  ['oneplus', /^one\s?plus(?:\b|\d)|^一加/],
  ['oppo', /^oppo(?:\b|\d)/],
  ['vivo', /^(?:vivo|iqoo)(?:\b|\d)/],
  ['motorola', /^(?:motorola|moto)\b|^摩托罗拉/],
  ['sony', /^sony\b|^索尼/],
  ['asus', /^asus\b|^华硕/],
]

const models: [Brand, RegExp][] = [
  ['xiaomi', /^mi\s*(?:\d|mix\b|max\b|note\b|pad\b)/],
  ['samsung', /^(?:galaxy\b|sm [a-z]\d{3})/],
  ['google', /^pixel(?:\b|\d)/],
  ['huawei', /^(?:mate|nova|pura)\s*\d/],
  ['sony', /^xperia\b/],
  ['asus', /^(?:zenfone|rog phone)(?:\b|\d)/],
]

function normalize(value: string) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/[_-]+/g, ' ')
}

export function deviceBrand({ platform, brand, name }: DeviceIdentity): Brand | undefined {
  if (platform === 'ios') return 'apple'
  const manufacturer = normalize(brand || '')
  const model = normalize(name)
  return brands.find(([, pattern]) => pattern.test(manufacturer))?.[0]
    ?? brands.find(([, pattern]) => pattern.test(model))?.[0]
    ?? models.find(([, pattern]) => pattern.test(model))?.[0]
}

export default observer(function DeviceIcon({ device }: { device: DeviceIdentity }) {
  const brand = deviceBrand(device)
  const artwork = brand && brandArtwork[brand]
  return <span className={Style.deviceIcon} aria-hidden="true" data-brand={brand}>
    {artwork ? <svg viewBox="0 0 24 24" style={{ '--brand-ink': artwork.color } as CSSProperties}>
      <path d={artwork.path} />
    </svg> : <span className="icon-phone" />}
  </span>
})
