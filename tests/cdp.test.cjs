const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Controller}=require('../cdp.js');
function fixture(behavior={}) {
  const run={id:'run',tabId:7,frameId:0,documentId:'doc',topDocumentId:'doc',topUrl:'http://example.test/',status:'watching'};
  const point={x:100,y:80,signature:'fixed',viewport:{width:800,height:600,scrollX:0,scrollY:0}};
  Object.assign(point,{documentToken:'token',viewportKey:'viewport',pointerRevision:1});
  point.pointerAnchor=JSON.stringify(['token',point.viewport,'viewport',100,80]);
  const data={macroRun:run},calls=[],interrupts=[];
  let detached, event, moved=false;
  const api={
    runtime:{id:'extension'},
    storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]])),set:async patch=>Object.assign(data,patch)}},
    permissions:{contains:async()=>!behavior.noPermission},
    tabs:{get:async()=>({url:behavior.navigated?'http://example.test/other':run.topUrl}),
      query:async()=>[{id:behavior.inactive?8:7}],getZoom:async()=>1.25,
      sendMessage:async()=>({success:!behavior.invalidTarget,error:'target hidden/disabled',
        point:{...point,signature:behavior.moveBefore||moved?'changed':point.signature}})},
    webNavigation:{getAllFrames:async()=>[{frameId:0,documentId:behavior.replaced?'new':'doc'}]},
    debugger:{
      onDetach:{addListener:fn=>detached=fn},
      onEvent:{addListener:fn=>event=fn},
      attach:async(...args)=>{calls.push({method:'attach',args});if(behavior.conflict)throw Error('Another debugger is already attached');},
      detach:async()=>{calls.push({method:'detach'});if(behavior.detachError)throw Error('detach failed');},
      getTargets:async()=>[],
      sendCommand:async(target,method,params)=>{
        calls.push({method,params,target});
        if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{clientWidth:behavior.badViewport?900:800,clientHeight:600,pageX:0,pageY:0},cssVisualViewport:{scale:1}};
        if(params.type==='mousePressed'){
          if(behavior.moveAfter)moved=true;
          if(behavior.stopAfter)data.macroRun={...run,stopRequested:true};
          if(behavior.pressFail)throw Error('protocol failure');
        }
        if(params.type==='mouseReleased'&&params.clickCount===1&&behavior.releaseFail)throw Error('protocol failure');
      }
    }
  };
  const manager=new Controller(api,async(run,message)=>{interrupts.push(message);data.macroRun={...run,status:'interrupted'};});
  const request={runId:run.id,attemptId:'one',point},sender={id:'extension',tab:{id:7},frameId:0,documentId:'doc'};
  return {manager,api,run,data,calls,interrupts,request,sender,detach:()=>detached({tabId:7},'canceled_by_user'),event:(source,method,params)=>event(source,method,params)};
}

async function iframeFixture() {
  const f=fixture(),childUrl='http://frame.test/';
  Object.assign(f.run,{frameId:1,documentId:'child-doc'});
  Object.assign(f.sender,{frameId:1,documentId:'child-doc'});
  Object.assign(f.request.point,{space:'frame',documentUrl:childUrl});
  f.api.webNavigation.getAllFrames=async()=>[{frameId:0,documentId:'doc'},{frameId:1,documentId:'child-doc'}];
  f.api.tabs.sendMessage=async()=>({success:true,point:{...f.request.point}});
  let objects=0;
  const original=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,params)=>{
    if(!['Page.getFrameTree','Runtime.evaluate','DOM.getFrameOwner','Page.createIsolatedWorld','DOM.resolveNode','Runtime.callFunctionOn','Runtime.releaseObject'].includes(method))return original(target,method,params);
    f.calls.push({method,params,target});
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'root',url:f.run.topUrl,loaderId:'root-loader'},childFrames:[{frame:{id:'child',parentId:'root',url:childUrl,loaderId:'child-loader'}}]}};
    if(method==='Runtime.evaluate')return {result:{value:'token'}};
    if(method==='DOM.getFrameOwner')return {backendNodeId:42};
    if(method==='Page.createIsolatedWorld')return {executionContextId:10};
    if(method==='DOM.resolveNode')return {object:{objectId:'owner-'+(++objects)}};
    if(method==='Runtime.callFunctionOn')return {result:{value:{x:100,y:80,viewport:{width:800,height:600,scrollX:0,scrollY:0},geometry:[0,0,800,600]}}};
    return {};
  };
  await f.manager.start(f.run);
  f.manager.session.contexts.set('context',{id:1,uniqueId:'unique-child',auxData:{frameId:'child'}});
  const anchored=await f.manager.anchor(f.request,f.sender);
  f.request.point.pointerAnchor=anchored.parentSignature;
  return f;
}
test('CDP attaches once for multiple explicit step intents and detaches once at session end',async()=>{
  const f=fixture();await f.manager.start(f.run);
  for(const attemptId of ['one','two']){
    const result=await f.manager.click({...f.request,attemptId},f.sender);assert.equal(result.success,true);
    for(const key of ['claimPersistMs','cdpPreflightMs','pressCommandMs','afterPressCheckMs','releaseCommandMs'])assert(Number.isFinite(result.timings[key])&&result.timings[key]>=0);
  }
  await f.manager.end(f.run.id);
  assert.equal(f.calls.filter(c=>c.method==='attach').length,1);assert.equal(f.calls.filter(c=>c.method==='detach').length,1);
  assert.deepEqual(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.params.type),['mousePressed','mouseReleased','mousePressed','mouseReleased']);
  assert.equal(f.data.ticketCdpSession,null);
});
test('missing debugger permission and attach conflict send no input and clear ownership',async()=>{
  for(const b of [{noPermission:true},{conflict:true}]){
    const f=fixture(b);await assert.rejects(f.manager.start(f.run),/권한|연결 실패/);
    assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);assert(!f.data.ticketCdpSession);
  }
});
test('sender, document, run and point validation forbid unrelated requests',async()=>{
  const f=fixture();await f.manager.start(f.run);
  for(const sender of [{...f.sender,id:'foreign'},{...f.sender,frameId:1},{...f.sender,documentId:'new'},{...f.sender,tab:{id:8}}])await assert.rejects(f.manager.click(f.request,sender),/일치하지/);
  await assert.rejects(f.manager.click({...f.request,point:{...f.request.point,x:NaN}},f.sender),/좌표/);
  assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);await f.manager.end(f.run.id);
});
test('a duplicate input ticket cannot be sent concurrently or replayed after completion',async()=>{
  const f=fixture();await f.manager.start(f.run);
  const first=f.manager.click(f.request,f.sender);await assert.rejects(f.manager.click(f.request,f.sender),/중복/);
  await first;await assert.rejects(f.manager.click(f.request,f.sender),/중복/);await f.manager.end(f.run.id);
});

