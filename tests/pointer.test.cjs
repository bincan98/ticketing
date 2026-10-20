'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../content.js'),'utf8');
function engine(sendMessage=async()=>({success:true}),storage,helpers={}) {
  const listeners=new Map(),listen=(type,fn)=>listeners.set(type,fn);
  const document={addEventListener:listen,documentElement:{append(){}},createElement:()=>({style:{},setAttribute(){}})};
  const window={addEventListener(){}};
  const context=vm.createContext({JSON,Date,Set,crypto,performance,queueMicrotask,setTimeout,clearTimeout,viewportKey:()=> 'viewport',innerWidth:800,innerHeight:600,
    document,window,console:{log(){},error(){}},chrome:{runtime:{sendMessage},storage:{local:storage}},...helpers});
  vm.runInContext("const ACTIVE=['starting','scheduled','watching','verifying','repeat-wait','stopping'];let saving=Promise.resolve();"+source.slice(source.indexOf('const POINTER_HELP ='),source.indexOf('const viewportKey ='))+
    source.slice(source.indexOf('const normalize ='),source.indexOf('const parentOf ='))+
    source.slice(source.indexOf('class Engine {'),source.indexOf('chrome.runtime.onMessage.addListener'))+';globalThis.Engine=Engine;globalThis.holdSaving=promise=>{saving=promise;};',context);
  const e=Object.create(context.Engine.prototype);Object.assign(e,{active:true,phase:'watching',settings:{testMode:false},step:{name:'예매'},
    run:{id:'run',cycle:1,stepIndex:0,logs:[]},pointerRevision:3,lastPointer:{x:10,y:20,revision:3},pointerAnchor:{revision:3},pointerNotice:{textContent:''},snapshots:[]});
  e.holdSaving=context.holdSaving;e.testListeners=listeners;e.persist=()=>{e.snapshots.push(JSON.parse(JSON.stringify(e.run)));return Promise.resolve();};return e;
}

test('trusted mouse release restores the current position without another move and still validates it',async()=>{
  const requests=[],e=engine(async request=>{requests.push(request);return {success:true,parentSignature:'checked'};});
  e.pointerPoint=()=>({x:e.lastPointer.x,y:e.lastPointer.y,pointerRevision:e.lastPointer.revision});
  e.evaluate=()=>e.ensurePointerAnchor(e.pointerPoint());e.installUserPointer();
  const event={isTrusted:true,pointerType:'mouse',clientX:100,clientY:80,screenX:110,screenY:100};
  e.testListeners.get('pointermove')({...event,buttons:1});assert.equal(e.lastPointer,null);
  e.testListeners.get('pointerup')({...event,buttons:0});await new Promise(setImmediate);
  assert.equal(e.lastPointer.x,100);assert.equal(e.lastPointer.y,80);assert.equal(e.pointerAnchor.signature,'checked');
  assert(Number.isFinite(e.pointerReadyMonotonicMs));assert.deepEqual(requests.map(r=>r.action),['cdpPointerAnchor']);
  const revision=e.lastPointer.revision;
  e.testListeners.get('pointerup')({...event,buttons:0});await new Promise(setImmediate);
  assert(e.lastPointer.revision>revision,'same-position release reused a stale anchor');assert.equal(requests.length,2);
});

test('release cannot arm a synthetic, touch, still-held, dispatching or stopped pointer',()=>{
  for(const change of [{isTrusted:false},{pointerType:'touch'},{buttons:2},{phase:'dispatching'},{phase:'verifying'},{active:false}]){
    const e=engine();e.installUserPointer();e.lastPointer=null;let evaluations=0;e.evaluate=()=>evaluations++;
    if(change.phase)e.phase=change.phase;if(change.active===false)e.active=false;
    e.testListeners.get('pointerup')({isTrusted:true,pointerType:'mouse',buttons:0,clientX:10,clientY:20,screenX:20,screenY:30,...change});
    assert.equal(e.lastPointer,null);assert.equal(evaluations,0);
  }
});

