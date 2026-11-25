const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { transformSync } = require('esbuild')

const tick = () => new Promise(setImmediate)

function processFixture() {
  let output
  const writes = []
  const proc = {
    output: new ReadableStream({ start(controller) { output = controller } }),
    input: new WritableStream({ write(bytes) { writes.push(Buffer.from(bytes)) } }),
    exited: new Promise(() => {}),
    kills: 0,
    async kill() { this.kills++ },
  }
  return { output, writes, proc }
}

function fixture(subprocess, acquire) {
  const sent = [], leases = []
  const module = { exports: {} }
  const source = readFileSync('src/main/lib/devices/androidStreams.ts', 'utf8')
  const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code
  const mocks = {
    'share/common/log': () => ({ warn() {} }),
    './android': { acquireAndroidAdb: acquire || (async key => {
      const lease = { key, releases: 0 }
      leases.push(lease)
      return { adb: { subprocess }, release: async () => { lease.releases++ } }
    }) },
    'share/main/lib/window': { sendTo: (...args) => sent.push(args) },
  }
  new Function('module', 'exports', 'require', code)(
    module, module.exports, id => mocks[id] || require(id),
  )
  return { ...module.exports, sent, leases }
}

function record(message, header = 28) {
  const payload = Buffer.concat([Buffer.from([7]), Buffer.from('标签\0' + message + '\0')])
  const packet = Buffer.alloc(header + payload.length)
  packet.writeUInt16LE(payload.length)
  packet.writeUInt16LE(header === 20 ? 0 : header, 2)
  packet.writeInt32LE(41, 4)
  packet.writeUInt32LE(42, 8)
  packet.writeUInt32LE(1_730_000_000, 12)
  packet.writeUInt32LE(123_000_000, 16)
  payload.copy(packet, header)
  return packet
}

test('interactive shell binds before the initial prompt, preserves UTF-8 and binary input, closes on EOF', async () => {
  const shell = processFixture()
  const sizes = []
  shell.proc.resize = async (rows, cols) => { sizes.push([rows, cols]) }
  const f = fixture({ shellProtocol: { async pty(opts) {
    assert.equal(opts.terminalType, 'xterm-256color')
    return shell.proc
  } } })
  const id = await f.androidCreateShell('android:usb')
  assert.match(id, /^android:shell:/)
  await f.androidResizeShell(id, 32, 110)
  await f.androidResizeShell(id, 40, 140)
  await assert.rejects(f.androidResizeShell(id, 0, 140), /Invalid terminal size/)
  assert.deepEqual(sizes, [[32, 110], [40, 140]])
  const prompt = Buffer.from('终端 $ ')
  shell.output.enqueue(prompt.subarray(0, 2))
  shell.output.enqueue(prompt.subarray(2))
  await tick()
  assert.deepEqual(f.sent, [])
  await f.androidWriteShell(id, '')
  await f.androidWriteShell(id, '中文\r')
  await f.androidWriteShell(id, Uint8Array.of(3, 0, 255))
  assert.deepEqual(shell.writes, [Buffer.from('中文\r'), Buffer.from([3, 0, 255])])
  shell.output.close()
  await tick()
  assert.deepEqual(f.sent, [
    ['main', 'shellData', id, '终端 $ '],
    ['main', 'shellEnded', id],
  ])
  await f.androidKillShell(id)
  assert.equal(shell.proc.kills, 1)
  assert.deepEqual(f.leases, [{ key: 'android:usb', releases: 1 }])
  await assert.rejects(f.androidWriteShell(id, 'x'), /closed/)
  await assert.rejects(f.androidResizeShell(id, 40, 140), /closed/)
})

test('legacy PTYs keep accepting input on resize', async () => {
  const shell = processFixture()
  const f = fixture({ noneProtocol: { pty: async () => shell.proc } })
  const id = await f.androidCreateShell('android:legacy')
  await f.androidResizeShell(id, 32, 110)
  await f.androidWriteShell(id, 'x')
  await f.androidKillShell(id)
  assert.deepEqual(shell.writes, [Buffer.from('x')])
})