for(const cancel of [false,true])test('parallel preflight waits for every read and '+(cancel?'honors cancellation before input':'keeps all existing checks'),async()=>{
  const f=fixture();await f.manager.start(f.run);
  const entered=[],release={},seen=new Set();
  const first=(name,value)=>{if(seen.has(name))return Promise.resolve(value);seen.add(name);entered.push(name);return new Promise(resolve=>{release[name]=()=>resolve(value);});};
  const originalGet=f.api.storage.local.get;
  f.api.storage.local.get=keys=>keys==='macroRun'?first('run',{macroRun:f.run}):originalGet(keys);
  f.api.tabs.get=()=>first('tab',{url:f.run.topUrl,windowId:1});
  f.api.tabs.query=()=>first('active',[{id:f.run.tabId}]);
  f.api.webNavigation.getAllFrames=()=>first('frames',[{frameId:0,documentId:'doc'}]);
  f.api.windows={get:()=>first('window',{focused:true})};
  const flight=f.manager.click(f.request,f.sender);
  const outcome=cancel?assert.rejects(flight,/중지|세션/):flight;
  await new Promise(setImmediate);
  assert.deepEqual([...entered].sort(),['active','frames','run','tab']);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  release.tab();await new Promise(setImmediate);assert(entered.includes('window'));
  if(cancel)f.manager.cancel(f.run.id);
  for(const name of ['run','active','frames','window'])release[name]();
  const result=await outcome;if(!cancel)assert.equal(result.success,true);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,cancel?0:1);
  await f.manager.end(f.run.id);
});
for(const [name,behavior] of Object.entries({
  'coordinate change before press':{moveBefore:true},'invalid pointer response':{invalidTarget:true},
  'layout viewport mismatch':{badViewport:true},'tab navigation':{navigated:true},'document replacement':{replaced:true},'inactive tab':{inactive:true}
}))test(name+' aborts with zero mouse presses',async()=>{
  const f=fixture(behavior);await f.manager.start(f.run);await assert.rejects(f.manager.click(f.request,f.sender),/CDP 입력 실패/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);await f.manager.end(f.run.id);
});

for(const cancel of [false,true])test('layout and frame mapping run in parallel and '+(cancel?'cancel without input':'wait for both results'),async()=>{
  const f=fixture();await f.manager.start(f.run);f.request.point.space='frame';
  const entered=[],release={};let mapped=false,metrics=false;const original=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=(target,method,params)=>method==='Page.getLayoutMetrics'&&!metrics?(metrics=true,
    entered.push('metrics'),new Promise(resolve=>{release.metrics=()=>resolve({cssLayoutViewport:{clientWidth:800,clientHeight:600,pageX:0,pageY:0}});})):original(target,method,params);
  f.manager.framePoint=async(session,point)=>{if(!mapped){mapped=true;entered.push('mapping');await new Promise(resolve=>{release.mapping=resolve;});}return {...point,parentSignature:point.pointerAnchor};};
  const flight=f.manager.click(f.request,f.sender),outcome=cancel?assert.rejects(flight,/중지/):flight;
  await new Promise(setImmediate);assert.deepEqual(entered,['metrics','mapping']);
  release.metrics();await new Promise(setImmediate);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  if(cancel)f.manager.cancel(f.run.id);release.mapping();await outcome;
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,cancel?0:1);await f.manager.end(f.run.id);
});