test('click timing observes trusted current-position input once and separates pointer waiting',()=>{
  const e=engine();e.phase='dispatching';
  const now=performance.now(),attempt={actionableMonotonicMs:now-100,pointerReadyMonotonicMs:now-10,pointerWaitMs:90};
  e.pendingInput={point:{x:10,y:20},attempt};
  const event={type:'pointerdown',isTrusted:true,pointerType:'mouse',button:0,clientX:10,clientY:20};
  for(const change of [{isTrusted:false},{pointerType:'touch'},{clientX:50}])e.observeInputEvent({...event,...change});
  assert.equal(attempt.observedPointerdownAt,undefined);
  e.observeInputEvent(event);const observed=attempt.observedPointerdownMonotonicMs;e.observeInputEvent(event);
  assert.equal(attempt.observedPointerdownMonotonicMs,observed);assert(attempt.activationToPointerdownMs>=100);assert(attempt.readyToPointerdownMs>=10);
  e.observeInputEvent({...event,type:'click'});assert(Number.isFinite(attempt.activationToClickMs));
  e.logClickTiming(attempt);e.logClickTiming(attempt);
  const logs=e.run.logs.filter(log=>log.event==='click-timing');assert.equal(logs.length,1);
  assert.equal(logs[0].inputTimingSource,'trusted-pointerdown');assert.equal(logs[0].pointerWaitMs,90);assert.match(logs[0].message,/마우스 준비 대기 90.0ms/);
  assert.match(logs[0].message,/pointerdown .*ms/);
});

test('unobserved input timings stay explicitly approximate and missing input is never reported as zero',()=>{
  const e=engine();e.logClickTiming({});assert.equal(e.run.logs.length,0);
  e.logClickTiming({detectToInputMs:12});const record=e.run.logs[0];
  assert.equal(record.inputTimingSource,'cdp-command');assert.equal(record.clickLatencyMs,12);assert.match(record.message,/약 12.0ms.*미관측/);
});

for(const stopped of [false,true])test('CDP dispatch drains older saves without another write and '+(stopped?'does not send after a stop':'sends only the compact intent'),async()=>{
  const actions=[],e=engine(async request=>{actions.push(request.action);return {success:true,inputStartedAt:Date.now(),inputFinishedAt:Date.now()};});
  e.pointerPoint=()=>({x:10,y:20,pointerRevision:3});e.afterDispatch=()=>{};
  let writes=0,release;e.persist=()=>{writes++;return Promise.resolve();};
  e.holdSaving(new Promise(resolve=>{release=resolve;}));
  const attempt=e.log('click-attempt','CDP 입력 준비','info',{actionableDetectedAt:Date.now()});
  const flight=e.dispatchCdp(attempt);
  assert.equal(writes,0);assert.equal(actions.length,0);
  if(stopped)e.active=false;release();await flight;
  assert.equal(writes,0);assert.deepEqual(actions,stopped?[]:['cdpClick']);
  assert.equal(attempt.preInputPersistMs,undefined);assert(Number.isFinite(attempt.preInputQueueMs));
});

test('repeated failed mouse anchors are invalidated every time but diagnostics are grouped until recovery',async()=>{
  const requests=[];let valid=false;
  const e=engine(async request=>{requests.push(request);return valid?{success:true,parentSignature:'valid'}:{success:false,error:'Chrome 창 포커스 없음'};});
  e.pointerAnchor=null;e.evaluate=()=>{};
  for(let i=0;i<60;i++){
    e.lastPointer={x:10+i,y:20,revision:++e.pointerRevision,viewportKey:'viewport'};
    e.ensurePointerAnchor({pointerRevision:e.pointerRevision});await new Promise(setImmediate);
    assert.equal(e.lastPointer,null);assert.equal(e.pointerAnchor,null);
  }
  assert.equal(requests.length,60,'focus validation was skipped');
  assert(requests.every(request=>request.action==='cdpPointerAnchor'),'input was sent during failed preparation');
  assert.equal(e.run.logs.filter(log=>log.event==='pointer-position-error').length,1);
  assert.equal(e.run.logs.filter(log=>log.pointerReason==='anchor-failed').length,1);
  assert(e.run.logs.length<10);assert(e.snapshots.length<10);
  valid=true;e.lastPointer={x:30,y:40,revision:++e.pointerRevision,viewportKey:'viewport'};
  e.ensurePointerAnchor({pointerRevision:e.pointerRevision});await new Promise(setImmediate);
  assert.equal(e.pointerAnchor.signature,'valid');assert.equal(e.pointerFailure,null);
  assert.equal(e.run.logs.find(log=>log.event==='pointer-error-summary').repeatCount,60);
});

