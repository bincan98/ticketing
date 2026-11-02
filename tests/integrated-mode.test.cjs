'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),C=require('../shared.js');
function ui(options={}){
 const fields={},requests=[],statuses=[],profile=C.defaultProfile(),node=()=>({hidden:false,textContent:'',value:'',listeners:{},addEventListener(k,f){this.listeners[k]=f;}}),$=id=>fields[id]||=node();
 const context={URL,Blob,console,document:{getElementById:$},TicketRepeatSites:require('../repeat-sites.js'),setInterval:()=>0,clearInterval(){},setTimeout,addEventListener(){},
  chrome:{runtime:{sendMessage:async r=>{requests.push(r);if(r.action==='setExecutionMode'&&options.saveFails)return{success:false,error:'save failed'};return{success:true,state:options.state||null};}},permissions:{request:r=>{requests.push({permission:r});return Promise.resolve(options.granted!==false);}},storage:{onChanged:{addListener(){}}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../repeat-popup.js'),'utf8'),context);
 context.TicketModeUI.initialize({ticketExecutionMode:options.mode||'repeat',repeatState:options.state||null},{currentTab:()=>({id:7,url:options.url||profile.url}),profile:()=>profile,showStatus:(s,t)=>statuses.push({s,t}),updateButtons(){}});
 return{api:context.TicketModeUI,$,requests,statuses};
}
test('new users keep the original detection mode and repeat UI is hidden',()=>{const u=ui({mode:'detect'});assert.equal(u.api.mode,'detect');assert(u.$('repeatControls').hidden);assert(!u.$('detectSettings').hidden);});
test('saved repeat mode shows its controls without replacing profile settings',()=>{const u=ui();assert(!u.$('repeatControls').hidden);assert(u.$('detectSettings').hidden);assert(u.$('legacyLogs').hidden);assert(u.$('advancedConfiguration').hidden);});
test('repeat preparation requests both site and iframe origins before awaiting',async()=>{const u=ui();const p=u.api.prepare();assert.equal(u.requests.length,1);assert(u.requests[0].permission.origins.includes(C.FRAME_ORIGIN+'/*'));await p;assert.equal(u.requests[1].action,'repeatPracticePrepare');assert.equal(u.requests[1].expectedTarget.tabId,7);});
test('denied permission leaves a visible error and sends no prepare',async()=>{const u=ui({granted:false,state:{status:'completed',message:'old result',clickMessage:'old'}});await u.api.prepare();assert.equal(u.requests.length,1);assert.match(u.$('repeatPhase').textContent,/허용되지/);assert.match(u.statuses.at(-1).s,/허용되지/);});
test('unsupported target never asks for permission or prepares input',async()=>{const u=ui({url:'https://example.com/'});await u.api.prepare();assert.equal(u.requests.length,0);assert.match(u.$('repeatPhase').textContent,/탭에서 준비/);});
test('failed mode storage restores the previous selection',async()=>{const u=ui({mode:'detect',saveFails:true});u.$('executionMode').value='repeat';await u.$('executionMode').listeners.change();assert.equal(u.api.mode,'detect');assert.equal(u.$('executionMode').value,'detect');});
test('active repeat run is recovered on opening the original popup',()=>{const u=ui({mode:'detect',state:{status:'armed',message:'ready'}});assert.equal(u.api.mode,'repeat');assert(u.api.active());});
test('common stop uses the existing stop endpoint',async()=>{const u=ui();await u.api.stop();assert.equal(u.requests[0].action,'stopMacro');assert.equal(u.requests[1].action,'repeatPracticeStatus');});
