const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const C=require('../shared.js');

test('performance summary separates observed input from command estimates',()=>{
  const code=fs.readFileSync(require.resolve('../popup.js'),'utf8'),fields={logBox:{replaceChildren(){},append(){}},performance:{}};
  const context=vm.createContext({Date,$:id=>fields[id],document:{createElement:()=>({append(){}}),createTextNode:text=>text}});
  vm.runInContext(code.slice(code.indexOf('function loadLogs('),code.indexOf('async function downloadLog()')),context);
  context.loadLogs([{timestamp:1,event:'click-timing',message:'observed',inputTimingSource:'trusted-pointerdown',clickLatencyMs:8},
    {timestamp:2,event:'click-timing',message:'estimate',inputTimingSource:'cdp-command',clickLatencyMs:100},
    {timestamp:3,event:'click-timing',message:'observed',inputTimingSource:'trusted-pointerdown',clickLatencyMs:6}]);
  assert.match(fields.performance.textContent,/감지→실제 눌림.*최근 6.0ms.*평균 7.0ms.*2건/);
});
test('a busy start leaves Stop available as soon as a run is active',()=>{
  const fields={},$=id=>fields[id] ||= {checked:true};
  const begin=fs.readFileSync(require.resolve('../popup.js'),'utf8').indexOf('function updateButtonState()');
  const code=fs.readFileSync(require.resolve('../popup.js'),'utf8');const end=code.indexOf('async function action(',begin);
  vm.runInNewContext(code.slice(begin,end)+'updateButtonState();',{C,$,run:{status:'starting'},busy:true,pageAnalysis:null});
  assert.equal(fields.stop.disabled,false);assert.equal(fields.start.disabled,true);assert.equal(fields.configuration.disabled,true);
});

// Execute the real URL change listener with field stubs. No browser/API actions.
const source=fs.readFileSync(require.resolve('../popup.js'),'utf8');
const start=source.indexOf("$('siteUrl').addEventListener('change',");
const end=source.indexOf("$('clearLog').addEventListener",start);
assert(start>=0 && end>start,'Popup URL listener not found');
const script=new vm.Script(source.slice(start,end));

test('a failed selection save restores the prior site and keeps the draft',async()=>{
  const profiles=[C.defaultProfile(),C.nolProfile()],fields={profile:{value:'nol-postseason'}},state={filled:[],requests:[],drafts:0};
  let context;
  context=vm.createContext({C,profiles,activeId:'claude-practice',busy:false,run:null,$:id=>fields[id],
    captureDraft:()=>state.drafts++,fillProfile:p=>state.filled.push(p.id),renderProfiles:()=>fields.profile.value=context.activeId,
    showStatus:()=>{},message:async request=>{state.requests.push(request);throw Error('storage failed');},
    action:async fn=>{try{await fn();}catch(error){state.error=error.message;}}});
  vm.runInContext(source.slice(source.indexOf('function selectSite()'),source.indexOf('function permissionRequest(')),context);
  await vm.runInContext('selectSite()',context);
  assert.equal(context.activeId,'claude-practice');assert.equal(fields.profile.value,'claude-practice');assert.equal(state.drafts,1);
  assert.deepEqual(state.filled,['nol-postseason','claude-practice']);assert.equal(state.requests.length,1);assert.equal(state.requests[0].action,'selectProfile');
  assert.match(state.error,/사이트 선택 저장 실패/);
});