for(const changed of [false,true])test('frame and token inventories are batched and '+(changed?'reject a changed context':'retain unique token validation'),async()=>{
  const f=fixture();await f.manager.start(f.run);const session=f.manager.session;
  session.framesEnabled=true;session.children.set('child',{id:'child',ready:Promise.resolve()});
  for(const id of [1,2])session.contexts.set('context-'+id,{id,auxData:{frameId:'root'}});
  const release={},entered=[];
  f.manager.command=(s,method,params,id)=>{
    const key=method==='Page.getFrameTree'?'tree-'+(id||'root'):'token-'+params.contextId;entered.push(key);
    return new Promise(resolve=>{release[key]=()=>resolve(method==='Page.getFrameTree'?{frameTree:{frame:{id:id||'root',parentId:id?'root':undefined,url:id?'http://child.test/':f.run.topUrl,loaderId:'loader'}}}:{result:{value:params.contextId===1?'token':'other'}});});
  };
  const flight=f.manager.framePoint(session,{...f.request.point,documentUrl:f.run.topUrl},null,changed?async()=>{}:false);
  const outcome=changed?assert.rejects(flight,/문서 정보가 변경/):flight;
  await new Promise(setImmediate);assert.deepEqual([...entered].sort(),['token-1','token-2','tree-child','tree-root']);
  if(changed)f.event({tabId:7},'Runtime.executionContextDestroyed',{executionContextId:1});
  for(const finish of Object.values(release))finish();await outcome;
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  // Restore the real command method for normal end cleanup.
  delete f.manager.command;await f.manager.end(f.run.id);
});

test('read-only initial anchoring refreshes a changing context inventory with no input claim',async()=>{
  const f=fixture();await f.manager.start(f.run);const session=f.manager.session;session.framesEnabled=true;
  session.contexts.set('context',{id:1,auxData:{frameId:'root'}});let trees=0,tokens=0;
  f.manager.command=async(s,method)=>{
    if(method==='Page.getFrameTree'){
      if(++trees===1)session.frameRevision++;
      return {frameTree:{frame:{id:'root',url:f.run.topUrl,loaderId:'loader'}}};
    }
    if(method==='Runtime.evaluate'){tokens++;return {result:{value:'token'}};}
    throw Error('Unexpected command '+method);
  };
  const marker=f.data.ticketCdpSession;await f.manager.framePoint(session,{...f.request.point,documentUrl:f.run.topUrl},null,false);
  assert.equal(trees,2);assert.equal(tokens,2);assert.equal(f.data.ticketCdpSession,marker);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);delete f.manager.command;await f.manager.end(f.run.id);
});

for(const cancel of [false,true])test('one durable claim completes before input and '+(cancel?'honors stop during storage':'is not rewritten after geometry'),async()=>{
  const f=fixture();await f.manager.start(f.run);let finish,writes=0;
  f.manager.commitInput=(session,request,marker)=>{writes++;return new Promise(resolve=>{finish=()=>{f.data.ticketCdpSession=marker;resolve();};});};
  const flight=f.manager.click(f.request,f.sender),outcome=cancel?assert.rejects(flight,/중지/):flight;
  await new Promise(setImmediate);assert.equal(writes,1);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  if(cancel)f.manager.cancel(f.run.id);finish();await outcome;
  assert.equal(writes,1);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,cancel?0:1);await f.manager.end(f.run.id);
});

test('a failed parallel read drains the in-flight claim before ownership cleanup',async()=>{
  const f=fixture();await f.manager.start(f.run);let finish,rejectMetrics,settled=false;
  f.manager.commitInput=(session,request,marker)=>new Promise(resolve=>{finish=()=>{f.data.ticketCdpSession=marker;resolve();};});
  const original=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=(target,method,params)=>method==='Page.getLayoutMetrics'?new Promise((resolve,reject)=>{rejectMetrics=reject;}):original(target,method,params);
  const flight=f.manager.click(f.request,f.sender),outcome=assert.rejects(flight,/layout failed/).then(()=>{settled=true;});
  await new Promise(setImmediate);rejectMetrics(Error('layout failed'));await new Promise(setImmediate);assert.equal(settled,false);
  finish();await outcome;await f.manager.end(f.run.id);
  assert.equal(f.data.ticketCdpSession,null);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
});

test('a failed unified input write sends no mouse press or JavaScript fallback',async()=>{
  const f=fixture();await f.manager.start(f.run);
  f.manager.commitInput=async()=>{throw Error('unified input storage failed');};
  await assert.rejects(f.manager.click(f.request,f.sender),/unified input storage failed/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  await f.manager.end(f.run.id);assert.equal(f.data.ticketCdpSession,null);
});

for(const first of ['storage','geometry'])test('durable claim overlaps real iframe geometry but joins both before final validation: '+first+' first',async()=>{
  const f=await iframeFixture(),events=[];let finishClaim,finishGeometry;
  f.manager.commitInput=(session,request,marker)=>{events.push('claim');return new Promise(resolve=>{finishClaim=()=>{events.push('stored');f.data.ticketCdpSession=marker;resolve();};});};
  const command=f.api.debugger.sendCommand;let blocked=false;
  f.api.debugger.sendCommand=async(target,method,params)=>{
    if(method==='Runtime.callFunctionOn'&&!blocked){blocked=true;events.push('geometry');await new Promise(resolve=>{finishGeometry=()=>{events.push('geometry-done');resolve();};});}
    return command(target,method,params);
  };
  f.api.tabs.sendMessage=async(tab,request)=>{events.push('rpc');return request.afterPress?{success:true,completedOnPress:true}:{success:true,point:{...f.request.point}};};
  const flight=f.manager.click(f.request,f.sender);await new Promise(setImmediate);
  assert.deepEqual(events,['claim','geometry']);
  (first==='storage'?finishClaim:finishGeometry)();await new Promise(setImmediate);
  assert(!events.includes('rpc'));assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  (first==='storage'?finishGeometry:finishClaim)();const result=await flight;
  assert.equal(result.success,true);assert(events.indexOf('rpc')>events.indexOf('stored'));
  assert(events.indexOf('rpc')>events.indexOf('geometry-done'));
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);await f.manager.end(f.run.id);
});

