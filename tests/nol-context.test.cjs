/* Actual extension + CDP, fully intercepted local NOL responses. No live booking input. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {chromium}=require('playwright'),C=require('../shared.js'),{createTemporaryProfile,closeTemporaryContext}=require('./temporary-profile.cjs');
const root=path.resolve(__dirname,'..'),origin='https://tickets.interpark.com',gate=origin+'/gates/ticket/26014584?fixture=speed-review';
const runtime=['background.js','shared.js','capture.js','analyze.js','cdp.js','content.js','popup.html','popup.js','popup.css'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const repeat=Number(process.env.TICKET_CONTEXT_REPEAT||1),tracing=process.env.TICKET_CONTEXT_TRACE!=='0',expectedRpc=Number(process.env.TICKET_CONTEXT_POST_RPC||1);
assert(Number.isInteger(repeat)&&repeat>0&&repeat<=50);
const reportFile=path.join(__dirname,path.basename(process.env.TICKET_CONTEXT_REPORT||'nol-context-results.json'));
const report={createdAt:new Date().toISOString(),version:JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))).version,localFixturesOnly:true,liveBookingInput:false,instrumented:tracing,
  source:runtime.map(file=>({file,sha256:hash(fs.readFileSync(path.join(root,file)))})),trials:[]};
const html=`<!doctype html><meta charset="utf-8"><title>로컬 NOL 새 창 속도 검토</title><style>button{margin:100px;width:300px;height:80px}</style>
<main id="area"><button id="book" class="_primary_2p3w6_7 _disabled_2p3w6_34" disabled><span class="_content_2p3w6_38">남은시간 00:01</span></button></main><div id="result">대기</div>
<script>
globalThis.inputs=[];globalThis.pointerEvents=[];globalThis.clicks=0;globalThis.fixtureMode='context';globalThis.activationAt=null;
for(const type of ['pointermove','pointerover','pointerout','pointerup'])document.addEventListener(type,e=>pointerEvents.push({type:e.type,isTrusted:e.isTrusted,x:e.clientX,y:e.clientY,screenX:e.screenX,screenY:e.screenY,buttons:e.buttons,target:e.target.id||e.target.tagName,related:e.relatedTarget?.id||e.relatedTarget?.tagName||null,at:performance.now()}),true);
for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.addEventListener(type,e=>{
  if(!e.target.closest('button'))return;inputs.push({type:e.type,isTrusted:e.isTrusted,at:performance.now()});
  if(type==='click'){clicks++;result.textContent='클릭 완료';if(fixtureMode==='context')window.open('/onestop/seat','_blank');}
});
globalThis.activate=replacement=>{const old=document.querySelector('button');if(replacement){const next=document.createElement('button');next.id='new-book';next.className='_primary_2p3w6_7';next.innerHTML='<span class="_content_2p3w6_38">예매하기</span>';activationAt=performance.now();old.replaceWith(next);}
else{activationAt=performance.now();old.disabled=false;old.classList.remove('_disabled_2p3w6_34');old.firstElementChild.textContent='예매하기';}};
</script>`;
let context,temporaryProfile;
(async()=>{
  const extension=fs.mkdtempSync(path.join(__dirname,'.speed-review-extension-'));
  for(const file of runtime)fs.copyFileSync(path.join(root,file),path.join(extension,file));
  for(const [file,key,variable] of [['background.js','backgroundSourceOverride','TICKET_BACKGROUND_SOURCE'],['cdp.js','cdpSourceOverride','TICKET_INPUT_CDP_SOURCE'],['content.js','contentSourceOverride','TICKET_CONTENT_SOURCE']])if(process.env[variable]){
    const source=fs.realpathSync(process.env[variable]),bytes=fs.readFileSync(source);fs.writeFileSync(path.join(extension,file),bytes);report[key]={path:source,sha256:hash(bytes)};
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));manifest.host_permissions=[origin+'/*'];fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  temporaryProfile=createTemporaryProfile('input');context=await chromium.launchPersistentContext(temporaryProfile,{channel:'chromium',headless:true,viewport:{width:1000,height:800},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  await context.route('**/*',route=>{const u=new URL(route.request().url());return u.origin===origin?route.fulfill({contentType:'text/html; charset=utf-8',body:u.pathname==='/onestop/seat'?'<title>로컬 좌석 인계</title>수동 진행':html}):u.protocol==='http:'||u.protocol==='https:'?route.abort():route.continue();});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),popup=await context.newPage();await popup.goto('chrome-extension://'+worker.url().split('/')[2]+'/popup.html');
  await worker.evaluate(tracing=>{
    globalThis.speedTrace=[];globalThis.contextLogSeed=0;
    // Test-only realistic history, inserted before the unmodified document
    // engine starts. No code path or clock is changed during timed input.
    const send=chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage=(tab,request,options)=>{
      if(request.action==='startEngine'&&contextLogSeed){const run={...request.run};run.logs=[...(run.logs||[]),...Array.from({length:contextLogSeed},(_,i)=>({runId:run.id,timestamp:Date.now()-1000+i,event:'fixture-history',message:'seed'}))];request={...request,run};}
      return send(tab,request,options);
    };
    if(tracing)for(const name of ['live','command','sendDocument','commitInput']){const original=cdp[name];cdp[name]=async function(...args){const start=performance.now(),entry={name,afterPress:!!args[0]?.mouseDown};
      if(name==='command'){entry.method=args[1];entry.type=args[2]?.type;}if(name==='sendDocument'){entry.action=args[1]?.action;entry.requestAfterPress=!!args[1]?.afterPress;}
      speedTrace.push(entry);try{return await original.apply(this,args);}finally{entry.durationMs=performance.now()-start;}};}
  },tracing);
  const idle=()=>popup.waitForFunction(()=>document.getElementById('profile').options.length&&!document.getElementById('captureTab').disabled);
  const getRun=()=>popup.evaluate(async()=>{const {macroRun,macroLogs}=await chrome.storage.local.get(['macroRun','macroLogs']);return macroRun&&{...macroRun,logs:Array.isArray(macroRun.logs)?macroRun.logs:(macroLogs||[]).filter(x=>x.runId===macroRun.id)};});
  const waitRun=async predicate=>{for(let i=0;i<300;i++){const value=await getRun();if(predicate(value))return value;await popup.waitForTimeout(15);}throw Error('Run timeout '+JSON.stringify(await getRun()));};
  await idle();
  const scenarios=[{mode:'text',replacement:false},{mode:'text',replacement:true},{mode:'context',replacement:false},{mode:'context',replacement:true},{mode:'context',replacement:true,large:true}];
  for(const {mode,replacement,large=false} of scenarios){
    const profile=C.nolProfile();profile.url=gate;Object.assign(profile.settings,{clickMethod:'cdp',testMode:false});profile.steps[0].timeoutMs=120000;
    if(mode==='text')profile.steps[0].verify={kind:'textChanged',selector:'#result',value:'',timeoutMs:3000};
    const saved=await popup.evaluate(async profile=>{const settings=await chrome.runtime.sendMessage({action:'getSettings'});return chrome.runtime.sendMessage({action:'saveProfiles',profiles:settings.ticketProfiles.map(p=>p.id===profile.id?profile:p),activeProfileId:profile.id});},profile);assert(saved.success,saved.error);
    await worker.evaluate(large=>{contextLogSeed=large?400:0;},large);
    for(let index=0;index<repeat;index++){
      const page=await context.newPage();await page.goto(gate);await page.evaluate(mode=>{fixtureMode=mode;},mode);await page.bringToFront();await popup.reload();await idle();
      const prior=(await getRun())?.id,control=await context.newCDPSession(popup);try{await control.send('Runtime.evaluate',{expression:"document.getElementById('start').click()",userGesture:true});}finally{await control.detach();}
      const started=await waitRun(run=>run?.id!==prior&&run?.status==='watching');const box=await page.locator('button').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      await page.waitForFunction(()=>/위치 기록 완료/.test(document.getElementById('ticket-click-pointer-help')?.textContent||''));
      await page.waitForTimeout(30);
      await worker.evaluate(()=>{speedTrace=[];});await page.evaluate(replacement=>activate(replacement),replacement);await popup.waitForTimeout(60);
      const finished=await waitRun(run=>run?.id===started.id&&!C.isActive(run));const detail=await page.evaluate(()=>({inputs,pointerEvents,clicks,activationAt}));
      const trace=await worker.evaluate(()=>speedTrace),childPages=context.pages().filter(p=>p!==page&&p!==popup&&p.url().startsWith(origin+'/onestop/seat'));
      let error=null;try{assert.equal(finished.status,mode==='context'?'handoff':'completed',finished.message);assert.equal(detail.clicks,1);assert.deepEqual(detail.inputs.map(e=>e.type),['pointerdown','mousedown','pointerup','mouseup','click']);assert(detail.inputs.every(e=>e.isTrusted));assert.equal(finished.logs.filter(x=>x.event==='click-attempt').length,1);assert.equal(childPages.length,mode==='context'?1:0);
        if(tracing)assert.equal(trace.filter(t=>t.name==='sendDocument'&&t.afterPress).length,mode==='context'?expectedRpc:2);
        if(large)assert.equal(finished.logs.filter(x=>x.event==='fixture-history').length,400);
      }catch(e){error=e.message;}
      const down=detail.inputs.find(e=>e.type==='pointerdown'),click=detail.inputs.find(e=>e.type==='click');
      report.trials.push({mode,replacement,large,index,pass:!error,error,status:finished.status,message:finished.message,clicks:detail.clicks,verify:finished.profile.steps[0].verify,
        activationToPointerdownMs:down?down.at-detail.activationAt:null,activationToClickMs:click?click.at-detail.activationAt:null,
        pointerdownToClickMs:down&&click?click.at-down.at:null,timing:finished.logs.find(x=>x.event==='click-timing'),trace,inputs:detail.inputs,pointerEvents:detail.pointerEvents,logs:finished.logs,diagnostics:finished.finalDiagnostics});
      fs.writeFileSync(reportFile,JSON.stringify(report,null,2));console.log((error?'FAIL ':'PASS ')+mode+' '+(replacement?'replacement':'stable')+(large?' large':'')+' '+index);
      for(let i=0;i<30&&await worker.evaluate(()=>!!cdp.session);i++)await popup.waitForTimeout(10);
      for(const child of childPages)await child.close();await page.close();
    }
  }
  report.summary={passed:report.trials.filter(t=>t.pass).length,total:scenarios.length*repeat,failures:report.trials.filter(t=>!t.pass).length,duplicates:report.trials.filter(t=>t.clicks>1).length};
  if(report.summary.failures)process.exitCode=1;
})().catch(error=>{report.error=error.stack;process.exitCode=1;console.error(error.stack);}).finally(async()=>{report.finishedAt=new Date().toISOString();fs.writeFileSync(reportFile,JSON.stringify(report,null,2));await closeTemporaryContext(context,temporaryProfile);});
