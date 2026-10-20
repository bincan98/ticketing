const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const C = require('../shared.js');
const TicketCapture = require('../capture.js');
function worker(data = {}, behavior = {}) {
  let onMessage, onConnect, onStartup, onRemoved, onCommitted, onCreated, onStorageChanged, sends = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const context = {URL, crypto, console, setTimeout,clearTimeout, importScripts: () => {}, TicketConfig: C, TicketCapture, TicketAnalysis: require('../analyze.js'), TicketCDP:require('../cdp.js'),
    chrome: {
      runtime: {id:'extension', onMessage:{addListener: fn => onMessage=fn}, onConnect:{addListener:fn=>onConnect=fn}, onInstalled:{addListener:()=>{}}, onStartup:{addListener:fn=>onStartup=fn}},
      storage: {onChanged:{addListener:fn=>onStorageChanged=fn},local: {get: async keys => {
        const selected = Array.isArray(keys) ? keys : [keys];
        if(selected.includes('ticketCdpSession')&&behavior.recoveryFailures){behavior.recoveryFailures--;throw Error('temporary recovery read failure');}
        if(selected.includes('profileSchemaVersion')){
          behavior.setupReads=(behavior.setupReads||0)+1;
          if(behavior.setupFailures){behavior.setupFailures--;throw Error('temporary setup read failure');}
        }
        return Object.fromEntries(selected.filter(k=>data[k]!==undefined).map(k=>[k,clone(data[k])]));
      }, set: async patch => {
        behavior.writes ||= [];behavior.writes.push(clone(patch));
        if(behavior.beforeWrite)await behavior.beforeWrite(patch);
        return Object.assign(data,clone(patch));
      }}},
      tabs: {query:async()=>typeof behavior.query==='function'?behavior.query():[{id:behavior.queryTabId??7,url:behavior.queryUrl||C.INITIAL_URL}], get:async()=>({id:behavior.queryTabId??7,url:behavior.url||behavior.queryUrl||C.INITIAL_URL}),
        sendMessage:async(tabId,request,options)=>{sends++;
          behavior.messages ||= [];behavior.messages.push({tabId,request,options});
          if(request.action==='engineStatus') { if(behavior.lost) throw Error('no document'); return {running:true,runId:request.runId}; }
          if(request.action==='validateEngine') return {success:true};
          if(request.action==='startEngine') {behavior.started=(behavior.started||0)+1;return {success:true};}
          if(request.action==='stopEngine') {data.macroRun.status='stopped';return {success:true};}
          return {success:true};
        }, onRemoved:{addListener:fn=>onRemoved=fn}, onCreated:{addListener:fn=>onCreated=fn}},
      permissions:{contains:async()=>behavior.permission!==false},
      webNavigation:{getAllFrames:async()=>{
        behavior.frameReads=(behavior.frameReads||0)+1;
        return behavior.frameReads>1 && behavior.nextFrames ? behavior.nextFrames : behavior.frames || [{frameId:0,url:C.INITIAL_URL},{frameId:2,url:C.FRAME_ORIGIN+'/_f/123'}];
      },onCommitted:{addListener:fn=>onCommitted=fn}},
      scripting:{executeScript:async request=>{
        behavior.injections ||= [];behavior.injections.push(request);
        if(behavior.injectError)throw Error(behavior.injectError);
        if(request.func && behavior.analysisResults) {
          const id=request.target.frameIds?.[0] ?? behavior.frames.find(frame=>frame.documentId===request.target.documentIds?.[0])?.frameId;
          const result=behavior.analysisResults[id];if(result instanceof Error)throw result;
          return [{frameId:id,documentId:'doc-'+id,result}];
        }
        if(request.func)return [{frameId:behavior.captureFrameId??0,documentId:behavior.captureDocumentId||'doc-0',result:behavior.captured}];
        return [{frameId:2,documentId:'doc-2'}];
      }}
    }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'),'utf8')+';globalThis.testCdp=cdp;globalThis.testRecordInput=recordCdpInput;globalThis.testDocument=sendCdpDocument;',context);
  return {data, behavior, sends:()=>sends, request:action=>new Promise(resolve=>onMessage(typeof action==='string'?{action}:action, {id:'extension'}, resolve)),
    startup:()=>onStartup(), removed:id=>onRemoved(id), committed:details=>onCommitted(details), created:tab=>onCreated(tab),
    storageChanged:changes=>onStorageChanged(changes,'local'),
    connect:port=>onConnect(port),
    documentSession:()=>{const session={run:data.macroRun,canceled:false,closing:false,worlds:new Map(),ownerCache:new Map(),ownerLoads:new Map(),cacheDisposals:new Set()};context.testCdp.session=session;return {session,request:r=>context.testDocument(session,r)};},
    inputCommit:(request,marker,flags={})=>{
      const session={run:data.macroRun,canceled:false,closing:false,worlds:new Map(),ownerCache:new Map(),ownerLoads:new Map(),cacheDisposals:new Set(),...flags};context.testCdp.session=session;
      return {session,flight:context.testRecordInput(session,request,marker)};
    }};
}
function activeData() {
  const profile=C.defaultProfile(); profile.settings.scheduledAt=Date.now()+60000;
  return {ticketProfiles:[profile],activeProfileId:profile.id,macroRun:{id:'run',tabId:7,frameId:2,documentId:'doc-2',profile,status:'watching',logs:[]}};
}
function documentPort(change={}){const sent=[],handlers=[],disconnects=[];let closed=false;
  const port={name:'ticket-cdp-document',sender:{id:'extension',tab:{id:7},frameId:2,documentId:'doc-2',...change},
    onMessage:{addListener:f=>handlers.push(f)},onDisconnect:{addListener:f=>disconnects.push(f)},postMessage:m=>sent.push(m),
    disconnect:()=>{closed=true;}};
  return {port,sent,closed:()=>closed,receive:m=>handlers.forEach(f=>f(m)),drop:()=>{closed=true;disconnects.forEach(f=>f());}};}
test('a bound document Port validates sender identity and never routes its replies as click commands',async()=>{
  const w=worker(activeData()),d=w.documentSession(),p=documentPort();w.connect(p.port);p.receive({kind:'bind',runId:'run'});
  assert.equal(p.sent[0].kind,'ready');assert(d.session.requiresDocumentPort);
  const answer=d.request({action:'validateCdpPointer',runId:'run'}),query=p.sent.at(-1);
  p.receive({kind:'response',runId:'wrong',id:query.id,result:{success:true}});
  p.receive({kind:'cdpClick',runId:'run',id:999});assert.equal(w.sends(),0);
  p.receive({kind:'response',runId:'run',id:query.id,result:{success:true,point:{x:10}}});assert.equal((await answer).point.x,10);
  d.session.closing=true;p.drop();assert.equal(w.sends(),0);
});
for(const change of [{id:'foreign'},{tab:{id:8}},{frameId:0},{documentId:'replacement'}])test('a foreign document Port cannot bind '+JSON.stringify(change),()=>{
  const w=worker(activeData()),d=w.documentSession(),p=documentPort(change);w.connect(p.port);p.receive({kind:'bind',runId:'run'});
  assert(p.closed());assert.equal(p.sent.length,0);assert(!d.session.canceled);
});
test('losing a bound document Port rejects its pending validation and interrupts without legacy replay',async()=>{
  const w=worker(activeData()),d=w.documentSession(),p=documentPort();w.connect(p.port);p.receive({kind:'bind',runId:'run'});
  const response=d.request({action:'validateCdpTarget',runId:'run'}),outcome=assert.rejects(response,/연결 해제/);
  p.drop();await outcome;assert(d.session.canceled);assert.equal(w.sends(),0);
  await new Promise(setImmediate);assert.equal(w.data.macroRun.status,'interrupted');
});
test('compact active state still returns complete matching history through getStatus',async()=>{
  const data=activeData();delete data.macroRun.logs;data.macroLogs=[{runId:'other',event:'foreign'},{runId:'run',event:'history'}];
  // A terminal run does not need a live document for this public read.
  data.macroRun.status='completed';const result=await worker(data).request('getStatus');
  assert.deepEqual(result.run.logs.map(l=>l.event),['history']);assert.equal(data.macroRun.logs,undefined);
});
test('status polling preserves a pending explicit stop after immediate CDP cancellation',async()=>{
  const w=worker(activeData()),d=w.documentSession();d.session.canceled=true;d.session.userStopRequested=true;
  const status=await w.request('getStatus');assert.equal(status.run.status,'watching');
  assert(!w.data.macroRun.logs.some(log=>log.event==='controller-stop'));
  assert((await w.request('stopMacro')).success);assert.equal(w.data.macroRun.status,'stopped');
});
function inputData(){
  const data=activeData();Object.assign(data.macroRun,{stepIndex:0,cycle:1});
  data.macroLogs=[{runId:'run',event:'checkpoint'}];
  const request={runId:'run',attemptId:'attempt',intent:{stepIndex:0,cycle:1,message:'CDP 입력 준비',lastObservation:{button:{ready:true}},
    lastAttempt:{event:'click-attempt',runId:'run',attemptId:'attempt',clickMethod:'cdp',timestamp:123,actionableDetectedAt:120,actionableMonotonicMs:10}}};
  const marker={runId:'run',tabId:7,state:'input-claimed',attemptId:'attempt',inputSessionId:'child'};
  return {data,request,marker};
}

test('input intent and child recovery route use one compact write without changing profiles or log checkpoints',async()=>{
  const {data,request,marker}=inputData(),before=C.clone(data.macroRun.profile),w=worker(data);
  request.intent.profile={url:'https://foreign.test/'};request.intent.stopRequested=false;
  await w.inputCommit(request,marker).flight;
  assert.equal(w.behavior.writes.length,1);assert(w.behavior.writes[0].macroRun);assert(w.behavior.writes[0].ticketCdpSession);
  assert.equal(data.macroRun.logs,undefined);assert.equal(data.macroRun.status,'verifying');assert.deepEqual(data.macroRun.profile,before);
  assert.equal(data.macroRun.lastAttempt.attemptId,'attempt');assert.deepEqual(data.ticketCdpSession,marker);assert.equal(data.macroLogs[0].event,'checkpoint');
});

test('stopped or mismatched input intent is rejected before any write',async()=>{
  for(const mode of ['stopped','canceled','wrong-step','wrong-attempt','missing']){
    const {data,request,marker}=inputData();if(mode==='stopped')data.macroRun.stopRequested=true;
    if(mode==='wrong-step')request.intent.stepIndex=1;if(mode==='wrong-attempt')request.intent.lastAttempt.attemptId='older';if(mode==='missing')delete request.intent;
    const w=worker(data);await assert.rejects(w.inputCommit(request,marker,{canceled:mode==='canceled'}).flight,/중지|클릭 준비/);
    assert.equal(w.behavior.writes,undefined);
  }
});

test('tab termination cancels and drains an input write without waiting on the control queue',async()=>{
  const {data,request,marker}=inputData();let finish;
  const w=worker(data,{beforeWrite:patch=>patch.ticketCdpSession?.state==='input-claimed'?new Promise(resolve=>{finish=resolve;}):undefined});
  const input=w.inputCommit(request,marker);input.session.flight=input.flight.catch(()=>{});
  const rejected=assert.rejects(input.flight,/중지/);await new Promise(setImmediate);assert(finish);
  w.removed(7);await new Promise(setImmediate);assert.equal(input.session.canceled,true);
  finish();await rejected;await w.request('getStatus');
  assert.equal(data.macroRun.status,'interrupted');assert.equal(data.ticketCdpSession,null);
  assert(data.macroLogs.some(log=>log.event==='click-attempt'));
});

test('an external terminal snapshot during commit cannot be overwritten with a live run',async()=>{
  const {data,request,marker}=inputData();let finish;
  const w=worker(data,{beforeWrite:patch=>patch.ticketCdpSession?.state==='input-claimed'?new Promise(resolve=>{finish=resolve;}):undefined});
  const input=w.inputCommit(request,marker);input.session.flight=input.flight.catch(()=>{});
  const rejected=assert.rejects(input.flight,/중지/);await new Promise(setImmediate);
  const stopped={...data.macroRun,status:'stopped',message:'user stopped',logs:[{runId:'run',event:'user-stop'}]};
  data.macroRun=stopped;w.storageChanged({macroRun:{newValue:stopped}});finish();await rejected;
  await new Promise(setImmediate);assert.equal(data.macroRun.status,'stopped');assert.equal(data.macroRun.message,'user stopped');assert.equal(data.ticketCdpSession,null);
});

test('successful worker setup is shared while current settings remain fresh',async()=>{
  const w=worker();await w.request('getSettings');
  w.data.ticketProfiles[0].name='수정한 프로필';
  for(let i=0;i<5;i++)assert.equal((await w.request('getSettings')).ticketProfiles[0].name,'수정한 프로필');
  assert.equal(w.behavior.setupReads,1);assert.equal(w.behavior.started,undefined);
  const fresh=worker(w.data);assert.equal((await fresh.request('getSettings')).ticketProfiles[0].name,'수정한 프로필');
  assert.equal(fresh.behavior.setupReads,1);
});

test('failed setup or recovery may retry without starting any input',async()=>{
  for(const behavior of [{setupFailures:1},{recoveryFailures:1}]){
    const w=worker({},behavior);
    assert.equal((await w.request('getSettings')).success,false);
    const recovered=await w.request('getSettings');assert.equal(recovered.success,true);assert(recovered.ticketProfiles.length);
    assert.equal(w.behavior.started,undefined);assert.equal(w.data.macroRun,undefined);
  }
});

test('removing setup storage invalidates initialization and restores defaults on the next request',async()=>{
  const w=worker();await w.request('getSettings');const old=w.data.ticketProfiles;
  for(const key of Object.keys(w.data))delete w.data[key];
  w.storageChanged({ticketProfiles:{oldValue:old,newValue:undefined}});
  const restored=await w.request('getSettings');assert(restored.ticketProfiles.some(p=>p.id==='claude-practice'));
  assert.equal(w.behavior.setupReads,2);assert.equal(w.behavior.started,undefined);
});
test('controller termination preserves last observed button and pointer with an explicit unavailable-current-DOM marker',async()=>{
  for(const observed of [false,true]) {
    const data=activeData();data.macroRun.monitorStartedAt=Date.now()-1000;
    if(observed)data.macroRun.lastObservation={capturedAt:Date.now()-500,phase:'watching',button:{found:true,connected:true,ready:true,text:'예매하기',disabled:false,className:'primary'},pointer:{state:'missing',ready:false,hasPosition:false,x:null,y:null}};
    const w=worker(data);w.removed(7);await new Promise(resolve=>setTimeout(resolve,10));
    const diagnostic=data.macroRun.finalDiagnostics;assert(diagnostic);assert.equal(diagnostic.source,'controller-last-observation');assert.equal(diagnostic.liveDomAvailable,false);
    assert.equal(diagnostic.button.ready,observed?true:null);assert.equal(diagnostic.pointer.ready,observed?false:null);
    assert(diagnostic.timing.monitorElapsedMs>=1000);assert.equal(diagnostic.timing.monitorEndedAt,data.macroRun.endedAt);
    const record=data.macroLogs.find(log=>log.event==='run-diagnostics');assert.equal(JSON.parse(record.diagnosticJson).source,diagnostic.source);
    assert.match(record.message,/현재 DOM 확인 불가/);
  }
});

test('controller termination restores input-gate history only from the matching run checkpoint',async()=>{
  for(const matching of [true,false]){
    const data=activeData();delete data.macroRun.logs;
    data.macroRun.lastAttempt={runId:'run',event:'click-attempt',timestamp:123};
    data.macroLogs=[{runId:matching?'run':'older-run',event:'prior-diagnostic',timestamp:100}];
    const w=worker(data);w.removed(7);await w.request('getStatus');
    assert.equal(data.macroRun.status,'interrupted');
    assert.equal(data.macroLogs.some(log=>log.event==='prior-diagnostic'),matching);
    assert.equal(data.macroLogs.filter(log=>log.event==='click-attempt').length,1);
    assert(data.macroLogs.some(log=>log.event==='controller-stop'));
  }
});

test('prepared start validation binds the captured documents without saving or starting',async()=>{
  const frames=[{frameId:0,url:C.INITIAL_URL,documentId:'doc-0'},{frameId:2,url:C.FRAME_ORIGIN+'/_f/123',documentId:'doc-2'}];
  const w=worker({}, {frames});await w.request('getSettings');const before=C.clone(w.data.ticketProfiles);
  const captureTarget={tabId:7,frameId:2,documentId:'doc-2',topDocumentId:'doc-0',topUrl:C.INITIAL_URL};
  assert.equal((await w.request({action:'validatePreparedStart',profile:C.defaultProfile(),captureTarget})).success,true);
  assert.deepEqual(w.data.ticketProfiles,before);assert.equal(w.data.macroRun,undefined);assert.equal(w.behavior.started,undefined);
  for(const changed of [{tabId:8},{documentId:'new-document'},{topDocumentId:'new-top-document'},{topUrl:C.INITIAL_URL+'?changed=1'}]) {
    const result=await w.request({action:'validatePreparedStart',profile:C.defaultProfile(),captureTarget:{...captureTarget,...changed}});
    assert.equal(result.success,false);assert.match(result.error,/변경/);
  }
});
test('start rejects a replaced captured document or changed saved profile before creating a run',async()=>{
  const w=worker();await w.request('getSettings');
  const captureTarget={tabId:7,frameId:2,documentId:'new-document',topDocumentId:'doc-0',topUrl:C.INITIAL_URL};
  const changedDocument=await w.request({action:'startMacro',captureTarget});assert.equal(changedDocument.success,false);assert.match(changedDocument.error,/변경/);
  const expectedProfile=C.clone(w.data.ticketProfiles[0]);expectedProfile.scopeSelector='#changed';
  const changedProfile=await w.request({action:'startMacro',expectedProfile});assert.equal(changedProfile.success,false);assert.match(changedProfile.error,/설정이 변경/);
  assert.equal(w.data.macroRun,undefined);assert.equal(w.behavior.started,undefined);
});
test('equivalent settings with reordered storage keys are accepted',async()=>{
  const w=worker();await w.request('getSettings');
  const expectedProfile=JSON.parse(JSON.stringify(w.data.ticketProfiles[0],(key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?
    Object.fromEntries(Object.keys(value).reverse().map(name=>[name,value[name]])):value));
  assert.equal((await w.request({action:'startMacro',expectedProfile})).success,true);assert.equal(w.behavior.started,1);
});
test('serialized collection errors retain their real cause and leave saved settings untouched',async()=>{
  const behavior={...captureBehavior(),captured:{captureError:'선택한 Shadow 경로에 버튼이 없습니다.'}},w=worker({},behavior);
  await w.request('getSettings');const before=C.clone(w.data.ticketProfiles);
  const result=await w.request({action:'captureCurrentTab',profile:C.nolProfile()});
  assert.equal(result.success,false);assert.match(result.error,/Shadow 경로/);assert(!/페이지가 이동/.test(result.error));assert.deepEqual(w.data.ticketProfiles,before);
});
test('already-open seat page prevents capture and prepared start before injection or settings mutation',async()=>{
  const behavior={queryUrl:'https://tickets.interpark.com/onestop/seat'},w=worker({},behavior);
  await w.request('getSettings');const before=C.clone(w.data.ticketProfiles);
  for(const action of ['captureCurrentTab','validatePreparedStart']) {
    const result=await w.request({action,profile:C.nolProfile()});assert.equal(result.success,false);assert.match(result.error,/이미 좌석 선택/);
  }
  assert.deepEqual(w.data.ticketProfiles,before);assert.equal(w.data.macroRun,undefined);assert.equal(behavior.injections,undefined);
});
test('seat redirect during capture reports its state even if injection failed or returned a missing button',async()=>{
  for(const patch of [{injectError:'Frame removed'},{captured:{captureError:'예매 버튼을 찾지 못했습니다.'}},{captured:{documentUrl:C.NOL_URL,buttons:[]}}]) {
    const behavior={...captureBehavior(),url:'https://tickets.interpark.com/onestop/seat',...patch},w=worker({},behavior);
    await w.request('getSettings');const before=C.clone(w.data.ticketProfiles);
    const result=await w.request({action:'captureCurrentTab',profile:C.nolProfile()});assert.equal(result.success,false);assert.match(result.error,/이미 좌석 선택/);
    assert.equal(w.data.macroRun,undefined);assert.deepEqual(w.data.ticketProfiles,before);
  }
});
test('last click method persists across worker instances without rewriting profile settings',async()=>{
  const w=worker();await w.request('getSettings');const before=C.clone(w.data.ticketProfiles);
  assert.equal((await w.request({action:'setClickMethod',value:'cdp'})).success,true);
  assert.deepEqual(w.data.ticketProfiles,before);
  const next=worker(w.data);assert.equal((await next.request('getSettings')).ticketClickMethod,'cdp');
  assert.equal((await next.request({action:'setClickMethod',value:'auto'})).success,false);
  assert.equal((await next.request({action:'setClickMethod',value:'javascript'})).success,false);
  const running=worker(activeData());assert.equal((await running.request({action:'setClickMethod',value:'cdp'})).success,false);
});

test('selecting a site persists across workers without starting or rewriting profile data',async()=>{
  const w=worker();await w.request('getSettings');const before=C.clone(w.data.ticketProfiles);
  const result=await w.request({action:'selectProfile',profileId:'nol-postseason'});
  assert.equal(result.success,true);assert.equal(w.data.activeProfileId,'nol-postseason');assert.deepEqual(w.data.ticketProfiles,before);
  assert.equal(w.behavior.started,undefined);assert.equal(w.behavior.injections,undefined);assert.equal(w.data.macroRun,undefined);
  const next=worker(w.data);assert.equal((await next.request('getSettings')).activeProfileId,'nol-postseason');
});

test('unknown and running site selections are rejected without changing the stored selection',async()=>{
  const w=worker();await w.request('getSettings');
  assert.equal((await w.request({action:'selectProfile',profileId:'missing'})).success,false);
  assert.equal(w.data.activeProfileId,'claude-practice');
  const running=worker(activeData());const result=await running.request({action:'selectProfile',profileId:'nol-postseason'});
  assert.equal(result.success,false);assert.match(result.error,/중지/);assert.equal(running.data.activeProfileId,'claude-practice');
});
test('corrupted saved transport aborts instead of silently invoking JavaScript',async()=>{
  const p=C.defaultProfile(),w=worker({ticketProfiles:[p],activeProfileId:p.id,ticketClickMethod:'auto'});
  const result=await w.request('startMacro');assert.equal(result.success,false);assert.match(result.error,/자동 전환하지/);
  assert.equal(w.behavior.injections,undefined);assert.equal(w.behavior.started,undefined);
});
test('stop received before a queued start prevents the document engine from starting',async()=>{
  const w=worker();const start=w.request('startMacro'),stop=w.request('stopMacro');
  const result=await start;await stop;assert.equal(result.success,false);assert.match(result.error,/중지/);
  assert.equal(w.behavior.started,undefined);assert.equal(w.data.macroRun.status,'stopped');
});
function legacyNol() {
  const p=C.nolProfile();p.name='NOL 포스트시즌';p.siteAdapter='nol-postseason';p.url=C.NOL_LEGACY_URL;
  p.scopeSelector='section[id^="GOODS_RESERVATION-"]';p.steps[0].selector='button.grid-area_cta';
  p.steps[0].name='선택한 경기 예매하기';p.steps[0].readySelector='button:not(:disabled):not([aria-disabled="true"])';
  p.safetySelectors=['[role="dialog"]','[role="alertdialog"]','[aria-modal="true"]'];
  p.steps[0].containerSelector='div:has(> .grid-area_info):has(> button.grid-area_cta)';
  p.steps[0].buttonText='예매하기';p.steps[0].targetText='와일드카드결정전 2차전\n10월 15일(목) 18:30';
  return p;
}
test('fresh worker recovers running document status from durable storage', async()=>{
  const w=worker(activeData()); const result=await w.request('getStatus');
  assert.equal(result.run.id,'run'); assert.equal(result.run.status,'watching'); assert.equal(w.behavior.started,undefined);
});
test('lost document ends without starting or replaying clicks', async()=>{
  const w=worker(activeData(),{lost:true}); const result=await w.request('getStatus');
  assert.equal(result.run.status,'interrupted'); assert.equal(w.behavior.started,undefined);
});
test('another URL interrupts a stored run',async()=>{
  const w=worker(activeData(),{url:'https://claude.ai/other'}); const result=await w.request('getStatus');
  assert.equal(result.run.status,'interrupted'); assert.equal(w.sends(),0);
});
test('duplicate start rejected and single start binds one document',async()=>{
  const data=activeData(); const w=worker(data); assert.equal((await w.request('startMacro')).success,false);
  delete data.macroRun; assert.equal((await w.request('startMacro')).success,true);
  assert.equal(w.behavior.started,1); assert.equal(data.macroRun.documentId,'doc-2');
});
test('permission denial never injects or starts',async()=>{
  const data=activeData(); delete data.macroRun; const w=worker(data,{permission:false});
  const result=await w.request('startMacro'); assert.equal(result.success,false); assert.equal(w.behavior.started,undefined);
});
test('stop is durable and sent directly to the bound document',async()=>{
  const w=worker(activeData()); await w.request('stopMacro');
  assert.equal(w.data.macroRun.stopRequested,true); assert.equal(w.data.macroRun.status,'stopped');
});
test('browser restart terminates rather than resuming',async()=>{
  const w=worker(activeData()); w.startup(); await w.request('getStatus');
  assert.equal(w.data.macroRun.status,'interrupted'); assert.equal(w.behavior.started,undefined);
});
test('subframe navigation ends only the matching document',async()=>{
  const w=worker(activeData()); w.committed({tabId:7,frameId:8,documentId:'other'}); await w.request('getStatus');
  assert.equal(w.data.macroRun.status,'watching');
  w.committed({tabId:7,frameId:2,documentId:'new'}); await w.request('getStatus'); assert.equal(w.data.macroRun.status,'interrupted');
});
test('closing run tab persists interruption',async()=>{
  const w=worker(activeData()); w.removed(7); await w.request('getStatus'); assert.equal(w.data.macroRun.status,'interrupted');
});
test('upgrade adds site profiles once without replacing existing profile/settings',async()=>{
  const data=activeData();data.ticketProfiles[0].name='내 저장된 프로필';const w=worker(data);
  await w.request('getSettings');assert.equal(data.ticketProfiles.length,3);
  assert.equal(data.ticketProfiles[0].name,'내 저장된 프로필');assert.equal(data.activeProfileId,'claude-practice');
  data.ticketProfiles=data.ticketProfiles.filter(p=>p.id!=='nol-postseason');
  await w.request('getSettings');assert.equal(data.ticketProfiles.length,2);
});
test('fresh install retains Claude initial site and includes NOL as another profile',async()=>{
  const w=worker();const data=await w.request('getSettings');
  assert.equal(data.activeProfileId,'claude-practice');assert.deepEqual(data.ticketProfiles.map(p=>p.id),['claude-practice','nol-postseason','practicket-n-ticket']);
});
test('new tab verification only targets the running source opener/document',async()=>{
  const data=activeData();data.macroRun.profile=C.nolProfile();const w=worker(data,{url:C.NOL_URL});
  w.created({id:99,openerTabId:8});await w.request('getStatus');
  assert(!w.behavior.messages.some(m=>m.request.action==='contextOpened'));
  w.created({id:100,openerTabId:7});await w.request('getStatus');
  const event=w.behavior.messages.find(m=>m.request.action==='contextOpened');
  assert.equal(event.request.runId,'run');assert.equal(event.request.tabId,100);assert.equal(event.options.documentId,'doc-2');
});
test('navigation after a persisted click becomes handoff, never another click',async()=>{
  const data=activeData();data.macroRun.profile=C.nolProfile();data.macroRun.frameId=0;
  data.macroRun.stepIndex=0;data.macroRun.lastAttempt={event:'click-attempt'};const w=worker(data,{url:C.NOL_URL});
  w.committed({tabId:7,frameId:0,documentId:'new'});await w.request('getStatus');
  assert.equal(data.macroRun.status,'handoff');assert.equal(w.behavior.started,undefined);
});
test('legacy NOL settings migrate to gate; old game selectors are backed up',async()=>{
  const profile=legacyNol();profile.settings.prepareSeconds=30;profile.settings.testMode=false;
  profile.settings.mode='hybrid';profile.settings.scheduledAt=Date.now()+3600000;
  const expected=C.nolProfile();expected.settings={...profile.settings,prepareSeconds:60};
  const w=worker({ticketProfiles:[profile],activeProfileId:profile.id,profileSchemaVersion:'2.1.0'});
  const data=await w.request('getSettings');assert.deepEqual(data.ticketProfiles[0],expected);
  assert.equal(data.activeProfileId,profile.id);assert.equal(w.data.nolPreparationRevision,'60s-v1');
  assert.equal(w.data.nolGateProfileRevision,'gate-26014670-v1');
  assert.equal(w.data.nolGatePreviousProfiles[0].steps[0].targetText,profile.steps[0].targetText);
  assert.equal(data.ticketProfiles[0].steps[0].targetText,'');
});
test('preparation migration preserves customized NOL timing and other profiles',async()=>{
  const nol=legacyNol();nol.settings.prepareSeconds=45;nol.name='내 대기 프로필';const claude=C.defaultProfile();
  const w=worker({ticketProfiles:[nol,claude],activeProfileId:nol.id,profileSchemaVersion:'2.1.0'});
  const data=await w.request('getSettings');assert.equal(data.ticketProfiles[0].settings.prepareSeconds,45);
  assert.equal(data.ticketProfiles[1].settings.prepareSeconds,30);
  assert.equal(data.ticketProfiles[0].name,'내 대기 프로필');assert.equal(data.ticketProfiles[0].url,C.NOL_URL);
});
test('preparation migration runs once so later user choices persist',async()=>{
  const p=legacyNol();p.settings.prepareSeconds=30;
  const w=worker({ticketProfiles:[p],activeProfileId:p.id,profileSchemaVersion:'2.1.0'});
  await w.request('getSettings');w.data.ticketProfiles[0].settings.prepareSeconds=30;
  await w.request('getSettings');assert.equal(w.data.ticketProfiles[0].settings.prepareSeconds,30);
});
test('gate migration runs once, preserves edits/deletions and unrelated custom sites',async()=>{
  const p=legacyNol();const custom={...legacyNol(),id:'custom',siteAdapter:'',url:'https://example.com/custom'};
  const w=worker({ticketProfiles:[p,custom],activeProfileId:p.id,profileSchemaVersion:'2.1.0'});
  await w.request('getSettings');assert.deepEqual(w.data.ticketProfiles[1],custom);
  w.data.ticketProfiles[0].steps[0].buttonText='내 변경 문구';
  await w.request('getSettings');assert.equal(w.data.ticketProfiles[0].steps[0].buttonText,'내 변경 문구');
  w.data.ticketProfiles=w.data.ticketProfiles.filter(p=>p.id!=='nol-postseason');
  await w.request('getSettings');assert(!w.data.ticketProfiles.some(p=>p.id==='nol-postseason'));
});
test('old unscheduled hybrid defaults become activation without changing other settings',async()=>{
  const p=C.nolProfile();p.settings.mode='hybrid';p.settings.scheduledAt=null;
  const expected=JSON.parse(JSON.stringify(p));expected.settings.mode='activation';
  const w=worker({ticketProfiles:[p],activeProfileId:p.id,profileSchemaVersion:'2.1.0',nolPreparationRevision:'60s-v1'});
  const data=await w.request('getSettings');assert.deepEqual(data.ticketProfiles[0],expected);
  assert.equal(w.data.executionDefaultsRevision,'activation-v1');
});
test('saved explicit hybrid schedule survives the default-mode change',async()=>{
  const p=C.nolProfile();p.settings.mode='hybrid';p.settings.scheduledAt=Date.now()+3600000;
  const w=worker({ticketProfiles:[p],activeProfileId:p.id,profileSchemaVersion:'2.1.0',nolPreparationRevision:'60s-v1'});
  const data=await w.request('getSettings');assert.deepEqual(data.ticketProfiles[0],p);
  w.data.ticketProfiles[0].settings.scheduledAt=null;
  await w.request('getSettings');assert.equal(w.data.ticketProfiles[0].settings.mode,'hybrid');
});
test('Practicket addition preserves existing settings and does not recreate a deleted profile',async()=>{
  const profile=C.nolProfile();profile.settings.testMode=false;profile.settings.pollingMs=100;
  const w=worker({ticketProfiles:[profile],activeProfileId:profile.id,profileSchemaVersion:'2.1.0',nolPreparationRevision:'60s-v1',executionDefaultsRevision:'activation-v1'});
  const data=await w.request('getSettings');assert.deepEqual(data.ticketProfiles[0],profile);
  assert.equal(data.activeProfileId,profile.id);assert.equal(data.ticketProfiles[1].id,'practicket-n-ticket');
  w.data.ticketProfiles=w.data.ticketProfiles.filter(p=>p.id!=='practicket-n-ticket');
  await w.request('getSettings');assert.equal(w.data.ticketProfiles.length,1);
});
test('saved NOL default name becomes NOL ticket without resetting edited product or settings',async()=>{
  const p=C.nolProfile();p.name='NOL 포스트시즌 대기 화면';p.url='https://tickets.interpark.com/gates/ticket/26099999?bc=1';
  p.steps[0].buttonText='10/20 10:00 예매하기';p.settings.mode='hybrid';p.settings.scheduledAt=Date.now()+3600000;
  p.settings.prepareSeconds=45;p.settings.testMode=false;
  const w=worker({ticketProfiles:[p],activeProfileId:p.id,profileSchemaVersion:'2.1.0',
    nolPreparationRevision:'60s-v1',executionDefaultsRevision:'activation-v1',practicketProfileRevision:'intro-v1',nolGateProfileRevision:'gate-26014670-v1'});
  const data=await w.request('getSettings');assert.deepEqual(data.ticketProfiles[0],{...p,name:'NOL 티켓'});
  assert.equal(data.activeProfileId,p.id);assert.equal(w.data.nolTicketProfileRevision,'name-url-v1');
  w.data.ticketProfiles[0].name='내 공연';await w.request('getSettings');assert.equal(w.data.ticketProfiles[0].name,'내 공연');
});
test('NOL name migration preserves custom names, other profiles and deleted NOL profiles',async()=>{
  const p=C.nolProfile();p.name='내 스포츠';const other=C.practicketProfile();other.name='NOL 포스트시즌';
  const w=worker({ticketProfiles:[p,other],activeProfileId:p.id,profileSchemaVersion:'2.1.0',
    nolPreparationRevision:'60s-v1',executionDefaultsRevision:'activation-v1',practicketProfileRevision:'intro-v1',nolGateProfileRevision:'gate-26014670-v1'});
  await w.request('getSettings');assert.deepEqual(w.data.ticketProfiles,[p,other]);
  w.data.ticketProfiles=[other];w.data.activeProfileId=other.id;
  await w.request('getSettings');assert.deepEqual(w.data.ticketProfiles,[other]);
});

function captureBehavior() {
  const url='https://tickets.interpark.com/gates/ticket/26099999?bc=1';const p=C.nolProfile();
  return {queryUrl:url,frames:[{frameId:0,url,documentId:'doc-0'}],
    captured:{documentUrl:url,buttons:[{text:'10/20 10:00 예매하기',selector:p.steps[0].selector,scopeSelector:p.scopeSelector,disabled:true}]}};
}
test('multiple NOL tabs are collected by the current tab ID for numeric and P products',async()=>{
  const urls=['https://tickets.interpark.com/gates/ticket/26014841?bc=61776&pc=21000190&ps=&pass_code=',
    'https://tickets.interpark.com/gates/ticket/P0004869?bc=61776&pc=P1001005&ps=&pass_code='];
  const behavior=captureBehavior(),w=worker({},behavior);
  for(let i=0;i<4;i++) {
    const index=i%2;behavior.queryUrl=urls[index];behavior.queryTabId=7+index;
    behavior.captured={documentUrl:urls[index],buttons:[{selector:'#buy',scopeSelector:'#scope',text:'현재 상품 '+index+' 예매하기'}]};
    behavior.frames=[{frameId:0,documentId:'doc-0',url:urls[index]}];
    const result=await w.request({action:'captureCurrentTab',profile:C.nolProfile()});assert.equal(result.success,true,result.error);
    assert.equal(result.captured.url,urls[index]);assert.equal(result.captured.target.tabId,7+index);assert.equal(result.currentTab.id,7+index);
  }
});
test('another NOL product rediscovers captured per-product selectors without rewriting saved settings',async()=>{
  const p=C.nolProfile();p.url='https://tickets.interpark.com/gates/ticket/26014841';p.scopeSelector='#old-product';
  Object.assign(p.steps[0],{selector:'#old-product',bindButtonText:true});
  const behavior=captureBehavior();behavior.queryUrl='https://tickets.interpark.com/gates/ticket/P0004869';
  behavior.captured={documentUrl:behavior.queryUrl,buttons:[{selector:'#new-product',scopeSelector:'#scope',text:'예매하기'}]};
  behavior.frames=[{frameId:0,documentId:'doc-0',url:behavior.queryUrl}];
  const w=worker({ticketProfiles:[p],activeProfileId:p.id},behavior),result=await w.request({action:'captureCurrentTab',profile:p});
  assert.equal(result.success,true,result.error);assert.equal(behavior.injections[0].args[0].steps[0].selector,C.nolProfile().steps[0].selector);
  assert.equal(w.data.ticketProfiles[0].steps[0].selector,'#old-product');assert.equal(p.scopeSelector,'#old-product');
});
test('a tab switch while collecting discards the old document result',async()=>{
  const behavior=captureBehavior();let calls=0;
  behavior.query=()=>[{id:++calls===1?7:8,url:behavior.queryUrl}];
  const w=worker({},behavior),result=await w.request({action:'captureCurrentTab',profile:C.nolProfile()});
  assert.equal(result.success,false);assert.match(result.error,/활성 탭이 변경/);assert.equal(result.currentTab.id,8);assert.equal(result.captured,undefined);
});
test('closing an unrelated tab never ends the bound run',async()=>{
  const w=worker(activeData());w.removed(8);await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(w.data.macroRun.status,'watching');assert.equal(w.data.macroRun.tabId,7);
});
test('current-tab capture reads a new NOL product in one document without starting or storing a run',async()=>{
  const behavior=captureBehavior();const w=worker({},behavior);
  const result=await w.request({action:'captureCurrentTab',profile:C.nolProfile()});
  assert.equal(result.success,true);assert.equal(result.captured.url,behavior.queryUrl);
  assert.equal(result.captured.buttons[0].text,'10/20 10:00 예매하기');assert.equal(result.captured.frameUrl,'');
  assert.equal(w.data.macroRun,undefined);assert.equal(behavior.started,undefined);assert.equal(w.sends(),0);
  assert.equal(behavior.injections.length,1);assert.equal(behavior.injections[0].func,TicketCapture.readButtons);
  assert.equal(behavior.injections[0].target.documentIds[0],'doc-0');assert.equal(behavior.injections[0].target.allFrames,undefined);
});
test('capture rejects a running macro or a different site without injecting',async()=>{
  const running=worker(activeData(),captureBehavior());
  assert.equal((await running.request({action:'captureCurrentTab',profile:C.nolProfile()})).success,false);
  assert.equal(running.behavior.injections,undefined);
  const wrong=worker({}, {queryUrl:'https://example.com/tickets'});
  assert.equal((await wrong.request({action:'captureCurrentTab',profile:C.nolProfile()})).success,false);
  assert.equal(wrong.behavior.injections,undefined);
});
test('capture rejects URL movement and same-URL document replacement instead of importing stale data',async()=>{
  for(const extra of [{url:'https://tickets.interpark.com/gates/ticket/26011111'},
    {nextFrames:[{frameId:0,url:captureBehavior().queryUrl,documentId:'replacement'}]}]) {
    const w=worker({}, {...captureBehavior(),...extra});
    const result=await w.request({action:'captureCurrentTab',profile:C.nolProfile()});
    assert.equal(result.success,false);assert.match(result.error,/페이지/);assert.equal(w.data.macroRun,undefined);
  }
});
test('capture requires cross-origin iframe permission and selects only the configured frame',async()=>{
  const p=C.defaultProfile();const missing=worker({}, {permission:false});
  const denied=await missing.request({action:'captureCurrentTab',profile:p});
  assert.equal(denied.success,false);assert.match(denied.error,/iframe 접근 권한/);assert.equal(missing.behavior.injections,undefined);
  const frameUrl=C.FRAME_ORIGIN+'/_f/123';
  const allowed=worker({}, {captureFrameId:2,captureDocumentId:'doc-2',frames:[{frameId:0,url:C.INITIAL_URL},{frameId:2,url:frameUrl,documentId:'doc-2'}],
    captured:{documentUrl:frameUrl,buttons:[{text:'예매하기',selector:'#bookBtn',scopeSelector:'.screen'}]}});
  const result=await allowed.request({action:'captureCurrentTab',profile:p});
  assert.equal(result.success,true);assert.equal(result.captured.frameUrl,C.FRAME_ORIGIN);
  assert.equal(allowed.behavior.injections[0].target.documentIds[0],'doc-2');
});
test('capture errors leave saved profile URL and button text intact',async()=>{
  const p=C.nolProfile();const w=worker({ticketProfiles:[p],activeProfileId:p.id}, {...captureBehavior(),injectError:'버튼 없음'});
  const result=await w.request({action:'captureCurrentTab',profile:p});assert.equal(result.success,false);
  assert.equal(w.data.ticketProfiles.find(item=>item.id===p.id).url,p.url);
  assert.equal(w.data.ticketProfiles.find(item=>item.id===p.id).steps[0].buttonText,p.steps[0].buttonText);
});

const A = require('../analyze.js');
function analysisBehavior(extra = {}) {
  const url = 'https://example.com/current?x=1#top';
  return {queryUrl: url, frames: [{frameId: 0, parentFrameId: -1, url, documentId: 'doc-0'}],
    captured: {documentUrl: url, title: '현재 화면', buttons: [{text:'예매', disabled:true, disabledReasons:['native disabled'],
      inViewport:true, path:'#reserve', accessibleLabel:'', shadow:''}], frames:[], warnings:[], truncated:false,
      coverage:{shadowRoots:0, closedShadowRoots:0, hiddenButtons:0}}, ...extra};
}
test('page analysis reads any active URL independently of profile and leaves the macro/profile untouched', async () => {
  const p = C.nolProfile(), w = worker({ticketProfiles:[p], activeProfileId:p.id}, analysisBehavior());
  await w.request('getSettings'); const before = C.clone(w.data);
  const result = await w.request('analyzeCurrentPage');
  assert.equal(result.success,true); assert.equal(result.analysis.url,w.behavior.queryUrl);
  assert.equal(result.analysis.buttons[0].disabled,true); assert.deepEqual(w.data,before);
  assert.equal(w.sends(),0); assert.equal(w.behavior.injections[0].func,A.readPage);
  assert.equal(w.behavior.injections[0].world,'ISOLATED'); assert.equal(w.behavior.started,undefined);
});
test('page analysis refuses a running macro without injecting or stopping it', async () => {
  const w = worker(activeData(),analysisBehavior());
  assert.equal((await w.request('analyzeCurrentPage')).success,false);
  assert.equal(w.behavior.injections,undefined); assert.equal(w.data.macroRun.status,'watching');
});
test('restricted page URL is still reported with an explicit reason and no injection', async () => {
  const w = worker({},analysisBehavior({queryUrl:'chrome://settings'})), result = await w.request('analyzeCurrentPage');
  assert.equal(result.success,true); assert.equal(result.analysis.url,'chrome://settings');
  assert.equal(result.analysis.partial,true); assert.match(result.analysis.frames[0].reason,/HTTP/);
  assert.equal(w.behavior.injections,undefined);
});
test('frame injection denial reports omissions instead of claiming an empty complete result', async () => {
  const w = worker({},analysisBehavior({injectError:'Cannot access contents of the page'}));
  const {analysis} = await w.request('analyzeCurrentPage');
  assert.equal(analysis.buttons.length,0); assert.equal(analysis.partial,true);
  assert.match(analysis.frames[0].reason,/Cannot access/);
});
test('analysis rejects top URL movement and discards a same-URL replaced document', async () => {
  const moved = worker({},analysisBehavior({url:'https://example.com/moved'}));
  assert.equal((await moved.request('analyzeCurrentPage')).success,false);
  const replaced = worker({},analysisBehavior({nextFrames:[{frameId:0,url:analysisBehavior().queryUrl,documentId:'new'}]}));
  const {analysis} = await replaced.request('analyzeCurrentPage');
  assert.equal(analysis.buttons.length,0); assert.match(analysis.frames[0].reason,/交替|교체/);
});
test('one denied iframe does not erase accessible top and child frame results', async () => {
  const behavior = analysisBehavior();
  behavior.frames.push({frameId:2,parentFrameId:0,url:'https://other.example/frame',documentId:'doc-2'},
    {frameId:3,parentFrameId:0,url:'https://example.com/frame',documentId:'doc-3'});
  behavior.captured.frames = [{url:'https://other.example/frame',visible:true},{url:'https://example.com/frame',visible:true}];
  behavior.analysisResults = {
    0:behavior.captured, 2:new Error('host permission missing'),
    3:{...behavior.captured,documentUrl:'https://example.com/frame',buttons:[{text:'프레임 버튼',disabled:false}],frames:[]}};
  const {analysis} = await worker({},behavior).request('analyzeCurrentPage');
  assert.equal(analysis.buttons.length,2); assert.equal(analysis.buttons[1].frameId,3);
  assert.equal(analysis.frames[1].status,'inaccessible'); assert.equal(analysis.partial,true);
});
test('buttons inside a hidden iframe are excluded and its reason is retained', async () => {
  const behavior = analysisBehavior();
  behavior.frames.push({frameId:2,parentFrameId:0,url:'https://example.com/hidden',documentId:'doc-2'});
  behavior.captured.frames = [{url:'https://example.com/hidden',visible:false}];
  behavior.analysisResults = {0:behavior.captured,2:{...behavior.captured,documentUrl:'https://example.com/hidden',frames:[]}};
  const {analysis} = await worker({},behavior).request('analyzeCurrentPage');
  assert.equal(analysis.buttons.length,1); assert.equal(analysis.frames[1].status,'hidden');
  assert.match(analysis.frames[1].reason,/부모 iframe/);
});
test('frame limit is reported rather than silently dropping extra documents', async () => {
  const behavior=analysisBehavior();
  for(let i=1;i<=50;i++)behavior.frames.push({frameId:i,parentFrameId:0,url:'https://example.com/'+i});
  const {analysis}=await worker({},behavior).request('analyzeCurrentPage');
  assert.equal(analysis.frames.length,51);assert.match(analysis.frames[50].reason,/50개 프레임/);
  assert.equal(behavior.injections.length,50);
});
test('an empty accessible document is a successful analysis',async()=>{
  const behavior=analysisBehavior();behavior.captured.buttons=[];
  const {analysis}=await worker({},behavior).request('analyzeCurrentPage');
  assert.equal(analysis.buttons.length,0);assert.equal(analysis.frames[0].status,'analyzed');
  assert.equal(analysis.partial,false);
});
test('iframe observed in DOM but absent from navigation inventory has a missing-data reason',async()=>{
  const behavior=analysisBehavior();behavior.captured.frames=[{url:'about:srcdoc',visible:true}];
  const {analysis}=await worker({},behavior).request('analyzeCurrentPage');
  assert.equal(analysis.partial,true);assert.match(analysis.frames[0].warnings[0],/iframe.*연결하지 못/);
});
