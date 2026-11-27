const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setup, load, React } = require('./helpers/workspace-renderer.cjs')
const { observable, runInAction } = require('mobx')
const createRoot = setup()
const { act } = React
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('device badges prefer the reported manufacturer and recognize model families without matching arbitrary text', () => {
  const { deviceBrand } = load('src/renderer/main/components/devices/DeviceIcon.tsx')
  assert.equal(deviceBrand({ platform: 'ios', name: 'Work phone' }), 'apple')
  assert.equal(deviceBrand({ brand: 'SAMSUNG Electronics', name: 'Pixel 8' }), 'samsung')
  for (const [name, expected] of [
    ['Mi 10 Ultra', 'xiaomi'], ['Redmi Note 13', 'xiaomi'], ['POCO F6', 'xiaomi'],
    ['SM-G998B', 'samsung'], ['Pixel 9', 'google'], ['nova 15', 'huawei'],
    ['荣耀 Magic 7', 'honor'], ['iQOO 13', 'vivo'], ['OPPO Find X8', 'oppo'],
    ['OnePlus 12', 'oneplus'], ['moto g54', 'motorola'], ['Xperia 1 VI', 'sony'],
    ['ROG Phone 8', 'asus'], ['Milan', undefined], ['Mixing desk', undefined],
    ['Office Pixel Counter', undefined], ['Unknown', undefined],
  ]) assert.equal(deviceBrand({ platform: 'android', name }), expected, name)
})

test('device selection, partial failure, focus, retry and layout have independent scopes', async () => {
  const targets = [
    { key: 'a', name: 'Mi 10 Ultra', platform: 'android', state: 'ready', transport: 'usb' },
    { key: 'h', name: 'Harmony', platform: 'harmony', state: 'ready', transport: 'usb' },
    { key: 'locked', name: 'Locked', platform: 'android', state: 'unauthorized' },
    { key: 'iphone', name: 'iPhone', platform: 'ios', state: 'ready', transport: 'usb' },
    { key: 'ios:airplay-receiver', name: 'AirPlay', platform: 'ios', transport: 'receiver', state: 'waiting' },
  ]
  const store = observable({ targets, target: { key: 'h' }, discoveryErrors: [], panel: 'devices', refreshTargets: async () => {} })
  let sessions = [], failure = true, layout = 'side-by-side'
  const started = [], focused = [], layouts = []
  const main = {
    getMirrorSessions: async () => sessions.map(s => ({ ...s })), getMirrorLayout: async () => layout,
    showScreencast: async key => {
      started.push(key)
      if (key === 'h' && failure) throw Error('failed')
      sessions.push({ id: key, deviceKey: key, name: key, brand: key === 'a' ? 'Xiaomi' : undefined, platform: key === 'ios:airplay-receiver' ? 'ios' : 'android', state: key === 'ios:airplay-receiver' ? 'waiting' : 'running' })
    },
    focusMirror: async key => focused.push(key),
    applyMirrorLayout: async request => { layouts.push(request); layout = request.layout },
    stopMirrorSession: async id => { sessions = sessions.filter(s => s.id !== id) },
  }
  const Devices = load('src/renderer/main/components/devices/Devices.tsx', {
    '../../store': store, 'common/util': { t: (key, args) => key + (args ? JSON.stringify(args) : '') },
  }, { main, setInterval, clearInterval }).default
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const query = s => container.querySelector(s)
  const click = async s => { assert.ok(query(s), s); await act(async () => { query(s).click(); await tick() }) }
  try {
    await act(async () => { root.render(React.createElement(Devices)); await tick() })
    assert.deepEqual(Array.from(container.querySelectorAll('[data-layout]'), button => button.dataset.layout), ['independent', 'merged'])
    assert.equal(query('[data-layout="independent"]').getAttribute('aria-pressed'), 'true')
    assert.equal(container.querySelectorAll('[data-device-row]').length, 4)
    assert.ok(query('[data-device-row="a"] [data-brand="xiaomi"] svg'))
    assert.ok(query('[data-device-row="iphone"] [data-brand="apple"] svg'))
    assert.ok(query('[data-device-row="h"] .icon-phone'))
    assert.equal(query('[data-device-row="locked"] input').disabled, true)
    assert.equal(query('[data-device-row="iphone"] input').disabled, false)
    assert.equal(query('[data-action="start-selected"]').disabled, true)
    await click('[data-device-row="a"] input')
    await click('[data-device-row="h"] input')
    await click('[data-action="start-selected"]')
    assert.deepEqual(started, ['a', 'h'])
    assert.equal(store.target.key, 'h')
    assert.ok(query('[data-session-row="a"]'))
    assert.ok(query('[data-session-row="a"] [data-brand="xiaomi"] svg'))
    assert.ok(query('[data-device-row="h"] [role="alert"]'))
    assert.equal(query('[data-device-row="h"] input').checked, true)
    await click('[data-session-row="a"] [data-action="focus"]')
    assert.deepEqual(focused, ['a']); assert.deepEqual(started, ['a', 'h'])
    await click('[data-layout="merged"]')
    assert.equal(layouts[0].layout, 'merged'); assert.equal(layouts[0].deviceKeys, undefined)
    failure = false
    await click('[data-action="start-selected"]')
    assert.deepEqual(started, ['a', 'h', 'h']); assert.equal(sessions.length, 2)
    await click('[data-action="start-receiver"]')
    assert.equal(sessions.at(-1).state, 'waiting')
    // USB cleanup can finish between a failed stop IPC and the next session read.
    const stop = main.stopMirrorSession
    main.stopMirrorSession = async () => { throw Error('cleanup pending') }
    await click('[data-session-row="a"] [data-action="stop"]')
    assert.equal(query('[role="alert"]').textContent, 'plusStopFailed')
    assert.ok(query('[data-session-row="a"]'))
    await stop('a')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)) })
    assert.equal(query('[role="alert"]'), null)
    assert.equal(sessions.length, 2); assert.ok(query('[data-device-row="a"]'))
    await click('[data-device-row="a"] input')
    await act(async () => { runInAction(() => { store.targets = store.targets.filter(t => t.key !== 'a') }); await tick() })
    await act(async () => { runInAction(() => { store.targets.push(targets[0]) }); await tick() })
    assert.equal(query('[data-device-row="a"] input').checked, false)
  } finally { await act(async () => root.unmount()); container.remove() }
})
