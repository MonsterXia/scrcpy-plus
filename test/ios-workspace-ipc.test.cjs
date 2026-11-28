const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const load = require('./helpers/load-ios.cjs')

function fixture(helper, choose = async () => ({ canceled: true }), profile = '/synthetic') {
  const handlers = new Map(), messages = []
  const sender = Object.assign(new EventEmitter(), { mainFrame: { url: 'http://localhost:8080/' },
    send: (...args) => messages.push(args), isDestroyed: () => false })
  const key = 'ios:01234567'
  const device = { key, connectionId: '01234567', transport: 'usb', platform: 'ios', state: 'ready' }
  const { initIosWorkspace } = load('src/main/lib/devices/ios-workspace.ts', {
    electron: { app: { getPath: () => profile }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: () => ({}) }, dialog: { showOpenDialog: choose } },
    'share/common/util': { isDev: () => true }, 'share/main/lib/util': {},
    '../ios-provisioning': { getIosHelper: () => ({ deviceExecutable: async () => 'verified' }) },
    './ios-workspace-runner': { runIosHelper: helper },
  })
  const workspace = initIosWorkspace(sender, id => id === key ? device : undefined)
  const event = { sender, senderFrame: sender.mainFrame }
  const read = (request, id = 'one') => handlers.get('ios:workspace')(event, key, request, id)
  return { read, handlers, workspace, event, key, device, messages }
}

test('iOS tools bind to the ready USB phone and main frame, validate operations and ignore injected helper parameters', async () => {
  const seen = []
  const f = fixture(async (exe, udid, req, _signal, row) => { seen.push([exe, udid, req]); row({ name: 'Demo' }) })
  for (const req of [{ op: 'shell' }, { op: 'cleanupStaging' }, { op: 'terminate', pid: 1, bundleId: 'me.demo' },
    { op: 'files', path: '/../Documents' }, { op: 'launch', bundleId: '../demo' }, { op: 'webDom', targetId: '' }]) {
    await assert.rejects(f.read(req), /protocol/)
  }
  for (const event of [{ ...f.event, sender: {} }, { ...f.event, senderFrame: {} }]) {
    await assert.rejects(f.handlers.get('ios:workspace')(event, f.key, { op: 'apps' }, 'id'), /protocol/)
  }
  await assert.rejects(f.handlers.get('ios:workspace')(f.event, 'ios:airplay-receiver', { op: 'apps' }, 'id'), /disconnected/)
  const rows = await f.read({ op: 'apps', udid: 'another', path: '/' })
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [['verified', '01234567', { op: 'apps' }]])
  assert.equal(rows[0].name, 'Demo')
})

test('install uses only a native chooser path and drops cancelled selections before spawning', async () => {
  let reply, count = 0
  const f = fixture(async (_exe, _udid, req, _signal, _row, root) => {
    count++
    assert.equal(req.path, '/local/Chosen.ipa')
    assert.equal(req.stagingRoot, undefined)
    assert.equal(root, require('node:path').join('/synthetic', 'ios-ipa-staging'))
  },
    () => new Promise(resolve => { reply = resolve }))
  const install = () => f.read({ op: 'install', path: '/unexpected/Other.ipa', stagingRoot: '/unexpected' })
  const first = install()
  await assert.rejects(f.read({ op: 'uninstall', bundleId: 'example.app' }, 'two'), /busy/)
  const pickFirst = reply
  f.workspace.reconcile([])
  await assert.rejects(first, /disconnected/)
  assert.equal(count, 0)
  const second = install()
  pickFirst({ canceled: false, filePaths: ['/late/Old.ipa'] })
  reply({ canceled: false, filePaths: ['/local/Chosen.ipa'] })
  await second
  assert.equal(count, 1)
})

test('iOS logs use bounded messages scoped to request ID and stop on navigation or unplug', async () => {
  const f = fixture(async (_exe, _udid, _req, signal, row) => {
    for (let pid = 0; pid < 310; pid++) row({ pid })
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  })
  const pending = f.read({ op: 'logs' }, 'ios-live-log-a17')
  await new Promise(resolve => setTimeout(resolve, 175))
  const [channel, id, batch] = f.messages[0]
  assert.equal(channel, 'ios:workspaceLogs'); assert.equal(id, 'ios-live-log-a17')
  assert.equal(batch.length, 300); assert.equal(batch.at(-1).pid, 309)
  f.workspace.reconcile([])
  await assert.rejects(pending, /disconnected/)
  const next = f.read({ op: 'logs' })
  f.event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  await assert.rejects(next, /cancelled/)
})

