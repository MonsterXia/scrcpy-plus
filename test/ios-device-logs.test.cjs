const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setup, load, React } = require('./helpers/workspace-renderer.cjs')

test('clearing a live iPhone log invalidates pending batches without pausing the new stream', async t => {
  const createRoot = setup()
  const requests = [], listeners = new Set(), cancelled = []
  const main = {
    on(_channel, callback) { listeners.add(callback); return () => listeners.delete(callback) },
    runIosWorkspace(_key, _request, id) { return new Promise(resolve => requests.push({ id, resolve })) },
    async cancelIosWorkspace(id) { cancelled.push(id) },
  }
  const Tools = load('src/renderer/main/components/ios/IosDeviceTools.tsx', {
    'common/util': { t: key => key }, '../workspace/ConfirmDialog': () => null,
  }, { main }).default
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  t.after(async () => { await React.act(async () => root.unmount()); element.remove() })
  const send = (id, message) => { for (const listener of listeners) listener(id, [{ message }]) }
  await React.act(async () => root.render(React.createElement(Tools, { deviceKey: 'ios:test', panel: 'hilog' })))
  const first = requests[0]
  await React.act(async () => send(first.id, 'before clear'))
  await React.act(async () => {
    [...element.querySelectorAll('button')].find(b => b.textContent === 'iosToolsClear').click()
    send(first.id, 'batched before clear')
  })
  assert.deepEqual(cancelled, [first.id])
  await React.act(async () => { first.resolve([]); send(first.id, 'late'); send(requests[1].id, 'fresh') })
  const logs = element.querySelector('pre').textContent
  assert.match(logs, /fresh/); assert.doesNotMatch(logs, /before clear|late/)
})