test('input gate omits historical logs and preserves them at the final save',async()=>{
  const data={macroRun:{id:'run',status:'watching'}},writes=[];
  const storage={get:async()=>JSON.parse(JSON.stringify(data)),set:async patch=>{writes.push(patch);Object.assign(data,patch);}};
  const e=engine(undefined,storage);e.persist=Object.getPrototypeOf(e).persist.bind(e);
  e.run.logs=Array.from({length:250},(_,index)=>({runId:'run',event:'history',message:'diagnostic '.repeat(30),index}));
  e.run.lastAttempt={runId:'run',event:'click-attempt',timestamp:1};
  await e.status('verifying','입력 준비',{input:true});
  assert.equal(writes.length,1);assert.equal(writes[0].macroRun.logs,undefined);assert.equal(writes[0].macroLogs,undefined);
  assert.equal(writes[0].macroRun.lastAttempt.event,'click-attempt');assert.equal(e.run.logs.length,250);
  e.active=false;e.run.status='completed';await e.persist();
  assert.equal(writes[1].macroRun.logs.length,250);assert.equal(writes[1].macroLogs.length,250);
});

test('a failed older checkpoint prevents the compact intent and still cleans up the engine',async()=>{
  const requests=[];
  const e=engine(async request=>{requests.push(request);return {success:true};},{get:async()=>({macroRun:{id:'run',status:'watching'}}),set:async()=>{throw Error('storage write failed');}});
  e.persist=Object.getPrototypeOf(e).persist.bind(e);e.cleanup=()=>{e.cleaned=true;};e.notifyEnd=()=>{};
  e.pointerPoint=()=>({x:10,y:20,pointerRevision:3});
  e.run.status='watching';e.persist();
  const attempt=e.log('click-attempt','입력 준비','info',{actionableDetectedAt:Date.now()});
  await e.dispatchCdp(attempt);
  assert.equal(e.active,false);assert(e.cleaned);assert.equal(requests.length,0);
});

test('ordinary pending checkpoints merge into one latest snapshot with the complete log history',async()=>{
  const data={macroRun:{id:'run',status:'watching'}},writes=[];
  const e=engine(undefined,{get:async()=>JSON.parse(JSON.stringify(data)),set:async patch=>{writes.push(patch);Object.assign(data,patch);}});
  e.persist=Object.getPrototypeOf(e).persist.bind(e);e.run.status='watching';
  let release;e.holdSaving(new Promise(resolve=>{release=resolve;}));
  const pending=[];
  for(let i=0;i<100;i++){e.log('observation','state '+i);e.run.lastObservation={index:i};pending.push(e.status('watching','state '+i));}
  assert(pending.every(p=>p===pending[0]));assert.equal(writes.length,0);
  // A snapshot must not capture mutations which were never requested for save.
  e.run.lastObservation.index=1000;release();await Promise.all(pending);
  assert.equal(writes.length,1);assert.equal(writes[0].macroRun.message,'state 99');
  assert.equal(writes[0].macroRun.lastObservation.index,99);assert.equal(writes[0].macroLogs.length,100);
  assert.equal(e.pendingCheckpoint,null);
});

test('an in-flight checkpoint is never replaced and the following pending checkpoints share one write',async()=>{
  const data={macroRun:{id:'run',status:'watching'}},writes=[];let finish;
  const e=engine(undefined,{get:async()=>JSON.parse(JSON.stringify(data)),set:async patch=>{
    writes.push(patch);if(writes.length===1)await new Promise(resolve=>{finish=resolve;});Object.assign(data,patch);
  }});
  e.persist=Object.getPrototypeOf(e).persist.bind(e);
  const first=e.status('watching','already writing');await new Promise(setImmediate);assert.equal(typeof finish,'function');
  e.log('observation','second');const second=e.status('watching','pending second');
  e.log('observation','third');const third=e.status('watching','latest third');assert.equal(second,third);
  let settled=false;third.then(()=>{settled=true;});await new Promise(setImmediate);assert(!settled);assert.equal(writes.length,1);
  finish();await Promise.all([first,second,third]);assert.equal(writes.length,2);
  assert.equal(writes[0].macroRun.message,'already writing');assert.equal(writes[1].macroRun.message,'latest third');
  assert.equal(writes[1].macroLogs.length,2);
});

