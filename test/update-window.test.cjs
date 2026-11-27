const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')
const fs = require('node:fs'), vm = require('node:vm')
function fixture(deferClose = false, platform = 'win32') {
  const handlers={}, events=[], instances=[]
  let restored=0
  const parent=Object.assign(new EventEmitter(), {getBounds:()=>({x:100,y:100,width:800,height:600}),isDestroyed:()=>false,isMinimized:()=>!restored,isVisible:()=>true,restore:()=>restored++,show(){},isAlwaysOnTop:()=>true})
  class BrowserWindow extends EventEmitter {
    static getFocusedWindow(){return null}
    constructor(options){super();this.options=options;this.rect=options;this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.send=(...args)=>events.push(args);instances.push(this)}
    isDestroyed(){return !!this.destroyed}
    getBounds(){return this.rect}
    setBounds(value){this.rect=value}
    setMenu(){}
    loadFile(){return Promise.resolve()}
    show(){this.shown=true}
    hide(){this.shown=false}
    showInactive(){this.shown=true}
    isVisible(){return !!this.shown}
    moveTop(){this.raised=true}
    focus(){this.focused=true}
    close(){if(deferClose){this.finishClose=()=>{this.destroyed=true;this.emit('closed')};return}this.destroyed=true;this.emit('closed')}
    destroy(){this.destroyed=true;this.emit('closed')}
  }
  const module={exports:{}}
  vm.runInNewContext(transformSync(fs.readFileSync('src/main/window/update.ts','utf8'),{loader:'ts',format:'cjs'}).code,{
    module,exports:module.exports,__dirname:'/fixture/main',console,process:{platform},
    require(id){
      if(id==='electron')return {BrowserWindow,ipcMain:{handle:(key,fn)=>handlers[key]=fn},screen:{getDisplayMatching:()=>({workArea:{x:0,y:0,width:1600,height:1000}})}}
      if(id==='share/main/lib/window')return {getWin:()=>parent}
      if(id==='share/common/util')return {isDev:()=>false}
      return require(id)
    },
  })
  return {api:module.exports,parent,instances,handlers,events,restored:()=>restored}
}
const state={status:'checking',productName:'Scrcpy Harmony',currentVersion:'1.0.4-dev.0'}
test('update window restores a minimized parent and keeps progress/results in one pinned child',()=>{
  const f=fixture();f.api.showUpdateWindow(state,()=>{})
  const w=f.instances[0]
  assert.equal(f.restored(),1)
  assert.equal(w.options.parent,f.parent)
  assert.equal(w.options.alwaysOnTop,true)
  assert.equal(w.options.width,400);assert.equal(w.options.height,146)
  w.emit('ready-to-show');assert.equal(w.shown,true);assert.equal(w.focused,true)
  f.api.setUpdateState({...state,status:'upToDate'})
  assert.equal(f.instances.length,1)
  assert.equal(w.rect.width,260);assert.equal(w.rect.height,234)
  assert.equal(f.events.at(-1)[1].status,'upToDate')
})
test('only the active update main frame can read state or dispatch a supported action',async()=>{
  const f=fixture(),actions=[];f.api.showUpdateWindow(state,value=>actions.push(value))
  const w=f.instances[0],good={sender:w.webContents,senderFrame:w.webContents.mainFrame}
  assert.equal(f.handlers.getUpdateState(good).status,'checking')
  assert.throws(()=>f.handlers.getUpdateState({sender:{},senderFrame:{}}),/active update window/)
  await assert.rejects(f.handlers.updateAction({...good,senderFrame:{}},'close'),/active update window/)
  await assert.rejects(f.handlers.updateAction(good,'arbitrary'),/Invalid update action/)
  await f.handlers.updateAction(good,'cancel');assert.deepEqual(actions,['cancel'])
  f.api.closeUpdateWindow();assert.deepEqual(actions,['cancel'])
  assert.throws(()=>f.handlers.getUpdateState(good),/active update window/)
  f.api.setUpdateState({...state,status:'available'});assert.equal(f.instances.length,1)
})


test('cancel and immediate reopen cannot reuse a window awaiting asynchronous close',()=>{
  const f=fixture(true),oldActions=[],newActions=[]
  f.api.showUpdateWindow(state,value=>oldActions.push(value))
  const old=f.instances[0]
  f.api.closeUpdateWindow()
  f.api.showUpdateWindow(state,value=>newActions.push(value))
  assert.equal(f.instances.length,2)
  old.finishClose?.()
  const current=f.instances[1]
  assert.equal(f.handlers.getUpdateState({sender:current.webContents,senderFrame:current.webContents.mainFrame}).status,'checking')
  assert.deepEqual(newActions,[])
})

test('macOS update window drags independently and follows its owner lifecycle', () => {
  const f = fixture(false, 'darwin')
  f.api.showUpdateWindow(state, () => {})
  const [window] = f.instances
  assert.equal(window.options.parent, undefined)
  assert.equal(window.options.alwaysOnTop, true)
  f.parent.isVisible = () => false
  window.emit('ready-to-show')
  assert.equal(window.isVisible(), false)
  f.parent.isVisible = () => true
  for (const [show, hide] of [['show', 'hide'], ['restore', 'minimize']]) {
    f.parent.emit(show)
    assert.equal(window.isVisible(), true)
    f.parent.emit(hide)
    assert.equal(window.isVisible(), false)
  }
  f.parent.emit('restore')
  f.parent.emit('focus')
  assert.equal(window.raised, true)
  f.parent.emit('closed')
  assert.equal(window.isDestroyed(), true)
  for (const event of ['show', 'hide', 'restore', 'minimize', 'focus', 'closed']) {
    assert.equal(f.parent.listenerCount(event), 0)
  }
})
