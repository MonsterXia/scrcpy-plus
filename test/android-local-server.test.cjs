const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'plus-local-adb-test-'))
buildSync({entryPoints:['src/main/lib/devices/androidServer.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'server.cjs')})
const {connectLocalAdb,discoverLocalAdb,LocalAdbConnector}=require(path.join(temp,'server.cjs'))
process.on('exit',()=>fs.rmSync(temp,{recursive:true,force:true}))
async function server(t,devices='phone device model:Phone transport_id:7\nother device transport_id:9\n') {
 const calls=[], sockets=new Set();let mirrorConnections=0
 const string=s=>s.length.toString(16).padStart(4,'0')+s
 const listener=net.createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})
  let buffered=Buffer.alloc(0)
  socket.on('data',chunk=>{
   buffered=Buffer.concat([buffered,chunk])
   while(buffered.length>=4){const size=parseInt(buffered.subarray(0,4).toString(),16);if(buffered.length<size+4)return
    const command=buffered.subarray(4,size+4).toString();buffered=buffered.subarray(size+4);calls.push(command)
    if(command==='host:devices-l'){if(devices!==null)socket.write('OKAY'+string(devices))}
    else if(command==='host:transport-id:7')socket.write('OKAY')
    else if(command==='host:features')socket.write('OKAY'+string(''))
    else if(command==='host:version')socket.write('OKAY'+string('0029'))
    else if(command==='host-transport-id:7:wait-for-any-disconnect')socket.write('OKAY')
    else if(command==='localabstract:scrcpy_00000001'){socket.write('OKAY');if(mirrorConnections++===0)socket.write(Buffer.from([0]))}
    else if(command==='shell:echo test'){socket.write('OKAYtest');socket.end()}
    else socket.end('FAIL'+string('unexpected request'))
   }
  })
 })
 await new Promise(r=>listener.listen(0,'127.0.0.1',r))
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>listener.close(r))})
 return {calls,sockets,connector:new LocalAdbConnector(listener.address().port)}
}
test('local ADB binds the exact transport and closes only its own sockets',async t=>{
 const f=await server(t), adb=await connectLocalAdb('phone',f.connector)
 assert.equal(adb.serial,'phone')
 const socket=await adb.createSocket('shell:echo test'),reader=socket.readable.getReader();let output=''
 for(;;){const chunk=await reader.read();if(chunk.done)break;output+=Buffer.from(chunk.value).toString()}
 assert.equal(output,'test');reader.releaseLock();await adb.close()
 await new Promise(setImmediate)
 assert.ok(f.calls.includes('host:transport-id:7'))
 assert.ok(f.calls.every(c=>!c.includes('kill')&&!c.includes('reconnect')&&!c.includes('transport-id:9')))
 await assert.rejects(f.connector.connect(),/closed/)
})
for(const devices of ['other device transport_id:9\n','phone unauthorized transport_id:7\n','phone device transport_id:7\nphone device transport_id:9\n'])test('local ADB rejects absent, unauthorized or ambiguous serial: '+devices.trim().replaceAll('\n',';'),async t=>{
 const f=await server(t,devices);await assert.rejects(connectLocalAdb('phone',f.connector),/unavailable/)
 assert.deepEqual(f.calls,['host:devices-l']);await assert.rejects(f.connector.connect(),/closed/)
})
test('local ADB rejects serial command injection before connecting',async t=>{
 const f=await server(t);await assert.rejects(connectLocalAdb('phone:kill',f.connector),/Invalid/);assert.deepEqual(f.calls,[])
})

test('local server discovery preserves authorization states and closes read-only sockets', async t => {
 const f=await server(t,'phone device model:Phone transport_id:7\nlocked unauthorized transport_id:8\ngone offline transport_id:9\n192.168.1.2:5555 device transport_id:10\nadb-phone._adb-tls-connect._tcp device transport_id:11\nemulator-5554 device transport_id:12\n')
 const devices=await discoverLocalAdb(f.connector)
 assert.deepEqual(devices.map(d=>[d.serial,d.state]),[['phone','device'],['locked','unauthorized'],['gone','offline']])
 assert.deepEqual(f.calls,['host:devices-l'])
 await assertSocketsClosed(f)
 await assert.rejects(f.connector.connect(),/closed/)
})

test('local discovery stops a server that accepts sockets without replying', {timeout:6000}, async t => {
 const started=performance.now()
 const f=await server(t,null)
 await assert.rejects(discoverLocalAdb(f.connector))
 assert.ok(performance.now()-started<4500,'discovery must stay within its 3s deadline plus CI scheduling tolerance')
 await assert.rejects(f.connector.connect(),/closed/)
 assert.deepEqual(f.calls,['host:devices-l'])
 await assertSocketsClosed(f)
})

async function assertSocketsClosed(f) {
 await Promise.all([...f.sockets].map(socket=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('owned discovery socket stayed open')),1000)
  socket.once('close',()=>{clearTimeout(timer);resolve()})
 })))
 assert.equal(f.sockets.size,0)
}
test('real Tango forward tunnel opens video and control through reused ADB without reverse support', async t => {
 const {AdbScrcpyOptions3_3_3}=await import('@yume-chan/adb-scrcpy')
 const f=await server(t),adb=await connectLocalAdb('phone',f.connector)
 const connection=new AdbScrcpyOptions3_3_3({scid:1,video:true,audio:false,control:true,tunnelForward:true}).createConnection(adb)
 await connection.initialize()
 const streams=await connection.getStreams()
 assert.ok(streams.video);assert.ok(streams.control)
 assert.equal(f.calls.filter(command=>command==='localabstract:scrcpy_00000001').length,2)
 assert.ok(f.calls.every(command=>!command.includes('reverse')))
 connection.dispose();await adb.close();await assertSocketsClosed(f)
})