test('binary logcat parses fragmented frames, respects pause and retains tags, multiline messages and fatal priority', async () => {
  const log = processFixture()
  const f = fixture({ noneProtocol: { async spawn(args) {
    assert.deepEqual(args, ['logcat', '-B', '-T', '1', '-b', 'main', '-b', 'system', '-b', 'crash'])
    return log.proc
  } } })
  const id = await f.androidOpenHilog('android:usb')
  await f.androidResumeHilog(id)
  const packed = Buffer.concat([record('第一行\n第二行', 20), record('next')])
  for (let i = 0; i < packed.length; i += 3) log.output.enqueue(packed.subarray(i, i + 3))
  await tick()
  assert.deepEqual(f.sent.map(([, , , entry]) => entry.message), ['第一行\n第二行', 'next'])
  assert.deepEqual(f.sent[0], ['main', 'hilogEntry', id, {
    date: new Date(1_730_000_000_123), pid: 41, tid: 42, level: 7,
    tag: '标签', bundleName: '41', message: '第一行\n第二行',
  }])
  await f.androidPauseHilog(id)
  log.output.enqueue(record('paused'))
  await tick()
  await f.androidResumeHilog(id)
  log.output.enqueue(record('resumed'))
  await tick()
  assert.equal(f.sent.length, 3)
  assert.equal(f.sent[2][3].message, 'resumed')
  log.output.error(new Error('unplugged'))
  await tick()
  assert.deepEqual(f.sent.at(-1), ['main', 'hilogEnded', id])
  assert.equal(f.leases[0].releases, 1)
  await f.androidCloseHilog(id)
  assert.equal(log.proc.kills, 1)
})

test('renderer teardown isolates a late PTY open from an already live log stream', async () => {
  const log = processFixture(), shell = processFixture()
  const gate = Promise.withResolvers()
  const f = fixture({ noneProtocol: {
    pty: () => gate.promise, spawn: async () => log.proc,
  } })
  const logId = await f.androidOpenHilog('android:A')
  await f.androidResumeHilog(logId)
  const pending = f.androidCreateShell('android:B')
  await tick()
  await f.closeAndroidStreams()
  assert.equal(log.proc.kills, 1)
  await assert.rejects(pending, /Renderer closed/)
  assert.deepEqual(f.leases.map(lease => lease.releases), [1, 1])
  gate.resolve(shell.proc)
  await tick()
  assert.equal(shell.proc.kills, 1)
  assert.deepEqual(f.leases.map(lease => lease.releases), [1, 1])
  assert.equal(f.sent.length, 0)
})

test('renderer teardown aborts pending shell and logcat authentication', async () => {
  const signals = []
  const f = fixture({}, (_key, signal) => new Promise((_, reject) => {
    signals.push(signal)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const openings = [f.androidCreateShell('android:A'), f.androidOpenHilog('android:B')]
  const results = Promise.allSettled(openings)
  await f.closeAndroidStreams()
  assert.ok(signals.every(signal => signal.aborted))
  assert.deepEqual((await results).map(result => result.reason.message), ['Renderer closed', 'Renderer closed'])
})

test('late logcat process closes once after its renderer lease is released', async () => {
  const gate = Promise.withResolvers(), log = processFixture()
  const f = fixture({ noneProtocol: { spawn: () => gate.promise } })
  const opening = f.androidOpenHilog('android:A')
  await tick()
  await f.closeAndroidStreams()
  await assert.rejects(opening, /Renderer closed/)
  assert.deepEqual(f.leases.map(lease => lease.releases), [1])
  gate.resolve(log.proc)
  await tick()
  assert.equal(log.proc.kills, 1)
  assert.equal(f.sent.length, 0)
})

test('failed process creation releases its lease and malformed log headers end the stream', async () => {
  const log = processFixture()
  const f = fixture({ noneProtocol: {
    pty: async () => { throw new Error('unplugged') },
    spawn: async () => log.proc,
  } })
  await assert.rejects(f.androidCreateShell('android:A'), /unplugged/)
  const id = await f.androidOpenHilog('android:B')
  await f.androidResumeHilog(id)
  log.output.enqueue(Buffer.from('logcat: permission denied'))
  await tick()
  assert.deepEqual(f.sent, [['main', 'hilogEnded', id]])
  assert.deepEqual(f.leases.map(lease => lease.releases), [1, 1])
})
