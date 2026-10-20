/* Real extension multi-tab tests using local fixture responses at the supplied HTTPS URLs. No live site input. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createTemporaryProfile,closeTemporaryContext}=require('./temporary-profile.cjs');
const {chromium}=require(process.env.TICKET_PLAYWRIGHT_MODULE||'playwright'),C=require('../shared.js');
const urls=['https://tickets.interpark.com/gates/ticket/26014841?bc=61776&pc=21000190&ps=&pass_code=',
  'https://tickets.interpark.com/gates/ticket/P0004869?bc=61776&pc=P1001005&ps=&pass_code='];
const report={createdAt:new Date().toISOString(),fixtureResponses:true,liveBookingInput:false,cases:[]};let context,temporaryProfile;
(async()=>{
  const extension=path.resolve(__dirname,'.extension-under-test');fs.mkdirSync(extension,{recursive:true});
  for(const file of ['background.js','shared.js','capture.js','analyze.js','cdp.js','content.js','popup.html','popup.js','popup.css'])fs.copyFileSync(path.resolve(__dirname,'..',file),path.join(extension,file));
  const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../manifest.json'),'utf8'));report.version=manifest.version;
  manifest.host_permissions=['https://tickets.interpark.com/*'];fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  temporaryProfile=createTemporaryProfile('nol-tabs');
  context=await chromium.launchPersistentContext(temporaryProfile,{channel:'chromium',headless:true,viewport:{width:1000,height:900},
    args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  await context.route('https://tickets.interpark.com/**',async route=>{
    const id=new URL(route.request().url()).pathname.split('/').pop();
    await route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><title>로컬 NOL ${id}</title><button id="book-${id}" class="_primary_2p3w6_7 _disabled_2p3w6_34" disabled><span class="_content_2p3w6_38">${id} 예매하기</span></button><script>globalThis.inputs=[];for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.addEventListener(type,e=>inputs.push({type:e.type,trusted:e.isTrusted}));</script>`});
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),popup=await context.newPage();
  await popup.goto('chrome-extension://'+worker.url().split('/')[2]+'/popup.html');await popup.waitForFunction(()=>!document.getElementById('configuration').disabled);
  const rpc=request=>popup.evaluate(request=>chrome.runtime.sendMessage(request),request);
  const p=C.nolProfile();p.url=urls[0];p.scopeSelector='#book-26014841';Object.assign(p.steps[0],{selector:'#book-26014841',bindButtonText:true});
  Object.assign(p.settings,{clickMethod:'cdp',testMode:false});const initial=await rpc({action:'getSettings'});
  await rpc({action:'saveProfiles',profiles:initial.ticketProfiles.map(item=>item.id===p.id?p:item),activeProfileId:p.id});
  const a=await context.newPage();await a.goto(urls[0]);let b=await context.newPage();await b.goto(urls[1]);
  const note=(name,detail={})=>{report.cases.push({name,pass:true,...detail});console.log('PASS '+name);};
  const idle=()=>popup.waitForFunction(()=>document.getElementById('profile').options.length>0&&!document.getElementById('captureTab').disabled&&document.getElementById('status').textContent!=='설정 불러오는 중…');
  const capture=async page=>{await page.bringToFront();await popup.evaluate(()=>document.getElementById('captureTab').click());await idle();};
  const getRun=async()=>{const {macroRun}=await popup.evaluate(()=>chrome.storage.local.get('macroRun'));return macroRun;};
  const start=async page=>{
    await page.bringToFront();const previous=(await getRun())?.id,control=await context.newCDPSession(popup);
    try {await control.send('Runtime.evaluate',{expression:"document.getElementById('start').click()",userGesture:true});}finally{await control.detach();}
    for(let i=0;i<300;i++){const run=await getRun();if(run?.id!==previous&&run?.status==='watching')return run;await popup.waitForTimeout(20);}
    throw Error('Start failed: '+await popup.locator('#preparationStatus').innerText());
  };
  await b.bringToFront();await popup.reload();await idle();assert.equal(await popup.locator('#siteUrl').inputValue(),urls[1],await popup.locator('#preparationStatus').innerText());
  for(const page of [a,b,a,b]){await capture(page);assert.equal(await popup.locator('#siteUrl').inputValue(),page.url());}
  note('two open numeric/P NOL tabs import their own URLs on every switch');
  const beforeSwitch=await popup.locator('#siteUrl').inputValue();await a.bringToFront();
  await worker.evaluate(()=>{
    globalThis.originalCapture=chrome.scripting.executeScript.bind(chrome.scripting);globalThis.slowCaptureEntered=false;
    chrome.scripting.executeScript=async request=>{if(request.func?.name==='readButtons'){globalThis.slowCaptureEntered=true;await new Promise(resolve=>setTimeout(resolve,500));}return globalThis.originalCapture(request);};
  });
  await popup.evaluate(()=>document.getElementById('captureTab').click());
  for(let i=0;i<100&&!await worker.evaluate(()=>globalThis.slowCaptureEntered);i++)await popup.waitForTimeout(10);
  await b.bringToFront();await idle();assert.equal(await popup.locator('#siteUrl').inputValue(),beforeSwitch);assert.match(await popup.locator('#preparationStatus').innerText(),/활성 탭이 변경/);
  await worker.evaluate(()=>{chrome.scripting.executeScript=globalThis.originalCapture;});note('switch during capture rejects the old tab response');
  await capture(a);const runA=await start(a);assert.equal(runA.topUrl,urls[0]);const tabA=runA.tabId;note('Start binds numeric tab A');
  await b.close();await popup.waitForTimeout(60);assert.equal((await getRun()).status,'watching');note('closing unrelated tab B leaves A watching');
  b=await context.newPage();await b.goto(urls[1]);await b.bringToFront();await popup.reload();await idle();
  assert.equal(await popup.locator('#configuration').evaluate(node=>node.disabled),true);assert.equal(await popup.locator('#captureTab').isDisabled(),false);
  assert.match(await popup.locator('#captureTab').innerText(),/감시 중지/);await capture(b);
  assert.equal((await getRun()).status,'stopped',JSON.stringify(await getRun()));assert.equal(await popup.locator('#siteUrl').inputValue(),urls[1],await popup.locator('#preparationStatus').innerText());
  assert.equal(await a.evaluate(()=>inputs.length),0);assert.equal(await b.evaluate(()=>inputs.length),0);note('capture explicitly stops A then imports B without input or restart');
  const runB=await start(b);assert.equal(runB.topUrl,urls[1]);assert.notEqual(runB.tabId,tabA);await a.close();await popup.waitForTimeout(60);
  assert.equal((await getRun()).id,runB.id);assert.equal((await getRun()).status,'watching');note('closing old tab A cannot stop the new B run');
  assert.equal(await b.evaluate(()=>inputs.length),0);await b.close();
  for(let i=0;i<100&&C.isActive(await getRun());i++)await popup.waitForTimeout(20);
  assert(!C.isActive(await getRun()));assert.equal((await getRun()).tabId,runB.tabId);note('closing the actual B target ends only B');
  const reopened=await context.newPage();await reopened.goto(urls[0]);await reopened.bringToFront();await popup.reload();await idle();
  assert.equal(await popup.locator('#siteUrl').inputValue(),urls[0]);assert.match(await popup.locator('#tabContext').innerText(),/최근 실행한 탭/);
  await popup.screenshot({path:path.resolve(__dirname,'popup-2.2.9-nol-tabs.png'),fullPage:true});note('reopening A imports A while the closed B run is labelled as history');
  report.pageInputs=await reopened.evaluate(()=>inputs.length);assert.equal(report.pageInputs,0);
})().catch(error=>{report.error=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{
  report.summary={passed:report.cases.length,error:report.error||null};fs.writeFileSync(path.resolve(__dirname,path.basename(process.env.TICKET_TABS_REPORT||'nol-tabs-results.json')),JSON.stringify(report,null,2));await closeTemporaryContext(context,temporaryProfile);
});
