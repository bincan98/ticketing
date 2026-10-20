'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../shared.js'),source=fs.readFileSync(require.resolve('../popup.js'),'utf8');
const section=(begin,end)=>source.slice(source.indexOf(begin),source.indexOf(end,source.indexOf(begin)));
function popup(options={}) {
  const profile=C.defaultProfile();Object.assign(profile.settings,{clickMethod:'cdp',testMode:false});profile.steps[0].timeoutMs=120000;
  const state={events:[],stored:C.clone(profile),draft:C.clone(profile)};
  const fields={},node=()=>({value:'',hidden:true,textContent:'',className:'',replaceChildren(){}}),$=id=>fields[id] ||= node();
  const target={tabId:7,frameId:2,documentId:'doc-2',topDocumentId:'doc-0',topUrl:profile.url};
  const captured={url:profile.url,frameUrl:profile.frameUrl,target,buttons:[{selector:'#bookBtn',scopeSelector:'.screen',text:'새 예매 버튼',disabled:true}]};
  const context=vm.createContext({C,BUTTON_WAIT_MS:120000,profiles:[profile],activeId:profile.id,pendingCapture:null,busy:false,run:null,currentTab:null,tabContextRevision:0,
    scheduledTimeIsDefault:true,$,JSON,Date,document:{createElement:node},
    chrome:{permissions:{contains:async()=>options.hasPermission!==false,request:()=>{state.events.push('permission');return Promise.resolve(options.granted!==false);}}},
    readProfile:()=>C.clone(state.draft),fillProfile:p=>{state.draft=C.clone(p);context.clearCapture();},renderProfiles:()=>{},statusType:()=> 'info',
    message:async request=>{
      state.events.push(request.action);
      if(request.action==='captureCurrentTab') {if(options.captureError)throw Error(options.captureError);return {captured:C.clone(options.captured || captured)};}
      if(request.action==='validatePreparedStart'&&options.validationError)throw Error(options.validationError);
      if(request.action==='saveProfiles')state.stored=C.clone(request.profiles.find(p=>p.id===request.activeProfileId));
      if(request.action==='startMacro') {state.startedWith=request;context.run={status:'watching',message:'감시 시작'};}
      if(request.action==='getTabContext')return {success:true,run:context.run};
      if(request.action==='stopMacro')context.run={...context.run,status:'stopped',message:'사용자 중지'};
      return request.action==='getStatus'?{run:context.run}:{success:true};
    },
    action:(fn,channel)=>{context.busy=true;state.pending=fn().catch(error=>{
      (channel==='preparation'?context.showPreparation:channel==='save'?context.showSaveStatus:context.showStatus)(error.message,'error');
    }).finally(()=>{context.busy=false;});return state.pending;}
  });
  vm.runInContext(section('function showStatus(','function captureScheduledEdit('),context);
  vm.runInContext(section('function clearCapture(','function fillProfile('),context);
  vm.runInContext(section('function permissionRequest(','function loadLogs('),context);
  return {context,state,fields,$,captured,options,flush:async()=>{await state.pending;}};
}
test('first open without permission explains setup without collecting or requesting permission',async()=>{
  const p=popup({hasPermission:false});await p.context.captureWithAccessCheck();
  assert.deepEqual(p.state.events,[]);assert.match(p.$('preparationStatus').textContent,/처음 사용/);assert(!/error/.test(p.$('preparationStatus').className));
});
test('Start alone requests permission synchronously then recaptures, validates, saves and starts',async()=>{
  const p=popup({hasPermission:false});p.context.startWithPreparation();
  assert.deepEqual(p.state.events,['permission']);await p.flush();
  assert.deepEqual(p.state.events,['permission','captureCurrentTab','validatePreparedStart','saveProfiles','startMacro','getStatus']);
  assert.equal(p.state.stored.steps[0].buttonText,'새 예매 버튼');assert.deepEqual(JSON.parse(JSON.stringify(p.state.startedWith.captureTarget)),p.captured.target);
  assert.equal(p.state.stored.settings.testMode,false);assert.equal(p.state.stored.steps[0].timeoutMs,120000);
});
test('denied permission preserves settings and prevents collection, save and start',async()=>{
  const p=popup({granted:false}),before=C.clone(p.state.stored);p.context.startWithPreparation();await p.flush();
  assert.deepEqual(p.state.events,['permission']);assert.deepEqual(p.state.stored,before);assert.match(p.$('preparationStatus').textContent,/허용되지/);
});
for(const kind of ['captureError','validationError'])test(kind+' prevents saving or starting the old configuration',async()=>{
  const p=popup({[kind]:'페이지 확인 실패'}),before=C.clone(p.state.stored);p.context.startWithPreparation();await p.flush();
  assert(!p.state.events.includes('saveProfiles'));assert(!p.state.events.includes('startMacro'));assert.deepEqual(p.state.stored,before);
  assert.match(p.$('preparationStatus').textContent,/페이지 확인 실패/);
});
test('settings Save never requests permission and cannot erase preparation or run errors',async()=>{
  const p=popup();p.context.showPreparation('수집 오류','error');p.context.showStatus('실행 오류','error');
  p.context.saveSettings();await p.flush();assert.deepEqual(p.state.events,['saveProfiles']);
  assert.match(p.$('preparationStatus').textContent,/수집 오류/);assert.equal(p.$('status').textContent,'실행 오류');assert.match(p.$('saveStatus').textContent,/설정을 저장/);
});
test('multiple candidates defer start until a fresh explicit selection',async()=>{
  const p=popup();p.options.captured=C.clone(p.captured);p.options.captured.buttons.push({...p.captured.buttons[0],selector:'#other',text:'다른 버튼'});
  p.context.startWithPreparation();await p.flush();assert(!p.state.events.includes('saveProfiles'));assert(p.context.pendingCapture);
  p.$('captureChoice').value='1';await p.context.applyPendingCapture();
  assert.equal(p.state.stored.steps[0].selector,'#other');assert(p.state.events.includes('startMacro'));assert.equal(p.state.events.filter(e=>e==='captureCurrentTab').length,2);
});
test('a document replaced while choosing candidates prevents any save or start',async()=>{
  const p=popup();p.options.captured=C.clone(p.captured);p.options.captured.buttons.push({...p.captured.buttons[0],selector:'#other'});
  p.context.startWithPreparation();await p.flush();p.options.captured.target.documentId='replaced';p.$('captureChoice').value='0';
  await assert.rejects(p.context.applyPendingCapture(),/페이지가 변경/);assert(!p.state.events.includes('saveProfiles'));assert(!p.state.events.includes('startMacro'));
});
test('manual capture stops the previous run before reading and never starts a replacement run',async()=>{
  const p=popup();p.context.run={id:'old-run',tabId:99,status:'watching',profile:C.defaultProfile()};
  await p.context.manualCaptureCurrentTab();assert.deepEqual(p.state.events,['getTabContext','stopMacro','getStatus','captureCurrentTab']);
  assert.equal(p.context.run.status,'stopped');assert.equal(p.state.startedWith,undefined);assert.equal(p.state.draft.steps[0].buttonText,'새 예매 버튼');
});
test('a tab activation during collection prevents stale settings from being applied',async()=>{
  const p=popup(),original=p.context.message;p.context.message=async request=>{const result=await original(request);p.context.tabContextRevision++;return result;};
  await assert.rejects(p.context.captureCurrentSite(),/활성 탭이 변경/);assert.equal(p.state.draft.steps[0].buttonText,undefined);
});
test('selected NOL countdown survives a text tick, but not a selector change',async()=>{
  for(const changedSelector of [false,true]) {
    const p=popup(),profile=C.nolProfile();Object.assign(profile.settings,{clickMethod:'cdp',testMode:false});
    p.state.draft=C.clone(profile);p.context.profiles=[profile];p.context.activeId=profile.id;
    p.options.captured={url:profile.url,frameUrl:'',target:p.captured.target,buttons:[
      {selector:'#a',scopeSelector:'#a',text:'남은시간 35:45',nolPrimary:true,remainingSeconds:2145,disabled:true},
      {selector:'#b',scopeSelector:'#b',text:'남은시간 35:45',nolPrimary:true,remainingSeconds:2145,disabled:true}]};
    await p.context.captureCurrentSite();p.$('captureChoice').value='0';
    p.options.captured.buttons[0].text='남은시간 35:44';
    if(changedSelector) {
      p.options.captured.buttons[0].selector='#changed';
      await assert.rejects(p.context.applyPendingCapture(),/버튼이 변경/);
    } else {
      await p.context.applyPendingCapture();assert.equal(p.state.draft.steps[0].nolPrimary,true);
      assert.equal(p.state.draft.steps[0].buttonText,'남은시간 35:44');assert.match(p.$('capturedSummary').textContent,/2분보다 깁니다/);
    }
    assert(!p.state.events.includes('startMacro'));
  }
});
test('long NOL countdown warning stays visible after a prepared start without extending the deadline',async()=>{
  const p=popup(),profile=C.nolProfile();Object.assign(profile.settings,{clickMethod:'cdp',testMode:false});profile.steps[0].timeoutMs=120000;
  p.state.draft=profile;p.context.profiles=[profile];p.context.activeId=profile.id;
  p.options.captured={url:profile.url,frameUrl:'',target:p.captured.target,buttons:[{selector:'#a',scopeSelector:'#a',text:'남은시간 35:45',nolPrimary:true,remainingSeconds:2145}]};
  p.context.startWithPreparation();await p.flush();assert.match(p.$('preparationStatus').textContent,/2분보다 깁니다/);
  assert.equal(p.state.stored.steps[0].timeoutMs,120000);assert.equal(p.state.stored.settings.mode,'activation');
});