for(const failure of ['stop','storage','geometry'])test('overlapped iframe preparation drains storage and sends no press on '+failure,async()=>{
  const f=await iframeFixture();let finishClaim,finishGeometry,settled=false;
  f.manager.commitInput=(session,request,marker)=>new Promise((resolve,reject)=>{finishClaim=()=>{
    if(failure==='storage')reject(Error('overlapped write failed'));else{f.data.ticketCdpSession=marker;resolve();}
  };});
  const command=f.api.debugger.sendCommand;let blocked=false;
  f.api.debugger.sendCommand=async(target,method,params)=>{
    if(method==='Runtime.callFunctionOn'&&!blocked){blocked=true;await new Promise((resolve,reject)=>{finishGeometry=()=>failure==='geometry'?reject(Error('overlapped geometry failed')):resolve();});}
    return command(target,method,params);
  };
  const flight=f.manager.click(f.request,f.sender);
  const outcome=assert.rejects(flight,failure==='stop'?/중지/:failure==='storage'?/overlapped write/:/overlapped geometry/).then(()=>{settled=true;});
  await new Promise(setImmediate);assert.equal(typeof finishClaim,'function');assert.equal(typeof finishGeometry,'function');
  if(failure==='stop')f.manager.cancel(f.run.id);
  if(failure==='storage'){finishClaim();await new Promise(setImmediate);assert.equal(settled,false);finishGeometry();}
  else{finishGeometry();await new Promise(setImmediate);assert.equal(settled,false);finishClaim();}
  await outcome;assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  await f.manager.end(f.run.id);assert.equal(f.data.ticketCdpSession,null);
});

test('iframe owner remains scoped to the run and end waits for its release after both input edges',async()=>{
  const f=await iframeFixture();
  assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObject').length,0);
  assert.equal(f.manager.session.ownerCache.size,1);
  f.calls.length=0;let finishCleanup,ended=false;
  const gate=new Promise(resolve=>{finishCleanup=resolve;}),command=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,params)=>{
    const value=await command(target,method,params);
    if(method==='Runtime.releaseObject')await gate;
    return value;
  };
  const result=await f.manager.click(f.request,f.sender);
  assert.equal(result.success,true);assert.equal(result.timings.frameCacheHit,true);assert.equal(result.timings.ownerCacheHits,1);
  const edges=f.calls.filter(c=>c.method==='Input.dispatchMouseEvent');
  assert.deepEqual(edges.map(c=>c.params.type),['mousePressed','mouseReleased']);
  assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObject').length,0);
  const ending=f.manager.end(f.run.id).then(()=>{ended=true;});await new Promise(setImmediate);
  assert.equal(ended,false);assert(!f.calls.some(c=>c.method==='detach'));
  const cleanup=f.calls.filter(c=>c.method==='Runtime.releaseObject');assert.equal(cleanup.length,1);
  assert(f.calls.indexOf(cleanup[0])>f.calls.indexOf(edges[1]));
  finishCleanup();await ending;
  assert.equal(f.data.ticketCdpSession,null);
});

for(const failure of ['validation','geometry','press','release'])test('deferred iframe objects are released after '+failure+' failure without a second press',async()=>{
  const f=await iframeFixture();f.calls.length=0;
  const command=f.api.debugger.sendCommand;
  f.api.debugger.sendCommand=async(target,method,params)=>{
    const value=await command(target,method,params);
    if(failure==='geometry'&&method==='Runtime.callFunctionOn'||failure==='press'&&params.type==='mousePressed'||
       failure==='release'&&params.type==='mouseReleased'&&params.clickCount===1)throw Error('deferred '+failure+' failure');
    return value;
  };
  if(failure==='validation')f.api.tabs.sendMessage=async()=>({success:false,error:'deferred validation failure'});
  await assert.rejects(f.manager.click(f.request,f.sender),/deferred .* failure/);
  const released=f.calls.filter(c=>c.method==='Runtime.releaseObject');
  assert.equal(released.length,1);assert.equal(new Set(released.map(c=>c.params.objectId)).size,released.length);
  const input=f.calls.filter(c=>c.method==='Input.dispatchMouseEvent');
  assert.equal(input.filter(c=>c.params.type==='mousePressed').length,['press','release'].includes(failure)?1:0);
  if(input.length)assert(f.calls.indexOf(released[0])>f.calls.indexOf(input.at(-1)));
  await f.manager.end(f.run.id);assert.equal(f.data.ticketCdpSession,null);
});

test('failed object cleanup cannot replay or invalidate completed CDP input',async()=>{
  const f=await iframeFixture(),command=f.api.debugger.sendCommand;f.calls.length=0;
  f.api.debugger.sendCommand=async(target,method,params)=>{const result=await command(target,method,params);if(method==='Runtime.releaseObject')throw Error('object already gone');return result;};
  assert.equal((await f.manager.click(f.request,f.sender)).success,true);
  assert.deepEqual(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.params.type),['mousePressed','mouseReleased']);
  await f.manager.end(f.run.id);
});

