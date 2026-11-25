const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setup, load } = require('./helpers/workspace-renderer.cjs')
setup()

test('attaching and detaching a live tile updates its accessible header', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
  const page = new window.DOMParser().parseFromString(html, 'text/html')
  document.body.replaceChildren(...page.body.children)
  const events = new Map()
  load('src/share/preload/preload.ts', {
    './main': { on: (event, fn) => events.set(event, fn) },
    'custom-electron-titlebar': {}, 'common/theme': {}, electron: {},
    'licia/$': {}, 'licia/isMac': false, 'licia/getUrlParam': () => '',
  })
  const heading = document.querySelector('h1')
  const root = document.documentElement
  assert.equal(heading.hidden, true)
  for (const [name, detail, inset] of [['nova 15', 'PSN-AL00 · HarmonyOS', 28], ['手机 · 工作', 'iOS', 0], ['Android', '', 0]]) {
    events.get('mergedMirrorLabel')({ name, detail }, inset, 44)
    assert.equal(heading.hidden, false)
    assert.deepEqual(Array.from(heading.children, node => node.textContent), [name, detail].filter(Boolean))
    assert.equal(heading.title, [name, detail].filter(Boolean).join(' · '))
    assert.equal(root.style.getPropertyValue('--mirror-tool-inset'), inset + 'px')
    events.get('mergedMirrorLabel')(null)
    assert.equal(heading.hidden, true)
    assert.equal(root.hasAttribute('data-mirror-label'), false)
    assert.equal(root.style.getPropertyValue('--mirror-tool-inset'), '')
  }
})
