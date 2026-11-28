const { test } = require('node:test')
const assert = require('node:assert/strict')
const { setup, load, React } = require('./helpers/workspace-renderer.cjs')

test('selecting a page reads its DOM as inert text and cancels obsolete requests', async () => {
  const createRoot = setup()
  const requests = []
  const cancelled = []
  const main = {
    runIosWorkspace(device, request, id) {
      return new Promise(resolve => requests.push({ device, request, id, resolve }))
    },
    async cancelIosWorkspace(id) { cancelled.push(id) },
  }
  const { default: WebTools } = load('src/renderer/main/components/ios/IosWebTools.tsx', {
    'common/util': { t: key => key },
  }, { main })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let mounted = true
  try {
    await React.act(async () => root.render(React.createElement(WebTools, { deviceKey: 'ios:usb-test' })))
    assert.equal(requests[0].device, 'ios:usb-test')
    assert.equal(requests[0].request.op, 'webPages')
    const page = id => ({ targetId: id, title: 'Example ' + id, url: 'https://example.test', app: 'Safari' })
    await React.act(async () => requests[0].resolve([page('PID:1:1'), page('PID:2:1')]))
    const [first, second] = [...element.querySelectorAll('li button')]
    await React.act(async () => first.click())
    await React.act(async () => second.click())
    assert.equal(requests[2].request.targetId, 'PID:2:1')
    assert.deepEqual(cancelled, [requests[1].id])
    const html = '<script>throw Error("should remain text")</script>'
    await React.act(async () => requests[2].resolve([{ html, truncated: false }]))
    await React.act(async () => requests[1].resolve([{ html: 'obsolete', truncated: false }]))
    assert.equal(element.querySelector('pre').textContent, html)
    assert.equal(element.querySelector('script'), null)
    await React.act(async () => element.querySelector('section section button').click())
    assert.equal(requests[3].request.targetId, 'PID:2:1')
    await React.act(async () => root.unmount())
    mounted = false
    assert.deepEqual(cancelled, [requests[1].id, requests[3].id])
  } finally {
    if (mounted) await React.act(async () => root.unmount())
    element.remove()
    window.close()
  }
})