for(const detach of [false,true])test('a late geometry result after parallel failure '+(detach?'uses detached-context cleanup':'releases its object immediately'),async()=>{
  const f=await iframeFixture(),command=f.api.debugger.sendCommand;f.calls.length=0;
  let failMetrics,finishGeometry;
  f.api.debugger.sendCommand=async(target,method,params)=>{
    if(method==='Page.getLayoutMetrics')return new Promise((resolve,reject)=>{failMetrics=reject;});
    if(method==='Runtime.callFunctionOn')await new Promise(resolve=>{finishGeometry=resolve;});
    return command(target,method,params);
  };
  const flight=f.manager.click(f.request,f.sender),outcome=assert.rejects(flight,/late metrics failure/);
  await new Promise(setImmediate);assert.equal(typeof finishGeometry,'function');
  if(detach)f.manager.session.detached=true;
  failMetrics(Error('late metrics failure'));await outcome;
  if(detach)await f.manager.end(f.run.id);
  finishGeometry();await new Promise(setImmediate);
  assert.equal(f.calls.filter(c=>c.method==='Runtime.releaseObject').length,detach?0:1);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  if(!detach)await f.manager.end(f.run.id);
});
for(const [name,behavior] of Object.entries({'coordinate change after press':{moveAfter:true},'stop after press':{stopAfter:true},'press failure':{pressFail:true},'release failure':{releaseFail:true}}))test(name+' releases outside viewport and never retries the press',async()=>{
  const f=fixture(behavior);await f.manager.start(f.run);await assert.rejects(f.manager.click(f.request,f.sender),/재시도/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);
  assert(f.calls.some(c=>c.params?.type==='mouseReleased'&&c.params.x===-1&&c.params.clickCount===0));await f.manager.end(f.run.id);
});
test('unexpected debugger detach interrupts and does not attach again',async()=>{
  const f=fixture();await f.manager.start(f.run);f.detach();await new Promise(r=>setImmediate(r));
  assert.match(f.interrupts[0],/연결 해제/);assert.equal(f.calls.filter(c=>c.method==='attach').length,1);
  await assert.rejects(f.manager.click(f.request,f.sender));
});
test('cold worker recovery detaches stored ownership and interrupts without any input replay',async()=>{
  const f=fixture();f.data.ticketCdpSession={runId:f.run.id,tabId:7,state:'input-claimed',attemptId:'one'};
  await f.manager.recover();assert.match(f.interrupts[0],/워커 재시작/);assert.equal(f.data.ticketCdpSession,null);
  assert.equal(f.calls.filter(c=>c.method==='attach'||c.params?.type==='mousePressed').length,0);
  assert(f.calls.some(c=>c.params?.type==='mouseReleased'&&c.params.clickCount===0&&c.params.x===-1));
});
test('failed detach retains a recovery marker and prevents a new CDP session',async()=>{
  const f=fixture({detachError:true});await f.manager.start(f.run);await assert.rejects(f.manager.end(f.run.id),/detach failed/);
  assert(f.data.ticketCdpSession);await assert.rejects(f.manager.start(f.run),/정리되지/);
});
test('lost document/command responses have a bounded wait',async()=>{
  const f=fixture();await assert.rejects(f.manager.wait(new Promise(()=>{}),'lost document',20),/응답 시간 초과/);
});
test('iframe sessions auto-attach recursively and only register this extension isolated world',async()=>{
  const f=fixture();f.run.frameId=1;await f.manager.start(f.run);
  f.event({tabId:7},'Target.attachedToTarget',{sessionId:'child',targetInfo:{type:'iframe'}});
  await f.manager.session.children.get('child').ready;
  assert(f.calls.some(c=>c.method==='Target.setAutoAttach'&&c.target.sessionId==='child'&&c.params.flatten));
  for(const origin of ['http://example.test/','chrome-extension://foreign','chrome-extension://extension']){
    f.event({tabId:7,sessionId:'child'},'Runtime.executionContextCreated',{context:{id:1,origin,auxData:{isDefault:false,frameId:'frame'}}});
  }
  assert.equal(f.manager.session.contexts.size,1);
  f.event({tabId:7},'Target.detachedFromTarget',{sessionId:'child'});
  assert.equal(f.manager.session.contexts.size,0);await f.manager.end(f.run.id);
});
test('an OOPIF routes both input edges and failed-press cleanup to the same child session',async()=>{
  const f=fixture({pressFail:true});await f.manager.start(f.run);
  f.manager.validate=async session=>{session.inputSessionId='oopif';return {input:{x:12,y:24,sessionId:'oopif'}};};
  await assert.rejects(f.manager.click(f.request,f.sender),/재시도/);
  const input=f.calls.filter(c=>c.method==='Input.dispatchMouseEvent');
  assert(input.every(c=>c.target.sessionId==='oopif'));assert.equal(input[0].params.x,12);
  assert.equal(input[1].params.x,-1);await f.manager.end(f.run.id);
});
test('cold worker cleanup uses persisted child session without attaching or replaying a press',async()=>{
  const f=fixture();f.data.ticketCdpSession={runId:f.run.id,tabId:7,state:'input-claimed',inputSessionId:'oopif'};
  await f.manager.recover();const input=f.calls.find(c=>c.method==='Input.dispatchMouseEvent');
  assert.equal(input.target.sessionId,'oopif');assert.equal(input.params.type,'mouseReleased');
  assert.equal(f.calls.filter(c=>c.method==='attach'||c.params?.type==='mousePressed').length,0);
});
test('a changed iframe mapping after press cancels at the old session and never replays',async()=>{
  const f=fixture();await f.manager.start(f.run);f.request.point={...f.request.point,space:'frame'};
  let checks=0;f.manager.framePoint=async session=>{session.inputSessionId='oopif';return {...f.request.point,input:{x:12,y:24,sessionId:'oopif'},parentSignature:f.request.point.pointerAnchor,signature:++checks===1?'owner-one':'owner-two'};};
  await assert.rejects(f.manager.click(f.request,f.sender),/iframe.*변경/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);
  assert(f.calls.some(c=>c.target?.sessionId==='oopif'&&c.params?.type==='mouseReleased'&&c.params.x===-1));
  await f.manager.end(f.run.id);
});
test('a verified page transition on press cancels release outside instead of clicking a replacement',async()=>{
  const f=fixture();const original=f.api.tabs.sendMessage;
  f.api.tabs.sendMessage=async(tab,request)=>request.afterPress?{success:true,completedOnPress:true}:original(tab,request);
  await f.manager.start(f.run);const result=await f.manager.click(f.request,f.sender);
  assert(result.completedOnPress);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);
  assert(f.calls.some(c=>c.params?.type==='mouseReleased'&&c.params.x===-1&&c.params.clickCount===0));
  await f.manager.end(f.run.id);
});
test('pointer anchoring is read-only and preserves debugger ownership without claiming an input',async()=>{
  const f=fixture();await f.manager.start(f.run);
  const result=await f.manager.anchor(f.request,f.sender);
  assert.equal(result.parentSignature,f.request.point.pointerAnchor);
  assert.equal(f.data.ticketCdpSession.state,'attached');assert.equal(f.manager.session.claims.size,0);
  assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);await f.manager.end(f.run.id);
});