test('input and terminal checkpoints form barriers which ordinary checkpoints cannot overwrite',async()=>{
  const data={macroRun:{id:'run',status:'watching'}},writes=[];
  const e=engine(undefined,{get:async()=>JSON.parse(JSON.stringify(data)),set:async patch=>{writes.push(patch);Object.assign(data,patch);}});
  e.persist=Object.getPrototypeOf(e).persist.bind(e);let release;e.holdSaving(new Promise(resolve=>{release=resolve;}));
  const before=e.status('watching','before input');e.run.lastAttempt={attemptId:'one'};
  const input=e.status('verifying','input gate',{input:true});
  const after=e.status('watching','pointer wait');assert.notEqual(after,before);
  e.log('end','all logs retained');e.active=false;e.phase='completed';const terminal=e.status('completed','done');
  release();await Promise.all([before,input,after,terminal]);
  assert.deepEqual(writes.map(p=>p.macroRun.message),['before input','input gate','pointer wait','done']);
  assert.equal(writes[1].macroLogs,undefined);assert.equal(writes[1].macroRun.logs,undefined);
  assert.equal(data.macroRun.status,'completed');assert.equal(data.macroLogs.at(-1).message,'all logs retained');
});

for(const change of [{stopRequested:true},{status:'stopped'},{id:'another-run'}])test('a merged checkpoint respects externally changed control state '+JSON.stringify(change),async()=>{
  const data={macroRun:{id:'run',status:'watching'}},writes=[];
  const e=engine(undefined,{get:async()=>data,set:async patch=>{writes.push(patch);Object.assign(data,patch);}});
  e.persist=Object.getPrototypeOf(e).persist.bind(e);let release;e.holdSaving(new Promise(resolve=>{release=resolve;}));
  const first=e.status('watching','old');const second=e.status('watching','latest');
  Object.assign(data.macroRun,change);release();await Promise.all([first,second]);assert.equal(writes.length,0);
});

for(const failure of ['get','set'])test('a failed merged checkpoint blocks CDP input: '+failure,async()=>{
  const requests=[];let release;
  const e=engine(async request=>{requests.push(request);return {success:true};},{
    get:async()=>{if(failure==='get')throw Error('read failure');return {macroRun:{id:'run',status:'watching'}};},
    set:async()=>{throw Error('write failure');}
  });
  e.persist=Object.getPrototypeOf(e).persist.bind(e);e.cleanup=()=>{e.cleaned=true;};e.notifyEnd=()=>{};
  e.pointerPoint=()=>({x:10,y:20,pointerRevision:3});e.holdSaving(new Promise(resolve=>{release=resolve;}));
  e.status('watching','first');e.status('watching','latest');
  const flight=e.dispatchCdp(e.log('click-attempt','input','info',{actionableDetectedAt:Date.now()}));
  assert.equal(requests.length,0);release();await flight;assert.equal(e.active,false);assert(e.cleaned);assert.equal(requests.length,0);
});

