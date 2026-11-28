const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { setup, load, React } = require('./helpers/workspace-renderer.cjs')
const createRoot = setup()
const { act } = React
const locales = ['en-US', 'zh-CN']

for (const locale of locales) {
  test(`iOS capture switches device, highlights screen-point bounds and saves the displayed PNG (${locale})`, async () => {
    const calls = [], cancelled = [], files = []
    const dictionary = require(`../src/common/langs/${locale}.json`)
    const t = (key, params = {}) => dictionary[key]?.replace(/{{(\w+)}}/g, (_, k) => params[k]) || key
    const main = {
      iosWdaSnapshot(key, panel, id) { return new Promise(resolve => calls.push({ key, panel, id, resolve })) },
      cancelIosWdaSnapshot: async id => { cancelled.push(id) },
      showSaveDialog: async () => ({ filePath: '/fixture/selected.png' }),
    }
    const View = load('src/renderer/main/components/ios/IosWdaTools.tsx', {
      'common/util': { t }, '../common/loading': { PannelLoading: () => null },
    }, { main, crypto: { randomUUID }, node: { writeFile: async (...args) => { files.push(args) } } }).default
    const host = document.createElement('div'), root = createRoot(host)
    const render = (deviceKey, panel) => act(() => root.render(React.createElement(View, { deviceKey, panel })))
    const snapshot = { png: 'aGVsbG8=', width: 800, height: 1200, screenWidth: 400, screenHeight: 600 }
    try {
      await render('ios:A', 'layout')
      await render('ios:B', 'layout')
      assert.deepEqual(cancelled, [calls[0].id])
      await act(() => calls[0].resolve({ ...snapshot, elements: [{ name: 'Old phone', type: 'Application', depth: 0 }] }))
      assert.ok(!host.textContent.includes('Old phone'))
      const rect = { x: 12, y: 40, width: 100, height: 32 }
      await act(() => calls[1].resolve({ ...snapshot, elements: [{ name: 'Continue', type: 'Button', depth: 0, rect }] }))
      await act(() => host.querySelector('button[aria-pressed]').click())
      assert.equal(host.querySelector('svg').getAttribute('viewBox'), '0 0 400 600')
      assert.equal(host.querySelector('rect').getAttribute('width'), '100')
      assert.ok(host.textContent.includes(t('iosLayoutBounds', rect)))
      await render('ios:B', 'screenshot')
      await act(() => calls[2].resolve(snapshot))
      const button = Array.from(host.querySelectorAll('button')).find(el => el.textContent === t('save'))
      await act(() => button.click())
      assert.deepEqual(files, [['/fixture/selected.png', snapshot.png, 'base64']])
    } finally {
      await act(() => root.unmount())
    }
  })
}