for(const stop of [false,true])test('initial protocol reads overlap live validation but claim waits for it'+(stop?' and honors stop':''),async()=>{
  const f=fixture();await f.manager.start(f.run);const live=f.manager.live.bind(f.manager);let finishLive,checks=0,claims=0;
  f.manager.live=async session=>{if(checks++===0)await new Promise(resolve=>{finishLive=resolve;});return live(session);};
  const commit=f.manager.commitInput;f.manager.commitInput=(...args)=>{claims++;return commit(...args);};
  const flight=f.manager.click(f.request,f.sender),outcome=stop?assert.rejects(flight,/중지/):flight;
  await new Promise(setImmediate);assert(f.calls.some(c=>c.method==='Page.getLayoutMetrics'));assert.equal(claims,0);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  if(stop)f.manager.cancel(f.run.id);finishLive();await outcome;
  assert.equal(claims,stop?0:1);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,stop?0:1);
  await f.manager.end(f.run.id);
});

for(const order of ['live-first','page-first','stop'])test('post-press live and completion reads overlap and join before release: '+order,async()=>{
  const f=fixture();await f.manager.start(f.run);const live=f.manager.live.bind(f.manager);let checks=0,finishLive,finishPage;
  f.manager.live=async session=>{if(checks++===1)await new Promise(resolve=>{finishLive=resolve;});return live(session);};
  f.api.tabs.sendMessage=async(tab,request)=>request.afterPress?new Promise(resolve=>{finishPage=()=>resolve({success:true,completedOnPress:true});}):{success:true,point:{...f.request.point}};
  const flight=f.manager.click(f.request,f.sender),outcome=order==='stop'?assert.rejects(flight,/중지/):flight;
  await new Promise(setImmediate);assert.equal(typeof finishLive,'function');assert.equal(typeof finishPage,'function');
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);
  (order==='live-first'?finishLive:finishPage)();await new Promise(setImmediate);
  assert.equal(f.calls.filter(c=>c.params?.type==='mouseReleased').length,0);
  if(order==='stop')f.manager.cancel(f.run.id);
  (order==='live-first'?finishPage:finishLive)();await outcome;
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);
  assert(f.calls.some(c=>c.params?.type==='mouseReleased'&&c.params.x===-1));await f.manager.end(f.run.id);
});