function nolEngine(nodes){
  const e=engine(undefined,undefined,{NOL_PRIMARY_SELECTOR:'button.primary',candidates:()=>nodes,shown:()=>true,contains:()=>true,candidateMatches:()=>true});
  e.nolBinding={anchor:{isConnected:true,querySelectorAll:()=>[]},waiting:false};e.boundTarget={isConnected:false};return e;
}
test('an immediately rebound NOL button saves replacement and rebound diagnostics once',()=>{
  const button={isConnected:true,textContent:'예매하기'},e=nolEngine([button]);
  assert.equal(e.nolTarget(),button);assert.equal(e.boundTarget,button);assert.equal(e.snapshots.length,1);
  assert.deepEqual(e.snapshots[0].logs.map(l=>l.event),['button-replaced','button-rebound']);
  assert.equal(e.nolTarget(),button);assert.equal(e.snapshots.length,1);
});
test('a missing NOL replacement checkpoints its wait once and retains it when a later button arrives',()=>{
  const nodes=[],e=nolEngine(nodes);assert.equal(e.nolTarget(),null);assert.equal(e.snapshots.length,1);
  assert.deepEqual(e.snapshots[0].logs.map(l=>l.event),['button-replaced','button-search-wait']);
  assert.equal(e.nolTarget(),null);assert.equal(e.snapshots.length,1);
  nodes.push({isConnected:true,textContent:'예매하기'});assert.equal(e.nolTarget(),nodes[0]);assert.equal(e.snapshots.length,2);
  assert.deepEqual(e.snapshots[1].logs.map(l=>l.event),['button-replaced','button-search-wait','button-rebound']);
});
test('ambiguous NOL replacement retains its diagnostics at terminal save without binding a candidate',()=>{
  const e=nolEngine([{textContent:'one'},{textContent:'two'}]),old=e.boundTarget;
  e.finalDiagnostic=()=>({button:{found:false},pointer:{state:'ready'},timing:{}});e.cleanup=()=>{};e.notifyEnd=()=>{};
  e.safe(()=>e.nolTarget());assert.equal(e.active,false);assert.equal(e.boundTarget,old);assert.equal(e.run.status,'error');
  assert.match(e.run.message,/후보가 2개/);assert.equal(e.snapshots.length,1);
  assert(e.snapshots[0].logs.some(l=>l.event==='button-replaced'));assert(e.snapshots[0].logs.some(l=>l.event==='run-end'));
});
test('pointer invalidation records reason and coordinates, persists it and keeps the explanation visible',()=>{
  const e=engine();e.invalidatePointer('scroll');e.pointerHint('예매 버튼에 마우스를 이동해 주세요');
  assert.equal(e.lastPointer,null);assert.equal(e.run.logs[0].event,'pointer-invalidated');assert.equal(e.run.logs[0].pointerReason,'scroll');
  assert.equal(e.run.logs[0].pointerX,10);assert.equal(e.run.logs[0].pointerY,20);assert(e.snapshots.length);assert.match(e.run.message,/화면 스크롤/);
  const count=e.run.logs.length;e.invalidatePointer('scroll');assert.equal(e.run.logs.length,count,'empty duplicate events flooded logs');
});
test('iframe anchor failures keep their exact error in durable diagnostic records',async()=>{
  const e=engine(async()=>({success:false,error:'부모 iframe이 가려져 있습니다.'}));e.pointerAnchor=null;e.ensurePointerAnchor({pointerRevision:3});
  await new Promise(setImmediate);assert.equal(e.lastPointer,null);assert(e.run.logs.some(log=>log.event==='pointer-position-error'&&/가려져/.test(log.message)));
  const log=e.run.logs.find(log=>log.pointerReason==='anchor-failed');assert.match(log.pointerDetail,/가려져/);assert.match(e.run.message,/가려져/);
});
test('a rejected anchor RPC records the previously lost response error without dispatching input',async()=>{
  const actions=[],e=engine(async request=>{actions.push(request.action);throw Error('Extension context invalidated');});e.pointerAnchor=null;
  e.ensurePointerAnchor({pointerRevision:3});await new Promise(setImmediate);
  assert.deepEqual(actions,['cdpPointerAnchor']);assert(e.run.logs.some(log=>log.pointerReason==='anchor-rpc-failed'&&/context invalidated/.test(log.pointerDetail)));
});
test('activation is recorded with no pointer and repeated countdown text does not flood logs',async()=>{
  const e=engine();e.settings.clickMethod='cdp';e.lastPointer=null;e.pointerAnchor=null;
  const button={isConnected:true,textContent:'남은시간 30:20',disabled:true,className:'primary disabled',id:'book',classList:{contains:()=>true},getAttribute:()=>null};
  e.observeReadiness(button,false,'initial');
  for(let i=0;i<100;i++){button.textContent='남은시간 30:'+i;e.observeReadiness(button,false,'mutation');}
  assert.equal(e.run.logs.filter(log=>log.event==='button-state').length,1);
  button.disabled=false;button.className='primary';button.textContent='예매하기';e.observeReadiness(button,true,'mutation');
  const detected=e.run.logs.find(log=>log.event==='button-detected');assert(detected);assert.equal(detected.pointerReady,false);assert.equal(detected.buttonReady,true);
  e.pointerHint('예매 버튼에 마우스를 이동해 주세요');assert.match(e.run.message,/버튼 활성화 확인/);
  assert.equal(e.run.lastObservation.button.text,'예매하기');assert.equal(e.run.lastObservation.pointer.state,'missing');
  await new Promise(setImmediate);assert(e.snapshots.length);
});
test('pointer readiness changes are distinct and ordinary moves do not produce pending/ready log pairs',()=>{
  const e=engine();e.lastPointer={x:10,y:20,revision:3,viewportKey:'viewport'};e.recordPointerState();
  assert.equal(e.run.logs.at(-1).pointerReady,true);
  for(let i=0;i<50;i++) {
    e.lastPointer={x:10+i,y:20,revision:4+i,viewportKey:'viewport'};e.pointerAnchor=null;e.recordPointerState();
    e.pointerAnchor={revision:4+i};e.recordPointerState();
  }
  assert.equal(e.run.logs.filter(log=>log.event==='pointer-state').length,1);
  e.invalidatePointer('scroll');assert.equal(e.run.logs.at(-1).pointerState,'invalidated');assert.equal(e.lastKnownPointer.x,59);
});
test('a failed final DOM read cannot prevent cleanup or saving clearly marked historical diagnostics',async()=>{
  const e=engine(),observedAt=Date.now()-500;e.run.monitorStartedAt=Date.now()-1000;
  e.run.lastObservation={capturedAt:observedAt,button:{found:true,ready:false,text:'예매 대기'},pointer:{state:'missing',ready:false}};
  e.finalDiagnostic=()=>{throw Error('DOM read failed');};e.cleanup=()=>{e.cleaned=true;};e.notifyEnd=()=>{};
  e.finish('error','진단 실패 재현');await new Promise(setImmediate);
  assert(e.cleaned);assert.equal(e.active,false);assert.equal(e.run.finalDiagnostics.source,'document-fallback');
  assert.equal(e.run.finalDiagnostics.observationCapturedAt,observedAt);assert.equal(e.run.finalDiagnostics.capturedAt,e.run.endedAt);
  assert.equal(e.run.finalDiagnostics.liveDomAvailable,false);assert(e.run.finalDiagnostics.timing.monitorElapsedMs>=1000);
  assert(e.snapshots.at(-1).finalDiagnostics);assert(e.run.logs.some(log=>log.event==='run-diagnostics'));
});
test('CSV download includes pointer diagnostics and safely quotes detailed errors',async()=>{
  const popup=fs.readFileSync(require.resolve('../popup.js'),'utf8'),start=popup.indexOf('async function downloadLog()');
  const end=popup.indexOf("$('analyzePage').addEventListener",start),state={};
  const context=vm.createContext({Date,Blob,setTimeout:fn=>fn(),
    chrome:{storage:{local:{get:async()=>({macroLogs:[{message:'위치 오류',pointerReason:'anchor-failed',pointerDetail:'iframe, "오류"\n상세',pointerX:10,pointerY:20,
      activationToPointerdownMs:12.3,pointerWaitMs:8,inputTimingSource:'trusted-pointerdown',
      diagnosticJson:JSON.stringify({button:{text:'예매, "시작"\n확인'},pointer:{ready:false}})}]})}}},
    URL:{createObjectURL:blob=>{state.blob=blob;return 'blob:local-test';},revokeObjectURL:()=>{}},
    document:{createElement:()=>{state.link={click:()=>{state.clicked=true;}};return state.link;}}
  });
  vm.runInContext(popup.slice(start,end),context);await context.downloadLog();const csv=await state.blob.text();
  assert(state.clicked);assert.match(state.link.download,/ticket-click-log-/);assert(csv.split('\r\n')[0].includes('pointerReason,pointerDetail,pointerRevision,pointerX,pointerY,phase'));
  assert(csv.includes('"anchor-failed"'));assert(csv.includes('"iframe, ""오류""\n상세"'));
  assert(csv.split('\r\n')[0].includes('diagnosticSource,observationCapturedAt,diagnosticJson'));
  assert(csv.includes('""pointer"":{'));assert(csv.includes('""ready"":false'));
  const header=csv.split('\r\n')[0];assert(header.includes('activationToPointerdownMs'));assert(header.includes('pointerWaitMs'));assert(header.includes('inputTimingSource'));
  assert(csv.includes('"12.3"'));assert(csv.includes('"trusted-pointerdown"'));
});