test('device helper runner accepts fragmented NDJSON, rejects incomplete output and terminates cancelled streams', async () => {
  const { spawn } = require('node:child_process')
  function runner(body) {
    return load('src/main/lib/devices/ios-workspace-runner.ts', {
      'node:child_process': { spawn: (program, args, options) => {
        assert.equal(program, 'verified')
        assert.equal(args.join(','), '--workspace,--cancel-on-eof')
        return spawn(process.execPath, ['-e', body], options)
      } },
    }).runIosHelper
  }
  const head = "process.stdin.once('data', input => { process.stdin.pause(); process.stdin.unref();"
  const read = runner(head + "const req=JSON.parse(input); process.stdout.write('{'); setImmediate(() => console.log(JSON.stringify({row:req}).slice(1)+'\\n'+JSON.stringify({done:true}))) })")
  const rows = []
  await read('verified', '01234567', { op:'apps' }, new AbortController().signal, row => rows.push(row))
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ op:'apps', udid:'01234567' }])
  const incomplete = runner(head + "console.log(JSON.stringify({row:{}})) })")
  await assert.rejects(incomplete('verified', '01234567', {op:'apps'}, new AbortController().signal, () => {}), /device-error/)
  const stream = runner(head + "console.log(JSON.stringify({row:{}})); process.stdin.ref(); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)) })")
  const controller = new AbortController()
  await assert.rejects(stream('verified','01234567',{op:'logs'},controller.signal, () => controller.abort(Error('cancelled'))), /cancelled/)
})

test('discovery retries only registered IPA files for this profile and device after reconnect or restart', async t => {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const os = require('node:os')
  const { createHash, randomUUID } = require('node:crypto')
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-staging-'))
  t.after(() => fs.rm(profile, { recursive: true, force: true }))
  const root = path.join(profile, 'ios-ipa-staging')
  const deviceDir = id => path.join(root, createHash('sha256').update(id).digest('hex'))
  const local = deviceDir('01234567'), other = deviceDir('99999999')
  await fs.mkdir(local, { recursive: true })
  await fs.mkdir(other)
  const marker = randomUUID() + '.ipa'
  await fs.writeFile(path.join(other, marker), '')
  await fs.writeFile(path.join(local, 'unrelated.ipa'), '')
  let runs = 0, markStarted, release
  const started = new Promise(resolve => { markStarted = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const create = () => fixture(async (_exe, udid, req, signal, _row, stagingRoot) => {
    assert.equal(udid, '01234567')
    assert.equal(stagingRoot, root)
    assert.equal(req.op, 'cleanupStaging')
    if (++runs === 1) {
      markStarted()
      await blocked
      signal.throwIfAborted()
    }
    await fs.unlink(path.join(local, marker))
  }, undefined, profile)
  const first = create()
  await first.workspace.reconcile([first.device])
  await first.workspace.reconcile([first.device])
  await first.workspace.stopAll()
  assert.equal(runs, 0)

  await fs.writeFile(path.join(local, marker), '')
  const reconnect = create()
  reconnect.workspace.reconcile([reconnect.device])
  reconnect.workspace.reconcile([reconnect.device])
  await started
  reconnect.workspace.reconcile([])
  release()
  await reconnect.workspace.stopAll()
  assert.equal(runs, 1)
  assert.equal(await fs.stat(path.join(local, marker)).then(s => s.isFile()), true)

  const restarted = create()
  await restarted.workspace.reconcile([restarted.device])
  await restarted.workspace.reconcile([restarted.device])
  await restarted.workspace.stopAll()
  assert.equal(runs, 2)

  // A rejected attempt stays on disk, cools down while online, and retries
  // immediately when the same UDID disconnects and returns.
  await fs.writeFile(path.join(local, marker), '')
  let attempts = 0
  const flaky = fixture(async () => {
    if (++attempts === 1) throw Error('disconnected')
    await fs.unlink(path.join(local, marker))
  }, undefined, profile)
  await flaky.workspace.reconcile([flaky.device])
  await flaky.workspace.reconcile([flaky.device])
  assert.equal(attempts, 1)
  await flaky.workspace.reconcile([])
  await flaky.workspace.reconcile([flaky.device])
  assert.equal(attempts, 2)
  await flaky.workspace.stopAll()
  assert.equal(await fs.stat(path.join(other, marker)).then(s => s.isFile()), true)
})