test('a warm frame mapping rechecks its unique document token and fresh geometry without rescanning or resolving owners',async()=>{
  const f=await iframeFixture(),count=method=>f.calls.filter(c=>c.method===method).length;
  assert.equal(count('Page.getFrameTree'),1);assert.equal(count('DOM.resolveNode'),1);
  const result=await f.manager.click(f.request,f.sender);
  assert(result.timings.frameCacheHit);assert.equal(result.timings.ownerCacheHits,1);
  assert.equal(count('Page.getFrameTree'),1);assert.equal(count('DOM.getFrameOwner'),1);assert.equal(count('DOM.resolveNode'),1);
  assert.equal(count('Runtime.evaluate'),3);assert.equal(count('Runtime.callFunctionOn'),3);
  assert(f.calls.filter(c=>c.method==='Runtime.evaluate').every(c=>c.params.uniqueContextId==='unique-child'&&!('contextId' in c.params)));
  await f.manager.end(f.run.id);assert.equal(count('Runtime.releaseObject'),1);
});
for(const moved of [false,true])test('a pinned window lookup overlaps the tab read'+(moved?' and rejects tab movement':''),async()=>{
  const f=fixture();f.run.windowId=1;await f.manager.start(f.run);
  let tabReady,windowReady;const entered=[];
  f.api.tabs.get=()=>{entered.push('tab');return new Promise(resolve=>{tabReady=()=>resolve({url:f.run.topUrl,windowId:moved?2:1});});};
  f.api.windows={get:id=>{assert.equal(id,1);entered.push('window');return new Promise(resolve=>{windowReady=()=>resolve({focused:true});});}};
  const live=f.manager.live(f.manager.session),outcome=moved?assert.rejects(live,/다른 Chrome 창/):live;
  assert.deepEqual(entered,['tab','window']);windowReady();tabReady();await outcome;
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);await f.manager.end(f.run.id);
});
for(const changed of [false,true])test('a warm iframe claim overlaps token validation'+(changed?' but a changed token cannot authorize input':''),async()=>{
  const f=await iframeFixture(),original=f.api.debugger.sendCommand;let finishToken,blocked=false,claims=0;
  f.api.debugger.sendCommand=(target,method,params)=>{
    if(method==='Runtime.evaluate'&&!blocked){blocked=true;return new Promise(resolve=>{finishToken=()=>resolve({result:{value:changed?'other-token':'token'}});});}
    return original(target,method,params);
  };
  const commit=f.manager.commitInput;f.manager.commitInput=(...args)=>{claims++;return commit(...args);};
  const flight=f.manager.click(f.request,f.sender),outcome=changed?assert.rejects(flight,/識別|식별 정보가 변경/):flight;
  await new Promise(setImmediate);assert.equal(claims,1);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);
  finishToken();await outcome;assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,changed?0:1);await f.manager.end(f.run.id);
});

for(const method of ['Page.frameAttached','Page.frameDetached','Page.frameNavigated','Page.navigatedWithinDocument','Page.documentOpened'])test(method+' discards cached routes and owners before the next read',async()=>{
  const f=await iframeFixture(),session=f.manager.session,revision=session.frameRevision;
  f.event({tabId:7},method,{frame:{id:'unrelated'}});
  assert(session.frameRevision>revision);assert.equal(session.mappingCache,null);assert.equal(session.ownerCache.size,0);
  const result=await f.manager.anchor(f.request,f.sender);assert.equal(result.success,true);
  assert.equal(f.calls.filter(c=>c.method==='Page.getFrameTree').length,2);
  assert.equal(f.calls.filter(c=>c.method==='DOM.resolveNode').length,2);await f.manager.end(f.run.id);
});

test('unique execution-context destruction invalidates the route even without its old numeric id',async()=>{
  const f=await iframeFixture();f.event({tabId:7},'Runtime.executionContextDestroyed',{executionContextUniqueId:'unique-child'});
  assert.equal(f.manager.session.contexts.size,0);assert.equal(f.manager.session.mappingCache,null);assert.equal(f.manager.session.ownerCache.size,0);
  await assert.rejects(f.manager.click(f.request,f.sender),/하나로 연결/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);await f.manager.end(f.run.id);
});

test('a cached context whose document token changed cannot send input or silently retarget',async()=>{
  const f=await iframeFixture(),command=f.api.debugger.sendCommand;f.calls.length=0;
  f.api.debugger.sendCommand=async(target,method,params)=>{const result=await command(target,method,params);return method==='Runtime.evaluate'?{result:{value:'replacement-token'}}:result;};
  await assert.rejects(f.manager.click(f.request,f.sender),/식별 정보가 변경/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);assert.equal(f.calls.filter(c=>c.method==='Page.getFrameTree').length,0);
  await f.manager.end(f.run.id);
});

test('a disconnected cached owner rejects geometry without resolving a replacement',async()=>{
  const f=await iframeFixture(),command=f.api.debugger.sendCommand;f.calls.length=0;
  f.api.debugger.sendCommand=async(target,method,params)=>{const result=await command(target,method,params);return method==='Runtime.callFunctionOn'?{exceptionDetails:{text:'iframe 소유 요소가 교체되었습니다.'}}:result;};
  await assert.rejects(f.manager.click(f.request,f.sender),/소유 요소가 교체/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);assert.equal(f.calls.filter(c=>c.method==='DOM.resolveNode').length,0);
  assert.equal(f.manager.session.ownerCache.size,0);await f.manager.end(f.run.id);
});

test('owner creation finishing after invalidation is released and cannot republish a stale cache',async()=>{
  const f=await iframeFixture();f.manager.invalidateFrames(f.manager.session,true);const session=f.manager.session,revision=session.frameRevision;
  const command=f.api.debugger.sendCommand;let finish;
  f.api.debugger.sendCommand=async(target,method,params)=>{if(method==='DOM.resolveNode')await new Promise(resolve=>{finish=resolve;});return command(target,method,params);};
  const tree={id:'child',loaderId:'child-loader'},parent={id:'root',loaderId:'root-loader'};
  const creation=f.manager.frameOwner(session,tree,parent,revision),outcome=assert.rejects(creation,/文書|문서/);
  await new Promise(setImmediate);f.manager.invalidateFrames(session,true);finish();await outcome;
  assert.equal(session.ownerCache.size,0);assert.equal(session.ownerLoads.size,0);
  await f.manager.drainFrameCache(session);await f.manager.end(f.run.id);
});