test('ordinary state omits duplicated history while public checkpoint and final history remain complete',async()=>{
  const data={macroRun:{id:'run',status:'watching'}},writes=[];
  const e=engine(undefined,{get:async()=>data,set:async p=>{writes.push(p);Object.assign(data,p);}});
  e.persist=Object.getPrototypeOf(e).persist.bind(e);e.log('button-replaced','diagnostic');
  await e.status('watching','ready');assert.equal(data.macroRun.logs,undefined);assert.equal(data.macroLogs.length,1);
  assert.equal(data.macroRun.message,'ready');e.active=false;e.phase='completed';await e.status('completed','done');
  assert.equal(data.macroRun.logs.length,1);assert.equal(data.macroLogs.length,1);assert.equal(writes.length,2);
});

test('activation checks read each computed style once and do not cache across evaluations',()=>{
  const counts=new Map(),ancestor={nodeType:1,getAttribute:()=>null,hasAttribute:()=>false},button={nodeType:1,isConnected:true,matches:()=>false,getAttribute:()=>null,hasAttribute:()=>false,getBoundingClientRect:()=>({width:20,height:20}),parent:ancestor};
  let pointerEvents='auto';const ctx={parentOf:n=>n.parent,getComputedStyle:n=>{counts.set(n,(counts.get(n)||0)+1);return {display:'block',visibility:'visible',opacity:'1',pointerEvents};}};
  vm.runInNewContext(source.slice(source.indexOf('  function shown('),source.indexOf('  function clickable(')),ctx);
  assert(ctx.activationReady(button,{}));assert.equal(counts.get(button),1);assert.equal(counts.get(ancestor),1);
  pointerEvents='none';assert.equal(ctx.activationReady(button,{}),false);assert.equal(counts.get(button),2);
  assert(ctx.shown(button),'a visible non-interactive safety marker must still be visible');
});

