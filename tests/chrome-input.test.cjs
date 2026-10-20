/* Actual extension/API integration in an isolated Chrome for Testing profile. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {createTemporaryProfile,closeTemporaryContext}=require('./temporary-profile.cjs');
const C=require('../shared.js');
let playwright;
try { playwright=require('playwright'); }
catch { if(!process.env.TICKET_PLAYWRIGHT_MODULE)throw Error('Install devDependencies or set TICKET_PLAYWRIGHT_MODULE to the bundled Playwright path.');playwright=require(process.env.TICKET_PLAYWRIGHT_MODULE); }
process.env.TICKET_TEST_PORT='0';
const server=require('./server.cjs');
const report={createdAt:new Date().toISOString(),cases:[],measurements:[],notes:[
  'Isolated headless Chrome for Testing. Actual chrome.debugger extension API; production source files are copied unchanged.',
  'Only the test manifest adds loopback host permission. It does not validate the interactive optional-host permission prompt.',
  'For the worker-stop-during-press case, only the response of the real chrome.debugger.sendCommand is delayed one second as test-only fault injection; the original Chrome input command is still sent.',
  'User placement in these headless tests is driven by Playwright mouse.move producing real Chrome pointer events; it is not a physical Windows cursor test or proof that an event came from a human.',
  'Input properties are observed results for this browser build, not a universal isTrusted or detection-evasion guarantee.'
]};
let context,profile;
(async()=>{
  if(!server.listening)await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const extension=path.resolve(__dirname,'.extension-under-test');fs.mkdirSync(extension,{recursive:true});
  for(const file of ['background.js','shared.js','capture.js','analyze.js','cdp.js','content.js','popup.html','popup.js','popup.css'])fs.copyFileSync(path.resolve(__dirname,'..',file),path.join(extension,file));
  if(process.env.TICKET_BACKGROUND_SOURCE){
    const source=fs.realpathSync(process.env.TICKET_BACKGROUND_SOURCE),data=fs.readFileSync(source);
    fs.writeFileSync(path.join(extension,'background.js'),data);
    report.backgroundSourceOverride={path:source,sha256:require('node:crypto').createHash('sha256').update(data).digest('hex')};
    report.notes.push('Test-only background source variant; exact source and hash are recorded.');
  }
  // Test-only factorial benchmarks may select a saved CDP source without
  // changing the production checkout or adding runtime mode flags.
  if(process.env.TICKET_INPUT_CDP_SOURCE){
    const source=fs.realpathSync(process.env.TICKET_INPUT_CDP_SOURCE),data=fs.readFileSync(source);
    fs.writeFileSync(path.join(extension,'cdp.js'),data);
    report.cdpSourceOverride={path:source,sha256:require('node:crypto').createHash('sha256').update(data).digest('hex')};
    report.notes[0]='Test-only CDP source variant; its exact path and SHA-256 are recorded. Other production runtime files are copied unchanged.';
  }
  if(process.env.TICKET_CONTENT_SOURCE){
    const source=fs.realpathSync(process.env.TICKET_CONTENT_SOURCE),data=fs.readFileSync(source);
    fs.writeFileSync(path.join(extension,'content.js'),data);
    report.contentSourceOverride={path:source,sha256:require('node:crypto').createHash('sha256').update(data).digest('hex')};
    report.notes.push('Test-only content source variant; other runtime files are unchanged.');
  }
  const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../manifest.json'),'utf8'));
  report.version=manifest.version;
  manifest.host_permissions=['http://127.0.0.1/*','http://localhost/*'];
  fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest,null,2));
  profile=createTemporaryProfile('input');
  context=await playwright.chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1000,height:760},
    args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:15000});
  const extensionId=worker.url().split('/')[2];
  report.browser=await worker.evaluate(()=>navigator.userAgent);
  let popup=await context.newPage();popup.on('pageerror',e=>console.log('Popup error: '+e.message));await popup.goto('chrome-extension://'+extensionId+'/popup.html');
  await popup.waitForFunction(()=>document.getElementById('profile').options.length>0);
  const rpc=request=>popup.evaluate(request=>chrome.runtime.sendMessage(request),request);
  async function record(name,fn) {
    if(process.env.TICKET_INPUT_FILTER && name!==process.env.TICKET_INPUT_FILTER)return;
    if(process.env.TICKET_INPUT_PATTERN && !new RegExp(process.env.TICKET_INPUT_PATTERN).test(name))return;
    try { const detail=await fn();report.cases.push({name,pass:true,...detail});console.log('PASS '+name); }
    catch(e){report.cases.push({name,pass:false,error:e.stack});console.log('FAIL '+name+': '+e.message);try{await rpc({action:'stopMacro'});}catch{}}
  }
  async function trial({method='cdp',layout='plain',zoom=1,count=1,steps=1,scenario='',testMode=false}={}) {
    const name=[method,layout,zoom,count,steps,scenario,testMode,report.measurements.length].join('-');
    const trialId=require('node:crypto').randomUUID();
    const page=await context.newPage();await page.goto(base+'/tests/input-lab.html?layout='+layout+'&trial='+trialId);await page.bringToFront();
    const frameLayout=['iframe','cross-frame','cross-shadow','cross-closed','nested-frame','claude-frame'].includes(layout);
    const frame=frameLayout?page.frames().find(frame=>frame!==page.mainFrame()):page.mainFrame();
    if(frameLayout){await page.waitForFunction(()=>!!document.querySelector('iframe'));await page.waitForTimeout(100);}
    if(layout==='nested-frame')await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow!=null);
    if(layout==='nested-frame')for(let i=0;i<100&&page.frames().length<3;i++)await page.waitForTimeout(20);
    const targetFrame=frameLayout?page.frames().find(frame=>frame!==page.mainFrame()&&!/layout=cross-frame/.test(frame.url())):frame;
    await targetFrame.waitForFunction(()=>!!window.inputLab);
    if(['current-position','target-replaced-on-press'].includes(scenario))await targetFrame.evaluate(replace=>{
      const lab=window.inputLab,position=document.createElement('div');position.id='positionTarget';position.textContent='버튼이 아닌 현재 위치';
      Object.assign(position.style,{position:'fixed',left:'300px',top:'100px',width:'140px',height:'60px',background:'#ddeeff',zIndex:'2'});
      document.body.append(position);lab.position=position;lab.data.positionClicks=0;
      if(replace)position.addEventListener('mousedown',()=>lab.target.replaceWith(lab.target.cloneNode(true)));
      position.addEventListener('click',()=>{
        lab.data.positionClicks++;lab.data.changed=true;const done=lab.root.querySelector('#done');done.hidden=false;done.textContent='현재 위치 클릭 확인';
      });
    },scenario==='target-replaced-on-press');
    if(scenario==='partial-cover')await targetFrame.evaluate(()=>{
      const r=window.inputLab.target.getBoundingClientRect(),cover=document.createElement('div');
      Object.assign(cover.style,{position:'fixed',left:r.left+r.width*.45+'px',top:r.top+'px',width:r.width*.55+'px',height:r.height+'px',background:'#888',zIndex:'999'});
      document.body.append(cover);
    });
    if(frameLayout)await page.evaluate(()=>{
      const mount=document.getElementById('mount');Object.assign(mount.style,{position:'absolute',top:'10px',left:'10px',zIndex:'1'});document.querySelector('iframe').style.margin='0';
    });
    if(['complete-on-press','hide-on-press'].includes(scenario))await targetFrame.evaluate(hide=>{
      window.inputLab.target.addEventListener('pointerdown',()=>{
        window.inputLab.data.changed=true;window.inputLab.data.activationToPointerdownMs=performance.now()-window.inputLab.data.activatedAt;
        window.inputLab.target.disabled=true;if(hide)window.inputLab.target.hidden=true;
        window.inputLab.root.querySelector('#result').textContent='예매 반응 완료';
      });
    },scenario==='hide-on-press');
    if(layout==='nested-frame')await page.frames().find(frame=>/layout=cross-frame/.test(frame.url())).evaluate(()=>{
      const mount=document.getElementById('mount');mount.style.position='absolute';mount.style.top='10px';mount.style.left='10px';document.querySelector('iframe').style.margin='0';
    });
    if(scenario==='scaled-frame')await page.evaluate(()=>document.querySelector('iframe').style.transform='scale(0.8)');
    if(scenario==='frame-rotate')await page.evaluate(()=>document.querySelector('iframe').style.transform='rotate(10deg)');
    if(scenario==='frame-cover')await page.evaluate(()=>{const el=document.createElement('div');el.id='cover';document.body.append(el);});
    if(scenario==='frame-scroll')await page.evaluate(()=>{document.body.style.minHeight='3000px';document.getElementById('mount').style.marginTop='700px';});
    if(scenario==='frame-move-on-press'){
      await page.evaluate(()=>window.addEventListener('message',e=>{if(e.data==='lab-move-frame'&&e.source===document.querySelector('iframe').contentWindow)document.querySelector('iframe').style.transform='translateX(100px)';}));
      await targetFrame.evaluate(()=>window.inputLab.target.addEventListener('mousedown',()=>parent.postMessage('lab-move-frame','*')));
    }
    const p=C.newProfile('input-test');p.name='로컬 입력 비교';p.url=page.url();p.frameUrl=frameLayout?new URL(targetFrame.url()).origin:'';
    const shadowLayout=['shadow','closed','cross-shadow','cross-closed'].includes(layout);
    p.scopeSelector=shadowLayout?'#shadow-host >>> #scope':layout==='claude-frame'?'.screen':'#scope';
    p.safetySelectors=['.lab-guard'];Object.assign(p.settings,{clickMethod:method,testMode,count,delaySeconds:.5,maxRuntimeSeconds:10});
    if(scenario==='legacy-js-setting')p.settings.clickMethod='javascript';
    p.steps=[{name:'로컬 버튼',selector:layout==='claude-frame'?'#bookBtn':shadowLayout?'#shadow-host >>> #target':'#target',readySelector:layout==='claude-frame'?'#bookBtn.on':'#target:not(:disabled)',event:layout==='claude-frame'?'pointerdown':'click',timeoutMs:4000,
      verify:{kind:layout==='claude-frame'||steps>1||count>1?'textChanged':'appeared',selector:shadowLayout?'#shadow-host >>> #done':layout==='claude-frame'?'#result':'#done',value:'',timeoutMs:1500}}];
    if(steps>1)p.steps=Array.from({length:steps},()=>C.clone(p.steps[0]));
    if(scenario==='two-minute-timeout'){p.settings.maxRuntimeSeconds=150;p.steps.forEach(step=>step.timeoutMs=120000);}
    const all=(await rpc({action:'getSettings'})).ticketProfiles.filter(profile=>profile.id!=='input-test');all.push(p);
    assert.equal((await rpc({action:'saveProfiles',profiles:all,activeProfileId:p.id})).success,true);
    if(scenario==='legacy-js-setting')await popup.evaluate(()=>chrome.storage.local.set({ticketClickMethod:'javascript'}));
    const tabs=await popup.evaluate(()=>chrome.tabs.query({}));
    const tab=tabs.find(tab=>tab.url===page.url());assert(tab,'lab Chrome tab missing');
    await popup.evaluate(({id,zoom})=>chrome.tabs.setZoom(id,zoom),{id:tab.id,zoom});
    // Exercise a settled zoom setting, including the child renderer.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await targetFrame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    if(scenario==='frame-scroll')await page.evaluate(()=>window.scrollTo(0,700));
    if(layout==='scrolled')await page.evaluate(()=>window.scrollTo(0,1000));
    let preparationTrace;
    if(scenario==='popup-start') {
      await popup.reload();await page.bringToFront();await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
      await worker.evaluate(()=>{
        globalThis.__preparationTrace=[];
        globalThis.__preparationObserver=request=>{if(['captureCurrentTab','validatePreparedStart','saveProfiles','startMacro'].includes(request.action))globalThis.__preparationTrace.push({action:request.action,at:Date.now()});};
        chrome.runtime.onMessage.addListener(globalThis.__preparationObserver);
        globalThis.__originalScript=chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.scripting.executeScript=async request=>{if(request.func?.name==='readButtons')await new Promise(resolve=>setTimeout(resolve,100));return globalThis.__originalScript(request);};
      });
      await popup.evaluate(()=>{
        const original=chrome.permissions.request.bind(chrome.permissions);globalThis.__permissionRequests=0;
        chrome.permissions.request=request=>{globalThis.__permissionRequests++;return original(request);};
      });
      const control=await context.newCDPSession(popup);
      try {
        const previousRun=(await rpc({action:'getStatus'})).run?.id;
        await control.send('Runtime.evaluate',{expression:"document.getElementById('start').click()",userGesture:true});
        let started;
        for(let i=0;i<300;i++) {
          started=await popup.evaluate(async()=>{const {macroRun}=await chrome.storage.local.get('macroRun');return macroRun;});
          if(started?.id!==previousRun&&started?.status==='watching')break;
          if(await popup.locator('#preparationStatus').evaluate(node=>node.classList.contains('error')))break;
          await popup.waitForTimeout(20);
        }
        assert(started?.id!==previousRun&&started?.status==='watching','prepared Start did not enter watching');
        assert.equal(await popup.evaluate(()=>globalThis.__permissionRequests),1);
        preparationTrace=await worker.evaluate(()=>globalThis.__preparationTrace);
        assert.deepEqual(preparationTrace.map(item=>item.action),['captureCurrentTab','validatePreparedStart','saveProfiles','startMacro']);
        assert(started.monitorStartedAt>=preparationTrace.at(-1).at,'activation timer began during collection');
        assert.equal(started.profile.steps[0].timeoutMs,120000);assert.equal(await targetFrame.evaluate(()=>window.inputLab.data.inputs.length),0);
      } catch(error) {
        console.log('PREPARATION DEBUG '+await popup.locator('#preparationStatus').innerText());throw error;
      } finally {
        await control.detach();await worker.evaluate(()=>{chrome.scripting.executeScript=globalThis.__originalScript;chrome.runtime.onMessage.removeListener(globalThis.__preparationObserver);});
      }
    } else {const start=await rpc({action:'startMacro'});assert.equal(start.success,true,start.error);}
    let movePointer;
    if(method==='cdp'){
      await targetFrame.waitForSelector('#ticket-click-pointer-help');
      assert.match(await targetFrame.locator('#ticket-click-pointer-help').innerText(),/예매 버튼에 마우스를 이동/);
      if(report.measurements.length===5)await page.screenshot({path:path.resolve(__dirname,'page-'+manifest.version+'-cdp-guide.png')});
      movePointer=async()=>{
        let point=await targetFrame.evaluate(()=>{const r=(window.inputLab.position||window.inputLab.target).getBoundingClientRect();return {x:r.x+r.width*.3,y:r.y+r.height*.35};});
        for(let child=targetFrame;child.parentFrame();child=child.parentFrame()){
          const owner=await child.frameElement();
          point=await owner.evaluate((frame,p)=>{const r=frame.getBoundingClientRect();return {x:r.x+(frame.clientLeft+p.x)*r.width/frame.offsetWidth,y:r.y+(frame.clientTop+p.y)*r.height/frame.offsetHeight};},point);
          await owner.dispose();
        }
        await page.mouse.move(point.x,point.y);
      };
      if(!['no-pointer','wrong-pointer','synthetic-pointer'].includes(scenario))await movePointer();
      if(scenario==='wrong-pointer')await page.mouse.move(850,620);
      if(scenario==='synthetic-pointer')await targetFrame.evaluate(()=>{const r=window.inputLab.target.getBoundingClientRect();window.inputLab.target.dispatchEvent(new PointerEvent('pointermove',{clientX:r.x+r.width/2,clientY:r.y+r.height/2,pointerType:'mouse',bubbles:true,composed:true}));});
      if(!['frame-cover','frame-rotate','no-pointer','synthetic-pointer'].includes(scenario)){
        try{await targetFrame.waitForFunction(()=>/위치 기록 완료/.test(document.getElementById('ticket-click-pointer-help')?.textContent||''),null,{timeout:3000});}
        catch(error){console.log('POINTER DEBUG '+JSON.stringify({layout,zoom,state:await targetFrame.evaluate(()=>({hover:window.inputLab.target.matches(':hover'),moves:window.inputLab.data.moves,notice:document.getElementById('ticket-click-pointer-help')?.textContent})),run:await popup.evaluate(async()=>{const {macroRun:r}=await chrome.storage.local.get('macroRun');return {message:r?.message,log:r?.logs?.at(-1)};})}));throw error;}
      }
      await targetFrame.evaluate(()=>window.inputLab.data.pointerAtActivation=window.inputLab.data.moves.at(-1));
      if(scenario==='release-still'){
        await page.mouse.down();
        // A held move invalidates the stored point. Up occurs at that same point.
        const last=await targetFrame.evaluate(()=>window.inputLab.data.moves.at(-1));
        let point={x:last.x+2,y:last.y+1};
        for(let child=targetFrame;child.parentFrame();child=child.parentFrame()){
          const owner=await child.frameElement();
          point=await owner.evaluate((frame,p)=>{const r=frame.getBoundingClientRect();return {x:r.x+(frame.clientLeft+p.x)*r.width/frame.offsetWidth,y:r.y+(frame.clientTop+p.y)*r.height/frame.offsetHeight};},point);await owner.dispose();
        }
        await page.mouse.move(point.x,point.y);
        await targetFrame.waitForFunction(()=>/마우스 버튼이 눌린 상태/.test(document.getElementById('ticket-click-pointer-help')?.textContent||''));
        await page.mouse.up();
        await targetFrame.waitForFunction(()=>/위치 기록 완료/.test(document.getElementById('ticket-click-pointer-help')?.textContent||''),null,{timeout:2000});
        await targetFrame.evaluate(()=>{const data=window.inputLab.data;data.events=[];data.inputs=[];data.pointerAtActivation=data.moves.at(-1);});
      }
      if(scenario==='pointer-leave')await page.mouse.move(850,620);
      if(scenario==='scroll-after-pointer')await page.evaluate(()=>{document.getElementById('mount').style.marginTop='1000px';window.scrollTo(0,400);});
      if(['frame-move-before-press','frame-reposition'].includes(scenario))await page.evaluate(()=>document.querySelector('iframe').style.transform='translateX(100px)');
    }
    let closedData;
    let alreadyActivated=false;
    if(scenario==='worker-reload-pressed'||scenario==='port-disconnect-pressed') {
      await worker.evaluate(()=>{
        const original=chrome.debugger.sendCommand.bind(chrome.debugger);
        globalThis.inputLabOriginalCommand=original;
        chrome.debugger.sendCommand=async(...args)=>{
          const result=await original(...args);
          if(args[1]==='Input.dispatchMouseEvent'&&args[2].type==='mousePressed')await new Promise(resolve=>setTimeout(resolve,1000));
          return result;
        };
      });
      await targetFrame.evaluate(()=>window.inputLab.activate());alreadyActivated=true;
      await targetFrame.waitForFunction(()=>window.inputLab.data.events.some(e=>e.type==='mousedown'));
    }
    if(scenario==='worker-reload'||scenario==='worker-reload-pressed') {
      const control=await context.newCDPSession(popup),versions=[];
      control.on('ServiceWorker.workerVersionUpdated',event=>versions.push(...event.versions));
      await control.send('ServiceWorker.enable');
      for(let i=0;i<100&&!versions.some(v=>v.scriptURL===worker.url());i++)await page.waitForTimeout(10);
      const version=versions.find(v=>v.scriptURL===worker.url());assert(version,'extension service worker version missing');
      await control.send('ServiceWorker.stopWorker',{versionId:version.versionId});
      await control.detach();await rpc({action:'getSettings'});
    }
    if(scenario==='port-disconnect'||scenario==='port-disconnect-pressed')await worker.evaluate(()=>{for(const channel of [...documentChannels.values()])channel.close();});
    if(scenario==='tab-close'){closedData=await targetFrame.evaluate(()=>JSON.parse(JSON.stringify(window.inputLab.data)));await page.close();}
    if(scenario==='frame-replaced'){closedData=await targetFrame.evaluate(()=>JSON.parse(JSON.stringify(window.inputLab.data)));await page.evaluate(()=>document.querySelector('iframe').src+='&replacement=1');await page.waitForTimeout(100);}
    if(scenario==='stop')await rpc({action:'stopMacro'});
    if(scenario==='detach')await popup.evaluate(id=>chrome.debugger.detach({tabId:id}),tab.id);
    if(scenario==='navigation')await page.goto(base+'/tests/input-lab.html?layout=plain&trial=navigated');
    if(scenario==='covered')await targetFrame.evaluate(()=>{const el=document.createElement('div');el.id='cover';document.body.append(el);});
    if(!closedData&&!alreadyActivated&&scenario!=='two-minute-timeout')await targetFrame.evaluate(()=>window.inputLab.activate());
    if(scenario==='frame-reposition'){
      await targetFrame.waitForFunction(()=>/예매 버튼에 마우스를 이동/.test(document.getElementById('ticket-click-pointer-help')?.textContent||''));
      assert.equal(await targetFrame.evaluate(()=>window.inputLab.data.events.length),0);
      await movePointer();
    }
    let run,observedAfterMinute=false;
    for(let i=0;i<(scenario==='two-minute-timeout'?150:500);i++){
      run=(await popup.evaluate(()=>chrome.storage.local.get('macroRun'))).macroRun;
      if(run&&!C.isActive(run))break;
      if(scenario==='two-minute-timeout'&&!observedAfterMinute&&Date.now()-run.monitorStartedAt>=61000){
        assert.equal(run.status,'watching');assert.equal(await targetFrame.evaluate(()=>window.inputLab.data.inputs.length),0);
        observedAfterMinute=true;console.log('PASS two-minute wait remains active after 61 seconds');
      }
      await popup.waitForTimeout(scenario==='two-minute-timeout'?1000:15);
    }
    assert(run&&!C.isActive(run),'engine failed to end: '+JSON.stringify(run));
    assert(run.finalDiagnostics,'terminal run has no automatic diagnostics');
    assert.equal(run.finalDiagnostics.status,run.status);assert.equal(run.finalDiagnostics.timing.monitorEndedAt,run.endedAt);
    if(scenario==='port-disconnect-pressed')await targetFrame.waitForFunction(()=>!window.inputLab.target.matches(':active'));
    const data=closedData||await targetFrame.evaluate(()=>({...JSON.parse(JSON.stringify(window.inputLab.data)),targetActive:window.inputLab.target.matches(':active')}));
    const result={...data,testName:name,documentLayout:data.layout,method,layout,zoom,count,steps,scenario,testMode,status:run.status,message:run.message,logs:run.logs,preparationTrace,
      ...(scenario==='two-minute-timeout'?{observedAfterMinute,monitorElapsedMs:run.endedAt-run.monitorStartedAt}:{})};
    if(method==='cdp'&&run.status==='completed'&&!scenario && layout!=='claude-frame'){
      const event=data.events.find(e=>e.type==='pointerdown');assert(event && data.pointerAtActivation);
      assert(Math.abs(event.clientX-data.pointerAtActivation.x)<1 && Math.abs(event.clientY-data.pointerAtActivation.y)<1,'CDP input did not use the user-selected point');
    }
    report.measurements.push(result);
    for(let i=0;i<100;i++){
      const value=await popup.evaluate(()=>chrome.storage.local.get('ticketCdpSession'));
      if(!value.ticketCdpSession)break;
      await popup.waitForTimeout(10);
    }
    if(method==='cdp'&&!testMode){
      const detached=await popup.evaluate(async id=>{try{await chrome.debugger.sendCommand({tabId:id},'Page.getLayoutMetrics',{});return false;}catch{return true;}},tab.id);
      assert(detached,'extension-owned debugger still attached');
    }
    if(scenario==='port-disconnect-pressed')await worker.evaluate(()=>{chrome.debugger.sendCommand=globalThis.inputLabOriginalCommand;});
    if(!page.isClosed())await page.close();return result;
  }
  // JavaScript input is now disabled. Its earlier comparison results remain archived.
  for(const method of ['cdp'])for(let i=0;i<5;i++)await record(method+' plain '+i,async()=>{
    const r=await trial({method});assert.equal(r.status,'completed',r.message);assert.equal(r.clicks,1);assert(r.changed);
    assert.deepEqual(r.events.map(e=>e.type),['pointerdown','mousedown','pointerup','mouseup','click']);
    assert(r.events.every(e=>typeof e.isTrusted==='boolean'));return {latencyMs:r.activationToClickMs};
  });
  const repeat=Number(process.env.TICKET_INPUT_REPEAT||1);
  assert(Number.isInteger(repeat)&&repeat>=1&&repeat<=50,'TICKET_INPUT_REPEAT must be an integer from 1 to 50');
  for(const layout of ['plain','shadow','cross-frame'])for(let index=0;index<repeat;index++)await record('CDP release without moving '+layout+(repeat>1?' '+index:''),async()=>{
    const r=await trial({layout,scenario:'release-still'});assert.equal(r.status,'completed',r.message);assert.equal(r.clicks,1);
    const timing=r.logs.filter(log=>log.event==='click-timing');assert.equal(timing.length,1);assert.equal(timing[0].inputTimingSource,'trusted-pointerdown');
    assert(Number.isFinite(timing[0].activationToPointerdownMs));assert(Number.isFinite(timing[0].activationToClickMs));assert.match(timing[0].message,/ms/);
    assert.equal(r.inputs.filter(e=>e.type==='pointerdown').length,1);
    return {clicks:r.clicks,timing:timing[0]};
  });
  await record('CDP two-minute activation deadline',async()=>{
    const r=await trial({scenario:'two-minute-timeout'});assert.equal(r.status,'timeout');assert.match(r.message,/버튼 대기 시간 초과/);
    assert(r.observedAfterMinute);assert.equal(r.inputs.length,0);assert(r.monitorElapsedMs>=119500&&r.monitorElapsedMs<=130000);
    return {monitorElapsedMs:r.monitorElapsedMs,inputs:r.inputs.length};
  });
  for(const options of [{scenario:'current-position'},{layout:'shadow',scenario:'current-position'},
    {layout:'cross-frame',scenario:'current-position'},{scenario:'target-replaced-on-press'}])await record('CDP position '+JSON.stringify(options),async()=>{
    const r=await trial(options);assert.equal(r.status,'completed',r.message);assert.equal(r.clicks,0);assert.equal(r.positionClicks,1);assert(r.changed);
    const inputs=r.inputs.filter(e=>e.target==='positionTarget');
    assert.deepEqual(inputs.map(e=>e.type),['pointerdown','mousedown','pointerup','mouseup','click']);
    assert(inputs.every(e=>e.isTrusted));const point=r.pointerAtActivation;
    assert(Math.abs(inputs[0].clientX-point.x)<1&&Math.abs(inputs[0].clientY-point.y)<1,'raw-position input coordinates changed');
    return {positionClicks:r.positionClicks,configuredButtonClicks:r.clicks};
  });
  for(const options of [{layout:'shadow'},{layout:'closed'},{layout:'iframe'},{layout:'iframe',scenario:'scaled-frame'},
    {layout:'cross-frame'},{layout:'cross-frame',scenario:'scaled-frame'},{layout:'cross-frame',zoom:1.25},{layout:'cross-frame',zoom:.8},
    {layout:'cross-frame',scenario:'frame-scroll'},{layout:'cross-frame',steps:2},{layout:'cross-frame',count:2},{layout:'cross-shadow'},{layout:'cross-closed'},{layout:'nested-frame'},{layout:'claude-frame'},
    {layout:'claude-frame',scenario:'complete-on-press'},{layout:'claude-frame',scenario:'hide-on-press'},
    {layout:'cross-frame',scenario:'frame-reposition'},{scenario:'partial-cover'},{scenario:'legacy-js-setting'},
    {zoom:1.25},{zoom:.8},{layout:'scrolled'},{steps:2},{count:2}])await record('CDP '+JSON.stringify(options),async()=>{
    const r=await trial(options);assert.equal(r.status,'completed',r.message);assert.equal(r.clicks,options.layout==='claude-frame'?0:options.steps||options.count||1);assert(r.changed);
    if(options.layout==='claude-frame'){
      assert.equal(r.events.filter(e=>e.type==='pointerdown').length,1);assert.equal(r.targetActive,false);
      assert(r.logs.some(log=>/mousePressed 후 완료/.test(log.message)));
    }
  });
  for(const options of [{layout:'cross-frame',scenario:'frame-cover'},{layout:'cross-frame',scenario:'frame-rotate'},
    {layout:'cross-frame',scenario:'frame-move-on-press'},{layout:'cross-frame',scenario:'frame-replaced'},
    {layout:'cross-frame',scenario:'worker-reload-pressed'},{layout:'cross-frame',scenario:'stop'},{layout:'cross-frame',testMode:true},
    {scenario:'no-pointer'},{scenario:'wrong-pointer'},{scenario:'synthetic-pointer'},{scenario:'pointer-leave'},
    {scenario:'scroll-after-pointer'},{layout:'cross-frame',scenario:'frame-move-before-press'},
    {layout:'move-on-press'},{scenario:'covered'},{scenario:'stop'},{scenario:'detach'},{scenario:'navigation'},{scenario:'worker-reload'},{scenario:'worker-reload-pressed'},{scenario:'tab-close'},{testMode:true}])await record('non-completion '+JSON.stringify(options),async()=>{
    const r=await trial(options);assert.notEqual(r.status,'completed');assert.equal(r.clicks,0);
    if(['frame-cover','frame-rotate'].includes(options.scenario))assert(['timeout','error'].includes(r.status));
    if(options.scenario==='frame-move-on-press')assert.match(r.message,/변경/);
    if(['frame-cover','frame-rotate'].includes(options.scenario))assert.equal(r.events.length,0,'input sent before parent iframe validation');
    if(options.layout==='move-on-press')assert.equal(r.inputs.filter(e=>e.type==='pointerdown').length,1);
    if(['wrong-pointer','pointer-leave','covered'].includes(options.scenario)){
      assert.equal(r.inputs.filter(e=>e.type==='pointerdown').length,1,'current-position input was rejected based on the element under the pointer');
      assert.equal(r.inputs.filter(e=>e.type==='click').length,1);
      if(options.scenario==='covered')assert(r.inputs.some(e=>e.type==='click'&&e.target==='cover'));
      else assert(r.inputs.some(e=>e.type==='click'&&e.clientX===850&&e.clientY===620));
    }
    if(options.scenario==='worker-reload-pressed'){assert(r.events.some(e=>e.type==='mousedown'));assert.equal(r.targetActive,false,'mouse press remained held after worker restart');}
    if(options.testMode){assert.equal(r.events.length,0);assert.equal(r.status,'tested',r.message);}
  });
  for(const layout of ['plain','cross-frame'])for(const scenario of ['port-disconnect','port-disconnect-pressed'])await record('CDP document Port '+layout+' '+scenario,async()=>{
    const r=await trial({layout,scenario});assert.equal(r.status,'interrupted');assert.equal(r.clicks,0);assert.equal(r.targetActive,false);
    assert.equal(r.inputs.filter(e=>e.type==='pointerdown').length,scenario==='port-disconnect-pressed'?1:0);
    assert.equal(await worker.evaluate(()=>documentChannels.size),0);return {presses:r.inputs.filter(e=>e.type==='pointerdown').length,clicks:r.clicks};
  });
  await record('URL / button analysis preserved in actual extension',async()=>{
    const page=await context.newPage();await page.goto(base+'/tests/input-lab.html');await page.bringToFront();
    const result=await rpc({action:'analyzeCurrentPage'});assert.equal(result.success,true,result.error);
    assert.equal(result.analysis.url,page.url());assert(result.analysis.buttons.some(b=>b.text==='로컬 예매 버튼'&&b.disabled));
    await page.close();
  });
  // browser.html is the preserved historical JavaScript-engine fixture.
  for(const route of ['analysis-dom.html'])await record('regression '+route,async()=>{
    const page=await context.newPage();await page.goto(base+'/tests/'+route);
    await page.waitForFunction(route=>route==='browser.html'?window.testsDone:window.analysisTestsDone,route,{timeout:120000});
    const results=await page.evaluate(route=>route==='browser.html'?window.testResults:window.analysisTestResults,route);
    assert(results.every(r=>r.pass),JSON.stringify(results.filter(r=>!r.pass)));await page.close();return {passed:results.length};
  });
  await record('Popup uses actual CDP and two-minute wait without advanced controls',async()=>{
    await popup.reload();await popup.waitForFunction(()=>!document.getElementById('start').disabled);
    assert.equal(await popup.isVisible('#cdpHelp'),false);assert.equal(await popup.isVisible('#analyzePage'),false);
    assert.match(await popup.locator('#start').innerText(),/실제 클릭 시작/);
    assert.equal(await popup.locator('#newProfile,#deleteProfile,#profileName,#clickMethod,#pollingMs,#maxRuntime,#testMode,#testContent,#testDevTools,#testInputHelp').count(),0);
    assert(await popup.locator('[data-field="timeoutMs"]').evaluateAll(nodes=>nodes.every(node=>node.value==='120000'&&node.readOnly)));
    await popup.click('#save');await popup.waitForFunction(()=>document.getElementById('saveStatus').textContent.includes('저장했습니다'));
    const saved=(await rpc({action:'getSettings'})).ticketProfiles.find(p=>p.id==='input-test');
    assert.equal(saved.settings.clickMethod,'cdp');assert.equal(saved.settings.testMode,false);assert.equal(saved.settings.count,1);
    assert(saved.steps.every(step=>step.timeoutMs===120000));
    await popup.evaluate(()=>window.scrollTo(0,0));
    await popup.screenshot({path:path.resolve(__dirname,'popup-'+manifest.version+'-cdp.png'),clip:{x:0,y:0,width:480,height:760}});
  });
  await record('Popup auto-saves site selection across reopen',async()=>{
    const before=await rpc({action:'getSettings'});
    for(const id of ['nol-postseason','claude-practice']){
      await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
      await popup.selectOption('#profile',id);
      // Close immediately after the change event; no Save/Start click or success wait.
      await popup.close();popup=await context.newPage();await popup.goto('chrome-extension://'+extensionId+'/popup.html');
      await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
      assert.equal(await popup.locator('#profile').inputValue(),id);
      const saved=await rpc({action:'getSettings'});assert.equal(saved.activeProfileId,id);assert.deepEqual(saved.ticketProfiles,before.ticketProfiles);
      assert.deepEqual(saved.run,before.run,'site selection started or changed the macro');
    }
    // An unfinished draft should not prevent selection persistence or be saved implicitly.
    await popup.fill('#siteUrl','');await popup.selectOption('#profile','nol-postseason');
    await popup.close();popup=await context.newPage();await popup.goto('chrome-extension://'+extensionId+'/popup.html');
    await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
    const final=await rpc({action:'getSettings'});assert.equal(final.activeProfileId,'nol-postseason');assert.deepEqual(final.ticketProfiles,before.ticketProfiles);
    return {reopenedSelections:2,unfinishedDraftDidNotBlock:true,startedMacro:false};
  });
  await record('Popup compact layout and automatic read-only capture',async()=>{
    const page=await context.newPage();await page.goto(base+'/tests/input-lab.html?trial=auto-capture');
    const p=C.newProfile('auto-capture-test');p.name='자동 수집 확인';p.url=page.url();p.scopeSelector='#scope';p.settings.clickMethod='cdp';p.settings.testMode=false;
    p.steps=[{name:'로컬 예매',selector:'#target',readySelector:'#target:not(:disabled)',event:'click',timeoutMs:120000,
      verify:{kind:'appeared',selector:'#done',value:'',timeoutMs:1500}}];
    const settings=await rpc({action:'getSettings'}),all=settings.ticketProfiles.filter(profile=>profile.id!==p.id);all.push(p);
    assert.equal((await rpc({action:'saveProfiles',profiles:all,activeProfileId:p.id})).success,true);
    await worker.evaluate(()=>{
      globalThis.__captureReads=0;const original=chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript=async request=>{if(request.func?.name==='readButtons')globalThis.__captureReads++;return original(request);};
    });
    const storedBefore=await rpc({action:'getSettings'});
    for(let i=1;i<=2;i++){
      await popup.close();popup=await context.newPage();await page.bringToFront();await popup.goto('chrome-extension://'+extensionId+'/popup.html');
      await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
      assert.match(await popup.locator('#capturedSummary').innerText(),/가져온 버튼: 로컬 예매 버튼/);
      assert.equal(await popup.locator('#siteUrl').inputValue(),page.url());
      assert.equal(await worker.evaluate(()=>globalThis.__captureReads),i);
      assert.equal(await page.evaluate(()=>window.inputLab.data.inputs.length),0);
    }
    const options=await popup.locator('#profile option').evaluateAll(nodes=>nodes.map(node=>({id:node.value,label:node.textContent})));
    assert.equal(options[0].id,'nol-postseason');assert.equal(options[0].label,'NOL 티켓 (기본)');
    assert.equal(options.find(option=>option.id==='claude-practice').label,'Claude 예매 반응 (연습)');
    assert(!options.some(option=>option.id==='practicket-n-ticket'));
    assert.equal(await popup.isVisible('.analysis-section'),false);assert.equal(await popup.isVisible('#cdpHelp'),false);
    assert(await popup.evaluate(()=>Boolean(document.querySelector('.log-section').compareDocumentPosition(document.getElementById('advancedConfiguration'))&Node.DOCUMENT_POSITION_FOLLOWING)));
    const storedAfter=await rpc({action:'getSettings'});assert.deepEqual(storedAfter.ticketProfiles,storedBefore.ticketProfiles);assert.deepEqual(storedAfter.run,storedBefore.run);
    await page.goto(base+'/tests/input-lab.html?trial=auto-capture-failure');await page.evaluate(()=>window.inputLab.target.remove());
    await popup.reload();await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
    assert.match(await popup.locator('#preparationStatus').innerText(),/예매 버튼/);
    assert.equal(await popup.locator('#siteUrl').inputValue(),p.url);assert.deepEqual((await rpc({action:'getSettings'})).ticketProfiles,storedBefore.ticketProfiles);
    // A formerly selected hidden profile falls back to NOL without deleting it.
    assert.equal((await rpc({action:'selectProfile',profileId:'practicket-n-ticket'})).success,true);
    await popup.reload();await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
    assert.equal(await popup.locator('#profile').inputValue(),'nol-postseason');
    const fallback=await rpc({action:'getSettings'});assert.equal(fallback.activeProfileId,'nol-postseason');assert(fallback.ticketProfiles.some(profile=>profile.id==='practicket-n-ticket'));
    // A real local disabled-button session keeps both editors locked and skips capture on reopen.
    await rpc({action:'selectProfile',profileId:p.id});await page.evaluate(()=>window.inputLab.root.querySelector('#scope').append(window.inputLab.target));await page.bringToFront();
    const reads=await worker.evaluate(()=>globalThis.__captureReads);
    const start=await rpc({action:'startMacro'});assert.equal(start.success,true,start.error);
    await popup.close();popup=await context.newPage();await page.bringToFront();await popup.goto('chrome-extension://'+extensionId+'/popup.html');
    await popup.waitForFunction(()=>document.getElementById('advancedConfiguration').disabled&&!document.getElementById('stop').disabled);
    assert.equal(await popup.locator('#start').isDisabled(),true);assert.equal(await popup.locator('#stop').isDisabled(),false);
    assert.equal(await worker.evaluate(()=>globalThis.__captureReads),reads);
    await rpc({action:'stopMacro'});await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
    assert.equal(await page.evaluate(()=>window.inputLab.data.inputs.length),0);
    await popup.reload();await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
    await popup.setViewportSize({width:480,height:760});await popup.evaluate(()=>window.scrollTo(0,0));
    await popup.screenshot({path:path.resolve(__dirname,'popup-'+manifest.version+'-compact.png'),fullPage:true});
    await page.close();return {automaticReadsOnOpen:2,pageInputs:0,hiddenProfilePreserved:true,captureFailurePreservedSettings:true};
  });
  for(const layout of ['plain','shadow','closed','cross-frame','claude-frame'])await record('Popup prepared start '+layout,async()=>{
    const result=await trial({layout,scenario:'popup-start'});assert.equal(result.status,'completed',result.message);assert(result.changed);
    assert.equal(result.clicks,layout==='claude-frame'?0:1);return {inputCount:result.inputs.length,preparedBeforeMonitoring:true};
  });
  await record('Popup preparation failure preserves settings and Save does not hide the error',async()=>{
    const page=await context.newPage();await page.goto(base+'/tests/input-lab.html?trial=blocked-start');
    const p=C.newProfile('blocked-start');p.name='실패 보존';p.url=page.url();p.scopeSelector='#scope';p.settings.clickMethod='cdp';p.settings.testMode=false;
    p.steps=[{name:'로컬 예매',selector:'#target',readySelector:'#target:not(:disabled)',event:'click',timeoutMs:120000,verify:{kind:'appeared',selector:'#done',value:'',timeoutMs:1500}}];
    const settings=await rpc({action:'getSettings'});await rpc({action:'saveProfiles',profiles:[...settings.ticketProfiles.filter(item=>item.id!==p.id),p],activeProfileId:p.id});
    await page.bringToFront();await popup.reload();await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
    const before=await rpc({action:'getSettings'});await page.evaluate(()=>window.inputLab.target.remove());
    const control=await context.newCDPSession(popup);
    try {
      await control.send('Runtime.evaluate',{expression:"document.getElementById('start').click()",userGesture:true});
      await popup.waitForFunction(()=>document.getElementById('preparationStatus').classList.contains('error')&&!document.getElementById('start').disabled);
      const error=await popup.locator('#preparationStatus').innerText(),after=await rpc({action:'getSettings'});
      assert.match(error,/예매 버튼/);assert.deepEqual(after.ticketProfiles,before.ticketProfiles);assert.deepEqual(after.run,before.run);
      await popup.evaluate(()=>document.getElementById('save').click());await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
      assert.equal(await popup.locator('#preparationStatus').innerText(),error);assert.match(await popup.locator('#saveStatus').innerText(),/설정을 저장/);
      assert.equal(await page.evaluate(()=>window.inputLab.data.inputs.length),0);
      await popup.screenshot({path:path.resolve(__dirname,'popup-'+manifest.version+'-preparation-error.png'),fullPage:true});
    } finally {await control.detach();await page.close();}
    return {pageInputs:0,settingsPreservedOnFailure:true,errorPreservedOnSave:true};
  });
  for(const replaced of [false,true])await record('Popup candidate selection '+(replaced?'rejects changed document':'starts only after choice'),async()=>{
    const page=await context.newPage();await page.goto(base+'/tests/input-lab.html?trial=candidates');
    const addCandidate=()=>{const second=document.createElement('button');second.id='otherTarget';second.textContent='다른 예매 버튼';second.disabled=true;document.getElementById('scope').append(second);};
    await page.evaluate(addCandidate);
    const p=C.newProfile('candidate-test');p.name='후보 선택';p.url=page.url();p.scopeSelector='#scope';Object.assign(p.settings,{clickMethod:'cdp',testMode:false});
    p.steps=[{name:'선택 대기',selector:'#scope button',readySelector:'#scope button:not(:disabled)',event:'click',timeoutMs:120000,verify:{kind:'appeared',selector:'#done',value:'',timeoutMs:1500}}];
    const settings=await rpc({action:'getSettings'});await rpc({action:'saveProfiles',profiles:[...settings.ticketProfiles.filter(item=>item.id!==p.id),p],activeProfileId:p.id});
    await page.bringToFront();await popup.reload();await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
    const before=await rpc({action:'getSettings'}),control=await context.newCDPSession(popup);
    try {
      await control.send('Runtime.evaluate',{expression:"document.getElementById('start').click()",userGesture:true});
      await popup.waitForFunction(()=>!document.getElementById('configuration').disabled&&!document.getElementById('captureChoices').hidden);
      assert.deepEqual((await rpc({action:'getSettings'})).run,before.run);assert.equal(await popup.locator('#captureChoice option').count(),3);
      if(replaced){await page.reload();await page.evaluate(addCandidate);}
      await popup.evaluate(()=>{document.getElementById('captureChoice').value='1';document.getElementById('applyCapture').click();});
      await popup.waitForFunction(()=>document.getElementById('preparationStatus').classList.contains('error')||!document.getElementById('stop').disabled);
      const after=await rpc({action:'getSettings'});
      if(replaced){assert.match(await popup.locator('#preparationStatus').innerText(),/페이지가 변경/);assert.deepEqual(after.ticketProfiles,before.ticketProfiles);assert.deepEqual(after.run,before.run);}
      else {assert.equal(after.run.status,'watching');assert.equal(after.run.profile.steps[0].selector,'#otherTarget');await rpc({action:'stopMacro'});}
      assert.equal(await page.evaluate(()=>window.inputLab.data.inputs.length),0);
    } finally {await control.detach();await page.close();}
    return {pageInputs:0,replacedDocumentRejected:replaced};
  });
  const httpRecords=await (await fetch(base+'/tests/lab-requests')).json();
  report.httpRecords=httpRecords;
  await record('HTTP requests vs explicit client telemetry',async()=>{
    const gets=httpRecords.filter(r=>r.method==='GET'),posts=httpRecords.filter(r=>r.method==='POST');
    assert(gets.length&&posts.length);assert(gets.every(r=>r.body===''&&!JSON.stringify(r.headers).includes('isTrusted')));
    assert(posts.every(r=>JSON.parse(r.body).events.some(e=>typeof e.isTrusted==='boolean')));
    return {normalGetCount:gets.length,telemetryPostCount:posts.length};
  });
  report.summary={passed:report.cases.filter(c=>c.pass).length,total:report.cases.length};
  for(const method of ['cdp']){
    const values=report.measurements.filter(r=>r.method===method&&r.layout==='plain'&&r.zoom===1&&r.count===1&&r.steps===1&&!r.scenario&&!r.testMode);
    report.summary[method]={trials:values.length,failures:values.filter(r=>r.clicks!==1||!r.changed).length,duplicates:values.filter(r=>r.clicks>1).length,
      latenciesMs:values.map(r=>r.activationToClickMs),eventSamples:values[0]?.events};
  }
  console.log(JSON.stringify(report.summary,null,2));
})().catch(e=>{report.fatal=e.stack;console.error(e);process.exitCode=1;}).finally(async()=>{
  const resultFile=process.env.TICKET_INPUT_REPORT?path.basename(process.env.TICKET_INPUT_REPORT):process.env.TICKET_INPUT_FILTER||process.env.TICKET_INPUT_PATTERN?'startup-focused-results.json':'startup-results.json';
  fs.writeFileSync(path.resolve(__dirname,resultFile),JSON.stringify(report,null,2));
  if(report.fatal||report.cases.some(c=>!c.pass))process.exitCode=1;
  try {await closeTemporaryContext(context,profile);} finally {server.close();}
});

