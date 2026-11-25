const assert = require('node:assert/strict')
const { test } = require('node:test')
const { observable, runInAction } = require('mobx')
const { setup, load, React } = require('./helpers/workspace-renderer.cjs')
const createRoot = setup(),
  { act } = React

// Load the production component and both real clipboard helpers. Only the
// browser clipboard permission/write boundary and JPEG conversion are faked.
async function fixture(t, capture = 'aGVsbG8=') {
  const writes = [],
    notices = [],
    downloads = [],
    store = observable({ target: { key: 'A' } })
  const globals = {
    main: { screencap: async () => capture },
    Blob,
    ClipboardItem: class {
      constructor(data) {
        this.data = data
      }
    },
    navigator: {
      clipboard: {
        write(items) {
          return new Promise((resolve, reject) =>
            writes.push({ items, resolve, reject }),
          )
        },
      },
    },
  }
  const shared = load(
    'src/share/renderer/lib/util.ts',
    {
      'luna-notification': class {
        notify(...args) {
          notices.push(args)
        }
      },
    },
    globals,
  )
  const local = load('src/renderer/main/lib/util.ts', {}, globals)
  const View = load(
    'src/renderer/main/components/screenshot/Screenshot.tsx',
    {
      '../../store': store,
      'common/util': { t: (key) => key },
      'share/renderer/lib/util': shared,
      '../../lib/util': {
        ...local,
        toPng: async () => 'data:image/png;base64,aGVsbG8=',
      },
      'licia/download': (...args) => downloads.push(args),
      'licia/loadImg': (_, callback) =>
        callback(null, { width: 360, height: 720 }),
      'luna-image-viewer/react': () =>
        React.createElement('div', { 'data-viewer': true }),
    },
    globals,
  ).default
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host)
  await act(async () => root.render(React.createElement(View)))
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const copy = () =>
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'copy',
    )
  return { host, store, writes, notices, downloads, copy }
}

test('screenshot Copy stays busy until the actual clipboard write succeeds', async (t) => {
  const f = await fixture(t)
  await act(async () => f.copy().click())
  assert.equal(f.writes.length, 1)
  assert.equal(f.copy().disabled, true)
  assert.deepEqual(f.notices, [])
  const blob = f.writes[0].items[0].data['image/png']
  assert.equal(blob.type, 'image/png')
  assert.equal(await blob.text(), 'hello')
  await act(async () => f.copy().click())
  assert.equal(f.writes.length, 1)
  await act(async () => f.writes[0].resolve())
  assert.equal(f.copy().disabled, false)
  assert.equal(f.notices.length, 1)
  assert.equal(f.notices[0][0], 'copied')
})

test('screenshot Copy consumes clipboard permission rejection and allows retry', async (t) => {
  const f = await fixture(t)
  await act(async () => f.copy().click())
  await act(async () =>
    f.writes[0].reject(Error('Clipboard permission denied')),
  )
  assert.equal(f.copy().disabled, false)
  assert.equal(f.notices.length, 1)
  assert.equal(f.notices[0][0], 'commonErr')
  await act(async () => f.copy().click())
  assert.equal(f.writes.length, 2)
  await act(async () => f.writes[1].resolve())
  assert.equal(f.notices[1][0], 'copied')
})

for (const outcome of ['resolve', 'reject']) {
  test(`old device clipboard ${outcome} does not notify or unlock the new device Copy`, async (t) => {
    const f = await fixture(t)
    await act(async () => f.copy().click())
    await act(async () =>
      runInAction(() => {
        f.store.target = { key: 'B' }
      }),
    )
    await act(async () => f.copy().click())
    assert.equal(f.writes.length, 2)
    await act(async () =>
      f.writes[0][outcome](
        outcome === 'reject' ? Error('Old write failed') : undefined,
      ),
    )
    assert.deepEqual(f.notices, [])
    assert.equal(f.copy().disabled, true)
    await act(async () => f.writes[1].resolve())
    assert.equal(f.notices.length, 1)
    assert.equal(f.notices[0][0], 'copied')
    assert.equal(f.copy().disabled, false)
  })
}

test('Android PNG screenshots preserve their native bytes, filename and MIME type on save and copy', async (t) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5f0AAAAASUVORK5CYII='
  const f = await fixture(t, png)
  assert.match(f.host.textContent, /PNG/)
  const save = [...f.host.querySelectorAll('button')].find(button => button.textContent === 'save')
  await act(async () => save.click())
  const [[file, name, type]] = f.downloads
  assert.equal(name, 'screenshot.png')
  assert.equal(type, 'image/png')
  assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), png)
  await act(async () => f.copy().click())
  const clipboard = f.writes[0].items[0].data['image/png']
  assert.equal(Buffer.from(await clipboard.arrayBuffer()).toString('base64'), png)
  await act(async () => f.writes[0].resolve())
})