function portFixture(state={}){const sent=[],messages=[],disconnects=[];let connects=0;const port={onMessage:{addListener:f=>messages.push(f)},onDisconnect:{addListener:f=>disconnects.push(f)},postMessage:m=>sent.push(m),disconnect:()=>{}};
  const actions=[],e=engine(async r=>{actions.push(r);return {success:true,parentSignature:'valid'};});
  e.finish=(status,message)=>{e.active=false;e.ended={status,message};};
  const opening=source.slice(source.indexOf('    openCdpChannel()'),source.indexOf('    notifyEnd()'));
  const ctx={chrome:{runtime:{connect:()=>{connects++;return port;}},storage:{local:{get:async()=>state}}},setTimeout,clearTimeout,Promise,Error};
  vm.runInNewContext('class Channel {'+opening+'};globalThis.Channel=Channel;',ctx);
  e.openCdpChannel=ctx.Channel.prototype.openCdpChannel;e.closeCdpChannel=ctx.Channel.prototype.closeCdpChannel;e.endCdpChannel=ctx.Channel.prototype.endCdpChannel;
  return {e,sent,actions,connects:()=>connects,receive:m=>messages.forEach(f=>f(m)),disconnect:()=>disconnects.forEach(f=>f())};
}
test('the document Port handles only authenticated read-only validation requests',async()=>{
  const f=portFixture();f.e.validatePointer=()=>({success:true,point:{x:10,y:20}});f.e.openCdpChannel();
  assert.equal(f.sent[0].kind,'bind');f.receive({kind:'ready',runId:'run'});await f.e.channelReady;
  f.receive({kind:'request',runId:'other',id:1,request:{action:'validateCdpPointer',runId:'other'}});assert.equal(f.sent.length,1);
  f.receive({kind:'request',runId:'run',id:2,request:{action:'validateCdpPointer',runId:'run'}});assert(f.sent.at(-1).result.success);
  f.receive({kind:'request',runId:'run',id:3,request:{action:'cdpClick',runId:'run'}});assert.equal(f.sent.at(-1).result.success,false);
  assert.equal(f.actions.length,0);f.e.active=false;f.e.closeCdpChannel();
});
for(const ready of [false,true])test('document Port loss '+(ready?'after':'before')+' binding stops without reconnecting',async()=>{
  const f=portFixture();f.e.openCdpChannel();if(ready){f.receive({kind:'ready',runId:'run'});await f.e.channelReady;}
  f.disconnect();await new Promise(setImmediate);assert.equal(f.e.active,false);assert.equal(f.e.ended.status,'interrupted');
  assert.equal(f.connects(),1);assert.equal(f.actions.length,0);
});
test('a controller-driven Port close preserves the durable manual stop',async()=>{
  const f=portFixture({macroRun:{id:'run',status:'stopping',stopRequested:true}});f.e.openCdpChannel();
  f.receive({kind:'ready',runId:'run'});await f.e.channelReady;f.disconnect();
  assert.equal(f.e.phase,'disconnected','input authorization must stop before the storage read');
  await new Promise(setImmediate);assert.equal(f.e.ended.status,'stopped');assert.equal(f.actions.length,0);assert.equal(f.connects(),1);
});
test('click commands use the bound Port and correlate only their own responses',async()=>{
  const f=portFixture();f.e.openCdpChannel();f.receive({kind:'ready',runId:'run'});await f.e.channelReady;f.e.phase='dispatching';
  const flight=f.e.sendCdpClick({action:'cdpClick',runId:'run'});await new Promise(setImmediate);
  const message=f.sent.at(-1);assert.equal(message.kind,'command');assert.equal(f.actions.length,0);
  await assert.rejects(f.e.sendCdpClick({action:'cdpClick',runId:'run'}),/중복/);
  f.receive({kind:'command-result',runId:'other',id:message.id,result:{success:true}});assert.equal(f.e.commandPending.size,1);
  f.receive({kind:'command-result',runId:'run',id:message.id,result:{success:true}});assert((await flight).success);
  f.e.active=false;f.e.closeCdpChannel();
});
test('a click awaiting a disconnected Port is rejected without sending a legacy request',async()=>{
  const f=portFixture();f.e.openCdpChannel();f.receive({kind:'ready',runId:'run'});await f.e.channelReady;f.e.phase='dispatching';
  const flight=f.e.sendCdpClick({action:'cdpClick',runId:'run'}),outcome=assert.rejects(flight,/연결/);
  await new Promise(setImmediate);f.disconnect();await outcome;await new Promise(setImmediate);
  assert.equal(f.actions.length,0);assert.equal(f.e.commandPending.size,0);assert.equal(f.e.ended.status,'interrupted');
});
for(const large of [false,true])test('a queued NOL checkpoint '+(large?'keeps its original write when history is too large':'moves intact into the input claim'),async()=>{
  const data={macroRun:{id:'run',status:'watching'}},writes=[],requests=[];
  const e=engine(async request=>{requests.push(request);return {success:true,timings:{}};},{get:async()=>data,set:async p=>{writes.push(p);Object.assign(data,p);}});
  e.persist=Object.getPrototypeOf(e).persist.bind(e);e.step.nolPrimary=true;e.run.status='watching';
  e.pointerPoint=()=>({x:10,y:20,pointerRevision:3});e.afterDispatch=()=>{};e.logClickTiming=()=>{};
  e.log('button-rebound',large?'history '.repeat(15000):'new target');e.persist();e.phase='dispatching';
  const attempt=e.log('click-attempt','input');await e.dispatchCdp(attempt);
  assert.equal(writes.length,large?1:0);assert.equal(requests.length,1);
  assert.equal(!!requests[0].intent.checkpointLogs,!large);if(!large)assert.equal(requests[0].intent.checkpointLogs[0].event,'button-rebound');
});
test('console diagnostics wait until input has left the dispatching phase',async()=>{
  const e=engine();e.phase='dispatching';e.log('click-attempt','keep it buffered');await new Promise(setImmediate);
  assert.equal(e.consoleEntries.length,1);e.phase='verifying';e.flushConsole();assert.equal(e.consoleEntries.length,0);assert.equal(e.run.logs.length,1);
});
test('prepared verification rejects a changed ancestor path before reusing observers',()=>{
  const e=engine(),root={},outer={},parent={parentElement:outer},node={parentElement:parent,getRootNode:()=>root};
  e.step.verify={kind:'appeared'};e.verificationPrepared=true;e.verificationNode=node;e.currentVerificationNode=node;
  e.verificationRoot=root;e.verificationScope={isConnected:true};e.verificationAncestors=[parent,outer];assert(e.verificationPlanValid());
  parent.parentElement={};assert.equal(e.verificationPlanValid(),false);e.currentVerificationNode={};assert.equal(e.verificationPlanValid(),false);
});
test('prepared completion checks cannot finish a watching or dispatching step',()=>{
  const e=engine(undefined,undefined,{location:{href:'initial'}});e.initialUrl='initial';let reads=0;e.verificationState=()=>{reads++;return {};};e.verificationMatches=()=>false;e.stopForBlocker=()=>false;
  e.phase='watching';e.checkVerification('prepared');e.phase='dispatching';e.checkVerification('prepared');assert.equal(reads,0);
  e.phase='verifying';e.checkVerification('prepared');assert.equal(reads,1);
});