test('Popup turns legacy settings into one actual CDP run with a full two-minute wait',()=>{
  const profile=C.defaultProfile();Object.assign(profile.settings,{clickMethod:'javascript',testMode:true,count:0,delaySeconds:7.5,pollingMs:100,maxRuntimeSeconds:1});
  const before=C.clone(profile),step=profile.steps[0];
  const input=(field,value,type='text')=>({dataset:{field},value,type});
  const fields={siteUrl:{value:profile.url},exactSearch:{checked:profile.exactSearch},frameUrl:{value:profile.frameUrl},scope:{value:profile.scopeSelector},
    safety:{value:profile.safetySelectors.join('\n')},mode:{value:'hybrid'},scheduledAt:{value:new Date(Date.now()+60000).toISOString()},prepareSeconds:{value:'60'},
    steps:{children:[{dataset:{},querySelectorAll:()=>[input('name',step.name),input('selector',step.selector),input('readySelector',step.readySelector),input('event',step.event),
      input('timeoutMs',15000,'number'),input('verify.kind',step.verify.kind),input('verify.selector',step.verify.selector),input('verify.value',''),input('verify.timeoutMs',10000,'number')]}]}};
  const context=vm.createContext({C,BUTTON_WAIT_MS:120000,profiles:[profile],activeId:profile.id,scheduledTimeIsDefault:false,captureScheduledEdit:()=>{},
    $:id=>{assert(fields[id],'Removed control was queried: '+id);return fields[id];}});
  vm.runInContext(source.slice(source.indexOf('function readSteps()'),source.indexOf('function clearCapture()')),context);
  vm.runInContext(source.slice(source.indexOf('function readProfile('),source.indexOf('function captureDraft()')),context);
  const result=vm.runInContext('readProfile()',context);
  assert.equal(result.name,profile.name);assert.equal(result.settings.clickMethod,'cdp');assert.equal(result.settings.testMode,false);
  assert.equal(result.settings.count,1);assert.equal(result.steps[0].timeoutMs,120000);
  assert(result.settings.maxRuntimeSeconds>=191,'Short stored runtime truncated preparation, two-minute wait or completion verification');
  assert.equal(result.settings.pollingMs,100);assert.equal(result.settings.delaySeconds,7.5);assert.deepEqual(profile,before);
});
function popup(nextUrl,{exactSearch=false}={}) {
  const profile=C.nolProfile();profile.exactSearch=exactSearch;
  const state={messages:[],renders:[]};
  const fields={siteUrl:{value:nextUrl,addEventListener:(event,fn)=>state.onChange=fn},
    profileHelp:{hidden:false},frameUrl:{value:profile.frameUrl},scope:{value:profile.scopeSelector},
    safety:{value:profile.safetySelectors.join('\n')}};
  const before=C.clone(profile);
  script.runInNewContext({C,profiles:[profile],activeId:profile.id,$:id=>fields[id],
    clearCapture:()=>{},showStatus:message=>state.messages.push(message),renderSteps:steps=>state.renders.push(C.clone(steps))});
  state.onChange();return {profile,before,fields,state};
}
test('changing NOL product URL retains adapter, scope, safety and all step/settings data',()=>{
  const result=popup('https://tickets.interpark.com/gates/ticket/26099999?bc=1');
  assert.deepEqual(result.profile,result.before);assert.equal(result.state.renders.length,0);
  assert.equal(result.fields.scope.value,result.before.scopeSelector);
  assert.equal(result.fields.safety.value,result.before.safetySelectors.join('\n'));
  assert.equal(result.fields.profileHelp.hidden,false);assert.match(result.state.messages[0],/버튼.*날짜·시간/);
});
test('changing NOL query with exact URL matching keeps DOM settings but requires the edited query at run',()=>{
  const next=C.NOL_URL+'&changed=1';const result=popup(next,{exactSearch:true});
  assert.equal(result.state.renders.length,0);assert.deepEqual(result.profile,result.before);
  assert(!C.pageMatches(C.NOL_URL,next,true));
});
test('changing to another route or host clears stale NOL DOM settings',()=>{
  for(const next of ['https://tickets.interpark.com/goods/26099999','https://example.com/gates/ticket/26099999']) {
    const result=popup(next);assert.equal(result.profile.siteAdapter,'');
    assert.equal(result.fields.scope.value,'');assert.equal(result.fields.safety.value,'');
    assert.equal(result.fields.profileHelp.hidden,true);assert.equal(result.state.renders.length,1);
    assert.equal(result.state.renders[0][0].selector,'');assert.match(result.state.messages[0],/기존 DOM 설정을 비웠습니다/);
  }
});

const A=require('../analyze.js');
function analysisPopup({failure=false,copyFailure=false}={}) {
  const source=fs.readFileSync(require.resolve('../popup.js'),'utf8');
  const fields={},state={requests:[],copied:[],statuses:[]};
  const node=()=>({hidden:false,disabled:false,textContent:'',children:[],className:'',
    replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);},
    addEventListener(event,fn){this[event]=fn;}});
  const $=id=>fields[id] ||= node();
  const report={url:'https://example.com/current',capturedAt:Date.now(),buttons:[{text:'<img src=x onerror=alert(1)>',
    frameId:0,frameUrl:'https://example.com/current',path:'#buy',disabled:true,disabledReasons:['native disabled'],inViewport:true,shadow:''}],
    frames:[{frameId:0,url:'https://example.com/current',status:'analyzed'},
      {frameId:2,url:'https://other.example',status:'inaccessible',reason:'권한 거부'}],warnings:['누락 있음'],notes:['DOM 상태 기준'],partial:true};
  const context=vm.createContext({TicketAnalysis:A,pageAnalysis:null,$,document:{createElement:node},
    message:async request=>{state.requests.push(request);if(failure)throw Error('접근 거부');return {analysis:report};},
    action:async fn=>{try{await fn();}catch(e){state.statuses.push(e.message);}},
    navigator:{clipboard:{writeText:async text=>{if(copyFailure)throw Error('복사 거부');state.copied.push(text);}}}});
  const fstart=source.indexOf('function clearAnalysis()'),fend=source.indexOf('function renderProfiles()',fstart);
  vm.runInContext(source.slice(fstart,fend),context);
  const lstart=source.indexOf("$('analyzePage').addEventListener"),lend=source.indexOf("$('captureTab').addEventListener",lstart);
  vm.runInContext(source.slice(lstart,lend),context);
  return {fields,state,report,click:async id=>{await $(id).click();await new Promise(resolve=>setImmediate(resolve));}};
}
test('analysis Popup displays all results/limitations as text without touching a profile',async()=>{
  const p=analysisPopup();await p.click('analyzePage');
  assert.equal(p.fields.analysisUrl.textContent,p.report.url);
  assert.equal(p.fields.analysisButtons.children.length,1);assert.equal(p.fields.analysisFrames.children.length,2);
  assert.match(p.fields.analysisButtons.children[0].children[0].textContent,/<img/);
  assert.match(p.fields.analysisSummary.textContent,/일부 누락/);
  assert.equal(p.state.requests.length,1);assert.equal(p.state.requests[0].action,'analyzeCurrentPage');
  await p.click('copyAnalysis');assert.deepEqual(JSON.parse(p.state.copied[0]),p.report);
});
test('analysis failure clears stale results and prevents copying an older page',async()=>{
  const p=analysisPopup({failure:true});await p.click('analyzePage');await p.click('copyAnalysis');
  assert.equal(p.fields.analysisResult.hidden,true);assert.equal(p.state.copied.length,0);
  assert.match(p.fields.analysisStatus.textContent,/분석 실패.*접근 거부/);
});
test('clipboard rejection is shown to the user',async()=>{
  const p=analysisPopup({copyFailure:true});await p.click('analyzePage');await p.click('copyAnalysis');
  assert.match(p.fields.analysisStatus.textContent,/복사 실패.*복사 거부/);
});
