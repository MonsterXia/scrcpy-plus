const {test}=require('node:test'),assert=require('node:assert/strict'),load=require('./helpers/load-automation.cjs'),{execFile}=require('node:child_process'),{promisify}=require('node:util')
const exec=promisify(execFile),ctx=()=>({clientId:'test',deadline:Date.now()+1000,signal:new AbortController().signal})
test('one-shot shell preserves command quoting and returns its actual exit status',{skip:process.platform==='win32'},async()=>{
 const {runOneShotShell}=load('src/main/automation/adapters/oneShotShell.ts')
 const transport=async command=>(await exec('/bin/sh',['-c',command])).stdout
 const result=await runOneShotShell("printf '%s' 'space;中文'; exit 9",131072,ctx(),transport)
 assert.equal(result.output,'space;中文');assert.equal(result.exitCode,9);assert.equal(result.truncated,false)
})
test('shell output truncation is explicit and missing completion never looks successful',async()=>{
 const {runOneShotShell}=load('src/main/automation/adapters/oneShotShell.ts')
 const result=await runOneShotShell('read',4,ctx(),async command=>{
 const marker=command.match(/SCRCPY_SHELL_([a-f0-9-]+):/)[0];return 'abcdef\n'+marker+'0\n'
 });assert.equal(result.output,'abcd');assert.equal(result.truncated,true)
 await assert.rejects(runOneShotShell('read',4,ctx(),async()=> 'partial output'),{code:'OUTCOME_UNKNOWN'})
})

test('Android shell cancellation releases silent reads and retires a late process open', async () => {
  const { readAndroidShellOutput } = load('src/main/lib/devices/androidShell.ts')
  for (const late of [false, true]) {
    const opened = Promise.withResolvers()
    const child = {
      output: new ReadableStream(),
      exited: Promise.resolve(),
      kills: 0,
      async kill() { this.kills++ },
    }
    const controller = new AbortController()
    const adb = { subprocess: { noneProtocol: { spawn: () => opened.promise } } }
    const read = readAndroidShellOutput(adb, 'getprop', 1024, 30000, controller.signal)
    if (!late) opened.resolve(child)
    await new Promise(setImmediate)
    controller.abort(new Error('Request cancelled'))
    await assert.rejects(read, /Request cancelled/)
    if (late) opened.resolve(child)
    await new Promise(setImmediate)
    assert.equal(child.kills, 1)
    assert.equal(child.output.locked, false)
  }
})