test('a new matching context invalidates a warm route and preserves ambiguity rejection',async()=>{
  const f=await iframeFixture();f.event({tabId:7},'Runtime.executionContextCreated',{context:{id:2,uniqueId:'unique-other',origin:'chrome-extension://extension',auxData:{isDefault:false,frameId:'child'}}});
  await assert.rejects(f.manager.click(f.request,f.sender),/하나로 연결/);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);await f.manager.end(f.run.id);
});
test('missing manual pointer information is rejected before any input',async()=>{
  const f=fixture();await f.manager.start(f.run);
  await assert.rejects(f.manager.click({...f.request,point:{...f.request.point,pointerAnchor:undefined}},f.sender),/사용자 마우스/);
  assert.equal(f.calls.filter(c=>c.method==='Input.dispatchMouseEvent').length,0);await f.manager.end(f.run.id);
});
test('parent geometry changed since manual placement waits for a new pointer with zero presses',async()=>{
  const f=fixture();await f.manager.start(f.run);f.request.point.pointerAnchor='stale-parent';
  const result=await f.manager.click(f.request,f.sender);assert(result.waitForPointer);
  assert(!f.manager.session.canceled);assert.equal(f.data.ticketCdpSession.state,'attached');
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);await f.manager.end(f.run.id);
});
test('Chrome losing window focus defers input without canceling the unpressed session',async()=>{
  const f=fixture();f.api.tabs.get=async()=>({url:f.run.topUrl,windowId:1});f.api.windows={get:async()=>({focused:false})};
  await f.manager.start(f.run);const result=await f.manager.click(f.request,f.sender);assert(result.waitForPointer);
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);await f.manager.end(f.run.id);
});
test('pointer changes during preflight defer input without sending or replaying a press',async()=>{
  const f=fixture();f.api.tabs.sendMessage=async()=>({success:false,waitForPointer:true,error:'마우스 위치 변경'});
  await f.manager.start(f.run);const result=await f.manager.click(f.request,f.sender);assert(result.waitForPointer);
  assert(!f.manager.session.canceled);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,0);await f.manager.end(f.run.id);
});
test('pointer loss after press releases and terminates instead of resuming placement',async()=>{
  const f=fixture(),original=f.api.tabs.sendMessage;
  f.api.tabs.sendMessage=async(tab,request)=>request.afterPress?{success:false,waitForPointer:true,error:'마우스 위치 변경'}:original(tab,request);
  await f.manager.start(f.run);await assert.rejects(f.manager.click(f.request,f.sender),/재시도/);
  assert(f.manager.session.canceled);assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);
  assert(f.calls.some(c=>c.params?.type==='mouseReleased'&&c.params.x===-1));await f.manager.end(f.run.id);
});

test('post-press viewport starts with the page reply but both must finish before release',async()=>{
  const f=fixture();await f.manager.start(f.run);f.request.intent={lastAttempt:{eventType:'click'}};
  const command=f.api.debugger.sendCommand,send=f.api.tabs.sendMessage;let metricCount=0,finishMetrics,finishPage;
  f.api.debugger.sendCommand=async(t,m,p)=>{const value=await command(t,m,p);if(m==='Page.getLayoutMetrics'&&++metricCount===2)await new Promise(r=>{finishMetrics=r;});return value;};
  f.api.tabs.sendMessage=async(t,r)=>r.afterPress?new Promise(resolve=>{finishPage=()=>resolve({success:true});}):send(t,r);
  const flight=f.manager.click(f.request,f.sender);await new Promise(setImmediate);
  assert.equal(typeof finishMetrics,'function');assert.equal(typeof finishPage,'function');
  finishMetrics();await new Promise(setImmediate);assert.equal(f.calls.filter(c=>c.params?.type==='mouseReleased').length,0);
  finishPage();await flight;assert.equal(metricCount,2);await f.manager.end(f.run.id);
});
test('stop during an early post-press viewport query cannot authorize release at the saved point',async()=>{
  const f=fixture();await f.manager.start(f.run);f.request.intent={lastAttempt:{eventType:'click'}};
  const command=f.api.debugger.sendCommand;let count=0,finish;
  f.api.debugger.sendCommand=async(t,m,p)=>{const value=await command(t,m,p);if(m==='Page.getLayoutMetrics'&&++count===2)await new Promise(r=>{finish=r;});return value;};
  f.api.tabs.sendMessage=async(t,r)=>r.afterPress?{success:true,completedOnPress:true}:{success:true,point:{...f.request.point}};
  const flight=f.manager.click(f.request,f.sender),outcome=assert.rejects(flight,/중지/);await new Promise(setImmediate);
  f.manager.cancel(f.run.id);finish();await outcome;
  assert.equal(f.calls.filter(c=>c.params?.type==='mousePressed').length,1);
  assert(!f.calls.some(c=>c.params?.type==='mouseReleased'&&c.params.clickCount===1));await f.manager.end(f.run.id);
});

