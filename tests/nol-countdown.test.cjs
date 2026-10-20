/* Actual extension + CDP against isolated local responses. Never requests a live ticket page. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createTemporaryProfile,closeTemporaryContext}=require('./temporary-profile.cjs');
const {chromium}=require(process.env.TICKET_PLAYWRIGHT_MODULE||'playwright');
const C=require('../shared.js'),Capture=require('../capture.js');
const gate='https://tickets.interpark.com/gates/ticket/26014584?bc=61776&pc=26001059&ps=&pass_code=';
const seat='https://tickets.interpark.com/onestop/seat';
const report={createdAt:new Date().toISOString(),fixtureResponses:true,liveBookingInput:false,cases:[]};let context,popup,temporaryProfile;
const html=`<!doctype html><meta charset="utf-8"><title>로컬 NOL 카운트다운</title>
<style>button{margin:80px;width:300px;height:70px}</style>
<button id="book" class="_primary_2p3w6_7 _disabled_2p3w6_34" disabled><span class="_content_2p3w6_38">남은시간 35:45</span></button>
<div id="position" style="position:fixed;left:500px;top:100px;width:180px;height:80px">사용자가 놓은 다른 위치</div><div id="result">대기</div>
<script>
globalThis.inputs=[];globalThis.clicks=0;globalThis.ticks=0;globalThis.activationAt=null;
globalThis.clock=setInterval(()=>{ticks++;book.firstElementChild.textContent='남은시간 35:'+String(59-ticks%60).padStart(2,'0')},35);
for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.addEventListener(type,e=>{inputs.push({type:e.type,isTrusted:e.isTrusted,target:e.target.closest('[id]')?.id,at:performance.now()});if(type==='click'){clicks++;result.textContent='클릭 완료';}});
globalThis.activate=()=>{clearInterval(clock);activationAt=performance.now();book.disabled=false;book.classList.remove('_disabled_2p3w6_34');book.firstElementChild.textContent='예매하기';};
</script>`;
(async()=>{
  const extension=path.resolve(__dirname,'.extension-under-test');fs.mkdirSync(extension,{recursive:true});
  for(const file of ['background.js','shared.js','capture.js','analyze.js','cdp.js','content.js','popup.html','popup.js','popup.css'])fs.copyFileSync(path.resolve(__dirname,'..',file),path.join(extension,file));
  for(const [file,variable,key] of [['background.js','TICKET_BACKGROUND_SOURCE','backgroundSourceOverride'],['cdp.js','TICKET_INPUT_CDP_SOURCE','cdpSourceOverride']])if(process.env[variable]){
    const source=fs.realpathSync(process.env[variable]),data=fs.readFileSync(source);
    fs.writeFileSync(path.join(extension,file),data);
    report[key]={path:source,sha256:require('node:crypto').createHash('sha256').update(data).digest('hex')};
  }
  if(process.env.TICKET_CONTENT_SOURCE){
    const source=fs.realpathSync(process.env.TICKET_CONTENT_SOURCE),data=fs.readFileSync(source);
    fs.writeFileSync(path.join(extension,'content.js'),data);
    report.contentSourceOverride={path:source,sha256:require('node:crypto').createHash('sha256').update(data).digest('hex')};
  }
  const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../manifest.json'),'utf8'));report.version=manifest.version;
  manifest.host_permissions=['https://tickets.interpark.com/*'];fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  temporaryProfile=createTemporaryProfile('nol-countdown');
  context=await chromium.launchPersistentContext(temporaryProfile,{channel:'chromium',headless:true,viewport:{width:1000,height:900},
    args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  await context.route('https://tickets.interpark.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:new URL(route.request().url()).pathname==='/onestop/seat'?'<title>로컬 좌석 화면</title><button disabled>선택 완료</button>':html}));
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');report.browser=await worker.evaluate(()=>navigator.userAgent);
  popup=await context.newPage();await popup.goto('chrome-extension://'+worker.url().split('/')[2]+'/popup.html');
  const rpc=request=>popup.evaluate(request=>chrome.runtime.sendMessage(request),request);
  const idle=()=>popup.waitForFunction(()=>document.getElementById('profile').options.length&&!document.getElementById('captureTab').disabled);
  const run=()=>popup.evaluate(async()=>{const {macroRun,macroLogs}=await chrome.storage.local.get(['macroRun','macroLogs']);
    return macroRun&&!Array.isArray(macroRun.logs)?{...macroRun,logs:(macroLogs||[]).filter(log=>log.runId===macroRun.id)}:macroRun;});
  const waitRun=async predicate=>{for(let i=0;i<400;i++){const value=await run();if(predicate(value))return value;await popup.waitForTimeout(15);}throw Error('Run timeout: '+JSON.stringify(await run())+' '+await popup.locator('#preparationStatus').innerText());};
  const save=async profile=>{const data=await rpc({action:'getSettings'});assert.equal((await rpc({action:'saveProfiles',profiles:data.ticketProfiles.map(p=>p.id===profile.id?profile:p),activeProfileId:profile.id})).success,true);};
  const profile=()=>{const p=C.nolProfile();p.url=gate;Object.assign(p.settings,{clickMethod:'cdp',testMode:false});p.steps[0].timeoutMs=120000;p.steps[0].verify={kind:'textChanged',selector:'#result',value:'',timeoutMs:3000};return p;};
  const start=async page=>{
    await page.bringToFront();await popup.reload();await idle();
    const prior=(await run())?.id,control=await context.newCDPSession(popup);
    try{await control.send('Runtime.evaluate',{expression:"document.getElementById('start').click()",userGesture:true});}finally{await control.detach();}
    return waitRun(value=>value?.id!==prior&&value?.status==='watching');
  };
  const placePointer=async(page,selector='#position')=>{
    const box=await page.locator(selector).boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.waitForFunction(()=>/위치 기록 완료/.test(document.getElementById('ticket-click-pointer-help')?.textContent||''));
  };
  const assertOneClick=async(page,started)=>{
    const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value));assert.equal(finished.status,'completed',finished.message);
    const data=await page.evaluate(()=>({inputs,clicks,activationAt}));assert.equal(data.clicks,1);
    assert.deepEqual(data.inputs.map(event=>event.type),['pointerdown','mousedown','pointerup','mouseup','click']);
    assert(data.inputs.every(event=>event.isTrusted&&event.at>=data.activationAt));
    assert.equal(finished.logs.filter(log=>log.event==='click-attempt').length,1);
    assert.equal(finished.logs.filter(log=>log.event==='step-wait').length,1,'replacement reset the step/deadline');
    return {clicks:1,duplicates:0,status:finished.status,clickAttempts:finished.logs.filter(log=>log.event==='click-attempt').length,
      rebinds:finished.logs.filter(log=>log.event==='button-rebound').length,activationToClickMs:data.inputs.at(-1).at-data.activationAt,
      timing:finished.logs.find(log=>log.event==='click-timing'),events:data.inputs};
  };
  const repeat=Number(process.env.TICKET_NOL_REPEAT||1);
  assert(Number.isInteger(repeat)&&repeat>=1&&repeat<=50,'TICKET_NOL_REPEAT must be 1 to 50');
  const record=async(name,fn)=>{
    if(process.env.TICKET_NOL_PATTERN&&!new RegExp(process.env.TICKET_NOL_PATTERN).test(name))return;
    for(let index=0;index<repeat;index++)try{const detail=await fn();report.cases.push({name,index,pass:true,...detail});console.log('PASS '+name+(repeat>1?' '+index:''));}
    catch(error){report.cases.push({name,index,pass:false,error:error.stack});console.error('FAIL '+name+': '+error.message);await rpc({action:'stopMacro'}).catch(()=>{});}
  };
  await idle();await save(profile());
  await record('active button with no pointer is logged independently and gets a complete stop snapshot',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);const started=await start(page);
    await page.evaluate(()=>activate());
    const active=await waitRun(value=>value?.logs?.some(log=>log.event==='button-detected'));
    const detected=active.logs.find(log=>log.event==='button-detected');assert.equal(detected.pointerReady,false);assert.equal(detected.pointerState,'missing');
    assert.match(active.message,/버튼 활성화 확인/);assert.equal(await page.evaluate(()=>inputs.length),0);
    for(let i=0;i<25;i++)await page.evaluate(()=>{document.getElementById('book').firstElementChild.textContent='예매하기 ';});
    await rpc({action:'stopMacro'});const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value));
    const diagnostic=finished.finalDiagnostics;assert(diagnostic);assert.equal(diagnostic.source,'document');assert.equal(diagnostic.liveDomAvailable,true);
    assert.equal(diagnostic.button.text,'예매하기');assert.equal(diagnostic.button.disabled,false);assert.equal(diagnostic.button.ready,true);
    assert.equal(diagnostic.pointer.state,'missing');assert.equal(diagnostic.pointer.hasPosition,false);
    assert.equal(diagnostic.timing.monitorStartedAt,started.monitorStartedAt);assert.equal(diagnostic.timing.monitorEndedAt,finished.endedAt);
    assert.equal(finished.logs.filter(log=>log.event==='button-detected').length,1);assert.equal(await page.evaluate(()=>inputs.length),0);
    await page.close();return {pageInputs:0,buttonActive:true,pointerReady:false,source:diagnostic.source};
  });
  await record('activation timestamp precedes later pointer readiness and one CDP click',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);const started=await start(page);
    await page.evaluate(()=>activate());const active=await waitRun(value=>value?.logs?.some(log=>log.event==='button-detected'));
    const detected=active.logs.find(log=>log.event==='button-detected');await page.waitForTimeout(90);
    const box=await page.locator('#position').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    const detail=await assertOneClick(page,started),finished=await run();
    const pointer=finished.logs.find(log=>log.event==='pointer-state'&&log.pointerReady);
    assert(pointer.timestamp>=detected.timestamp);assert.equal(finished.lastAttempt.actionableDetectedAt,detected.timestamp);
    assert(finished.lastAttempt.detectToAttemptMs>=80);assert.equal(finished.finalDiagnostics.pointer.ready,true);
    assert.equal(finished.logs.filter(log=>log.event==='click-attempt').length,1);await page.close();return {...detail,activationWaitLoggedMs:finished.lastAttempt.detectToAttemptMs};
  });
  await record('disabled button and invalidated pointer coordinates are captured at manual stop',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);const started=await start(page);await placePointer(page);
    await page.evaluate(()=>window.dispatchEvent(new Event('scroll')));
    await waitRun(value=>value?.logs?.some(log=>log.event==='pointer-invalidated'&&log.pointerReason==='scroll'));
    await rpc({action:'stopMacro'});const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value)),diagnostic=finished.finalDiagnostics;
    assert.equal(diagnostic.button.disabled,true);assert(diagnostic.button.className.includes('_disabled_2p3w6_34'));
    assert.equal(diagnostic.pointer.state,'invalidated');assert.equal(diagnostic.pointer.ready,false);
    assert.equal(diagnostic.pointer.lastInvalidation.reason,'scroll');assert(Number.isFinite(diagnostic.pointer.lastKnownX));
    assert.equal(await page.evaluate(()=>inputs.length),0);await page.close();return {pageInputs:0,pointerState:diagnostic.pointer.state};
  });
  await record('closed tab stores explicitly historical observations without inventing current DOM state',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);const started=await start(page);
    await page.evaluate(()=>activate());await waitRun(value=>value?.lastObservation?.button.ready);await page.close();
    const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value));assert.equal(finished.finalDiagnostics.liveDomAvailable,false);
    assert.equal(finished.finalDiagnostics.source,'controller-last-observation');assert.equal(finished.finalDiagnostics.button.ready,true);
    assert(finished.finalDiagnostics.observationCapturedAt<=finished.endedAt);return {source:finished.finalDiagnostics.source,liveDomAvailable:false};
  });
  await record('stopping scheduled preparation records the real button without inventing a monitor start time',async()=>{
    const p=profile();p.settings.mode='hybrid';p.settings.scheduledAt=Date.now()+120000;await save(p);
    const page=await context.newPage();await page.goto(gate);await page.bringToFront();const previous=(await run())?.id;
    const captured=await rpc({action:'captureCurrentTab',profile:p});assert(captured.success,captured.error);
    const prepared=C.applyTabCapture(p,captured.captured);await save(prepared);
    const response=await rpc({action:'startMacro',captureTarget:captured.captured.target,expectedProfile:prepared});assert(response.success,response.error);
    const started=await waitRun(value=>value?.id!==previous&&value?.status==='scheduled');
    await rpc({action:'stopMacro'});const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value));
    assert.equal(finished.finalDiagnostics.button.disabled,true,JSON.stringify(finished.finalDiagnostics));assert.equal(finished.finalDiagnostics.timing.monitorStartedAt,null);
    assert.equal(finished.finalDiagnostics.timing.monitorElapsedMs,null);assert.equal(await page.evaluate(()=>inputs.length),0);
    await page.close();return {pageInputs:0,monitorStartedAt:null};
  });
  await record('read-only countdown capture accepts verified structure, rejects lookalikes and access notices',async()=>{
    const page=await context.newPage();await page.goto(gate);
    const captured=await page.evaluate(Capture.readButtons,profile());assert(!captured.captureError,captured.captureError);
    assert.equal(captured.buttons.length,1);assert(captured.buttons[0].nolPrimary);assert(captured.buttons[0].disabled);assert(captured.buttons[0].remainingSeconds>120);
    await page.evaluate(()=>{book.disabled=false;});assert.equal((await page.evaluate(Capture.readButtons,profile())).buttons[0].disabled,true);
    await page.evaluate(()=>{book.firstElementChild.className='unverified';clearInterval(clock);});
    const narrowed=profile();narrowed.scopeSelector='body';assert.match((await page.evaluate(Capture.readButtons,narrowed)).captureError,/찾지 못/);
    await page.evaluate(()=>{book.firstElementChild.className='_content_2p3w6_38';const dialog=document.createElement('div');dialog.setAttribute('role','dialog');dialog.textContent='직접 확인';document.body.append(dialog);});
    assert.match((await page.evaluate(Capture.readButtons,profile())).captureError,/안내창/);assert.equal(await page.evaluate(()=>inputs.length),0);await page.close();
    return {pageInputs:0};
  });
  await record('multiple countdown buttons require a refreshed explicit selection; manual context stays restrictive',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);await page.evaluate(()=>{const other=book.cloneNode(true);other.id='other';document.body.append(other);});
    await page.bringToFront();await popup.reload();await idle();
    assert.equal(await popup.locator('#captureChoices').isVisible(),true);assert.equal(await page.evaluate(()=>inputs.length),0);
    const constrained=profile();constrained.steps[0].containerSelector='body';constrained.steps[0].targetText='없는 공연 이름';
    assert.match((await page.evaluate(Capture.readButtons,constrained)).captureError,/찾지 못/);
    await popup.locator('#captureChoice').selectOption('0');await page.waitForTimeout(120);
    // The UI selection handler re-reads the countdown, it does not start a run.
    await page.bringToFront();await popup.evaluate(()=>document.getElementById('applyCapture').click());await idle();
    assert.equal(await popup.locator('#captureChoices').isVisible(),false);assert.equal(await popup.locator('#scope').inputValue(),'#book');
    assert.equal(await page.evaluate(()=>inputs.length),0);await page.close();return {pageInputs:0,selectedScope:'#book'};
  });
  for(const pointerTarget of ['#book','#position'])await record('countdown text drift before engine binding; CDP clicks once at '+pointerTarget,async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);await page.bringToFront();
    // Force capture -> first binding drift; use real API after the delay.
    await worker.evaluate(()=>{globalThis.originalInject=chrome.scripting.executeScript.bind(chrome.scripting);chrome.scripting.executeScript=async request=>{if(request.files?.includes('content.js'))await new Promise(resolve=>setTimeout(resolve,160));return globalThis.originalInject(request);};});
    try {
      const started=await start(page);assert(started.profile.steps[0].nolPrimary);assert.equal(started.profile.steps[0].timeoutMs,120000);
      assert.notEqual(started.profile.steps[0].buttonText,await page.locator('#book').innerText());
      assert.match(await popup.locator('#preparationStatus').innerText(),/2분より|2분보다/);
      const box=await page.locator(pointerTarget).boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      await page.waitForFunction(()=>/위치 기록 완료/.test(document.getElementById('ticket-click-pointer-help')?.textContent||''));
      assert.equal(await page.evaluate(()=>inputs.length),0);await page.evaluate(()=>activate());
      const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value));assert.equal(finished.status,'completed',finished.message);
      const data=await page.evaluate(()=>({inputs,clicks,ticks,activationAt}));assert.equal(data.clicks,1);assert(data.ticks>=4);
      assert.deepEqual(data.inputs.map(e=>e.type),['pointerdown','mousedown','pointerup','mouseup','click']);assert(data.inputs.every(e=>e.isTrusted===true));
      assert(data.inputs.every(e=>e.at>=data.activationAt));assert.equal(data.inputs.at(-1).target,pointerTarget.slice(1));
      assert.equal(await popup.evaluate(async()=> !!(await chrome.storage.local.get('ticketCdpSession')).ticketCdpSession),false);
      return {clicks:data.clicks,duplicates:0,status:finished.status,clickAttempts:finished.logs.filter(log=>log.event==='click-attempt').length,
        changed:true,activationToClickMs:data.inputs.at(-1).at-data.activationAt,events:data.inputs,timing:finished.logs.find(log=>log.event==='click-timing')};
    }finally{await worker.evaluate(()=>{chrome.scripting.executeScript=globalThis.originalInject;});await page.close();}
  });
  for(const scenario of ['disabled-replacement','active-new-id','active-under-cursor','delayed-insertion','repeated-replacement'])await record('NOL reacquires '+scenario+' then sends one CDP click',async()=>{
    const p=profile();if(scenario==='active-new-id'){p.scopeSelector='#book';p.steps[0].selector='#book';}
    await save(p);const page=await context.newPage();await page.goto(gate);const started=await start(page);
    const underCursor=['disabled-replacement','active-under-cursor'].includes(scenario);await placePointer(page,underCursor?'#book':'#position');
    const before=(await run()).monitorStartedAt;
    await page.evaluate(scenario=>{
      clearInterval(clock);const old=document.getElementById('book'),next=old.cloneNode(true);next.id='new-book';
      if(scenario.startsWith('active-')) {next.disabled=false;next.classList.remove('_disabled_2p3w6_34');next.firstElementChild.textContent='예매하기';activationAt=performance.now();}
      if(scenario==='delayed-insertion') {const parent=old.parentNode;old.remove();setTimeout(()=>parent.insertBefore(next,parent.firstChild),140);}
      else old.replaceWith(next);
    },scenario);
    if(!scenario.startsWith('active-')) {
      await waitRun(value=>value?.logs?.some(log=>log.event==='button-rebound'));
      if(scenario==='repeated-replacement') {
        await page.evaluate(()=>{const old=document.getElementById('new-book');old.replaceWith(old.cloneNode(true));});
        await waitRun(value=>value?.logs?.filter(log=>log.event==='button-rebound').length===2);
      }
      assert.equal(await page.evaluate(()=>inputs.length),0,'disabled replacement generated input');
      await page.evaluate(()=>{const next=document.getElementById('new-book');activationAt=performance.now();next.disabled=false;next.classList.remove('_disabled_2p3w6_34');next.firstElementChild.textContent='예매하기';});
    }
    const detail=await assertOneClick(page,started);assert.equal((await run()).monitorStartedAt,before);
    assert.equal((await run()).profile.steps[0].timeoutMs,120000);assert.equal(detail.rebinds,scenario==='repeated-replacement'?2:1);
    assert.equal(await page.evaluate(()=>inputs.at(-1).target),underCursor?'new-book':'position');await page.close();return detail;
  });
  for(const scenario of ['ambiguous','unknown-structure','connected-unrecognized','outside-area','area-replaced','access-notice','manual-context'])await record('NOL replacement '+scenario+' cannot cause input',async()=>{
    const p=profile();if(['outside-area','area-replaced','manual-context'].includes(scenario))p.scopeSelector='#gateScope';
    if(scenario==='manual-context'){p.steps[0].containerSelector='.row';p.steps[0].targetText='공연 A';}
    await save(p);const page=await context.newPage();await page.goto(gate);
    if(['outside-area','area-replaced','manual-context'].includes(scenario))await page.evaluate(()=>{
      const area=document.createElement('section');area.id='gateScope';book.before(area);
      const row=document.createElement('div');row.className='row';row.append(document.createTextNode('공연 A'));area.append(row);row.append(book);
    });
    const started=await start(page);await placePointer(page);
    await page.evaluate(scenario=>{
      clearInterval(clock);const old=document.getElementById('book'),next=old.cloneNode(true);next.id='replacement';next.disabled=false;next.classList.remove('_disabled_2p3w6_34');next.firstElementChild.textContent='예매하기';
      if(scenario==='ambiguous'){old.replaceWith(next);const other=next.cloneNode(true);other.id='second-replacement';next.after(other);}
      if(scenario==='unknown-structure'){next.className='unverified-primary';old.replaceWith(next);}
      if(scenario==='connected-unrecognized'){old.className='unverified-primary';}
      if(scenario==='outside-area'){old.remove();document.body.append(next);}
      if(scenario==='area-replaced'){const area=document.getElementById('gateScope');area.replaceWith(area.cloneNode(true));}
      if(scenario==='access-notice'){old.replaceWith(next);const notice=document.createElement('div');notice.setAttribute('role','dialog');notice.textContent='직접 확인';document.body.append(notice);}
      if(scenario==='manual-context'){old.closest('.row').firstChild.textContent='공연 B';old.replaceWith(next);}
    },scenario);
    if(['unknown-structure','connected-unrecognized','outside-area','manual-context'].includes(scenario)) {
      const waiting=await waitRun(value=>value?.logs?.some(log=>log.event==='button-search-wait'));
      assert.equal(waiting.status,'watching');assert.match(waiting.message,/새 NOL 버튼/);await rpc({action:'stopMacro'});
    } else {
      const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value));
      if(scenario==='ambiguous')assert.match(finished.message,/후보가 2개/);
      if(scenario==='area-replaced')assert.match(finished.message,/감시 영역도 교체/);
      if(scenario==='access-notice')assert.match(finished.message,/안전|확인|표시/);
    }
    assert.equal(await page.evaluate(()=>inputs.length),0);await page.close();return {pageInputs:0};
  });
  for(const scenario of ['replaced','disabled'])await record('NOL '+scenario+' during CDP preflight aborts before any press',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);const started=await start(page);await placePointer(page);
    await worker.evaluate(scenario=>{
      globalThis.originalSend=cdp.sendDocument;globalThis.replacedInPreflight=false;
      cdp.sendDocument=async(session,request)=>{
        if(request.action==='validateCdpTarget'&&!request.afterPress&&!globalThis.replacedInPreflight){
          globalThis.replacedInPreflight=true;await chrome.scripting.executeScript({target:{tabId:session.run.tabId,documentIds:[session.run.documentId]},func:scenario=>{const old=document.getElementById('book');if(scenario==='disabled')old.disabled=true;else old.replaceWith(old.cloneNode(true));},args:[scenario]});
        }
        return globalThis.originalSend(session,request);
      };
    },scenario);
    try {
      await page.evaluate(()=>activate());const finished=await waitRun(value=>value?.id===started.id&&!C.isActive(value));
      assert.match(finished.message,/입력 전에 NOL 감시 버튼/);assert.equal(await page.evaluate(()=>inputs.length),0);return {pageInputs:0};
    }finally{await worker.evaluate(()=>{cdp.sendDocument=globalThis.originalSend;});await page.close();}
  });
  await record('replacement after mouse press never resends a press or moves the cursor',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(gate);const started=await start(page);await placePointer(page);
    await page.evaluate(()=>{document.getElementById('position').addEventListener('pointerdown',()=>{const old=document.getElementById('book');old.replaceWith(old.cloneNode(true));});activate();});
    const detail=await assertOneClick(page,started);assert.equal(detail.rebinds,0);await page.close();return detail;
  });
  await record('seat page is explained without importing, saving or starting',async()=>{
    await save(profile());const page=await context.newPage();await page.goto(seat);await page.bringToFront();const before=await rpc({action:'getSettings'});
    await popup.reload();await idle();assert.match(await popup.locator('#preparationStatus').innerText(),/이미 좌석 선택/);
    const control=await context.newCDPSession(popup);try{await control.send('Runtime.evaluate',{expression:"document.getElementById('start').click()",userGesture:true});}finally{await control.detach();}
    await idle();assert.match(await popup.locator('#preparationStatus').innerText(),/이미 좌석 선택/);
    const after=await rpc({action:'getSettings'});assert.deepEqual(after.ticketProfiles,before.ticketProfiles);assert.deepEqual(after.run,before.run);
    await popup.screenshot({path:path.resolve(__dirname,'popup-'+manifest.version+'-seat-status.png'),fullPage:true});await page.close();return {runStarted:false,settingsUnchanged:true};
  });
})().catch(error=>{report.error=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{
  report.summary={passed:report.cases.filter(item=>item.pass).length,total:report.cases.length};
  if(process.env.TICKET_NOL_REPORT)fs.writeFileSync(path.resolve(__dirname,path.basename(process.env.TICKET_NOL_REPORT)),JSON.stringify(report,null,2));
  else {
    fs.writeFileSync(path.resolve(__dirname,'nol-countdown-results.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.resolve(__dirname,'nol-rebind-'+report.version+'-results.json'),JSON.stringify(report,null,2));
  }
  if(report.cases.some(item=>!item.pass))process.exitCode=1;await closeTemporaryContext(context,temporaryProfile);
});
