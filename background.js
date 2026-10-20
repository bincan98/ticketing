/* DOM detection stays in the document. CDP is the optional final input transport. */
'use strict';
importScripts('shared.js', 'capture.js', 'analyze.js', 'cdp.js');
const C = TicketConfig;
const cdp = new TicketCDP.Controller(chrome, (run, message) => terminal(run, 'interrupted', message), recordCdpInput, sendCdpDocument);
const documentChannels=new Map();
function sendCdpDocument(session,request) {
  const channel=documentChannels.get(session.run.id);
  if(channel?.session===session)return channel.request(request);
  if(session.requiresDocumentPort)throw new Error('CDP 문서 연결이 소실되었습니다. 재전송하지 않습니다.');
  return chrome.tabs.sendMessage(session.run.tabId,request,{documentId:session.run.documentId});
}
chrome.runtime.onConnect?.addListener(port=>{
  if(port.name!=='ticket-cdp-document')return;
  let channel,disposed=false;
  // Port.disconnect() notifies the other end, not this end. Dispose locally
  // as well so normal completion cannot retain routes or pending requests.
  const dispose=()=>{
    if(disposed)return;disposed=true;if(!channel)return;
    const session=channel.session;
    if(documentChannels.get(session.run.id)===channel)documentChannels.delete(session.run.id);
    if(cdp.session===session&&!session.canceled&&!session.closing){cdp.cancel(session.run.id);terminal(session.run,'interrupted','CDP 문서 연결 해제: 입력 재전송 없이 종료합니다.').catch(console.error);}
    for(const item of channel.pending.values()){clearTimeout(item.timer);item.reject(new Error('CDP 문서 연결 해제'));}channel.pending.clear();
  };
  const close=()=>{dispose();try{port.disconnect();}catch{}};
  port.onMessage.addListener(message=>{
    if(disposed)return;
    if(message?.kind==='bind'&&!channel){
      const session=cdp.session,run=session?.run,sender=port.sender;
      if(!run||session.canceled||session.closing||sender?.id!==chrome.runtime.id||sender.tab?.id!==run.tabId||
          sender.frameId!==run.frameId||sender.documentId!==run.documentId||message.runId!==run.id||documentChannels.has(run.id)){close();return;}
      let sequence=0;const pending=new Map();
      channel={session,pending,close,commandSequence:0,commandActive:false,request:request=>new Promise((resolve,reject)=>{
        if(pending.size>=16){reject(new Error('CDP 문서 요청 상한을 초과했습니다.'));return;}
        const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP 문서 응답 시간 초과'));close();},5000);
        pending.set(id,{resolve,reject,timer});
        try{port.postMessage({kind:'request',id,runId:run.id,request});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);close();}
      })};
      documentChannels.set(run.id,channel);session.requiresDocumentPort=true;
      try{port.postMessage({kind:'ready',runId:run.id});}catch{close();}return;
    }
    if(message?.kind==='command'&&channel&&message.runId===channel.session.run.id&&Number.isSafeInteger(message.id)&&message.id>0){
      if(message.id<=channel.commandSequence)return; // Never replay an input request.
      channel.commandSequence=message.id;
      const request=message.request,session=channel.session;
      const respond=result=>{if(!disposed)try{port.postMessage({kind:'command-result',id:message.id,runId:session.run.id,result});}catch{close();}};
      if(channel.commandActive||request?.action!=='cdpClick'||request.runId!==session.run.id||cdp.session!==session||session.canceled||session.closing){respond({success:false,error:'유효하지 않거나 중복된 CDP 클릭 요청입니다.'});return;}
      channel.commandActive=true;
      Promise.resolve().then(()=>{
        const logs=inputCheckpoint(request,session.run.id);
        if(logs)session.promotedCheckpoint=logs;
        return initialize().then(()=>cdp.click(request,port.sender));
      }).then(respond,error=>respond({success:false,error:error.message,waitForPointer:!!error.waitForPointer})).finally(()=>{channel.commandActive=false;});
      return;
    }
    if(message?.kind==='response'&&channel&&message.runId===channel.session.run.id&&Number.isInteger(message.id)){
      const item=channel.pending.get(message.id);if(!item)return;channel.pending.delete(message.id);clearTimeout(item.timer);item.resolve(message.result);
    }
  });
  port.onDisconnect.addListener(dispose);
});
const INITIALIZATION_KEYS = ['ticketProfiles', 'activeProfileId', 'profileSchemaVersion', 'nolPreparationRevision', 'executionDefaultsRevision', 'practicketProfileRevision', 'nolGateProfileRevision', 'nolTicketProfileRevision'];
let cdpRecovery, initialization, stopGeneration = 0;
let operations = Promise.resolve(),inputWrites=Promise.resolve();
function serial(task) {
  const next = operations.then(task, task); operations = next.catch(() => {}); return next;
}
function inputCheckpoint(request,runId) {
  const logs=request.intent?.checkpointLogs;
  if(logs===undefined)return null;
  if(!Array.isArray(logs)||logs.length>500||logs.some(log=>!log||log.runId!==runId||!Number.isFinite(log.timestamp)||typeof log.event!=='string')||JSON.stringify(request.intent).length>65536)
    throw new Error('입력 checkpoint가 현재 실행과 맞지 않습니다.');
  return logs;
}
function recordCdpInput(session, request, marker) {
  // Never queue behind a control operation that may be awaiting this CDP
  // flight. Terminal/stop cancel first and drain only these short writes.
  const task=async()=>{
    const {macroRun}=await chrome.storage.local.get('macroRun');
    if(cdp.session!==session || session.canceled || session.closing || !C.isActive(macroRun) || macroRun.stopRequested ||
        macroRun.status==='stopping' || macroRun.id!==session.run.id || request.runId!==macroRun.id)throw new Error('입력 의도 저장 전에 실행이 중지되거나 변경되었습니다.');
    const intent=request.intent,attempt=intent?.lastAttempt;
    if(!intent || intent.stepIndex!==macroRun.stepIndex || intent.cycle!==macroRun.cycle ||
        attempt?.runId!==macroRun.id || attempt.event!=='click-attempt' || attempt.clickMethod!=='cdp' || attempt.attemptId!==request.attemptId ||
        !Number.isFinite(attempt.timestamp) || !Number.isFinite(attempt.actionableDetectedAt) || !Number.isFinite(attempt.actionableMonotonicMs) ||
        JSON.stringify(intent).length>65536)throw new Error('클릭 준비 정보가 현재 실행과 맞지 않습니다. 확장과 페이지를 새로고침하세요.');
    const checkpoint=inputCheckpoint(request,macroRun.id);
    const {logs,...state}=macroRun;
    await chrome.storage.local.set({macroRun:{...state,status:'verifying',message:String(intent.message||'CDP 입력 준비').slice(0,2000),
      lastAttempt:attempt,lastObservation:intent.lastObservation??state.lastObservation},ticketCdpSession:marker,...(checkpoint?{macroLogs:checkpoint}:{})});
    session.promotedCheckpoint=null;
    if(cdp.session!==session || session.canceled || session.closing){
      const newer=session.controlRun;
      if(newer){
        const {macroRun:current}=await chrome.storage.local.get('macroRun');
        if(current?.id===session.run.id && C.isActive(current) && !current.stopRequested)await chrome.storage.local.set({macroRun:newer,
          ...(Array.isArray(newer.logs)?{macroLogs:newer.logs}:{})});
      }
      throw new Error('입력 의도 저장 중 실행이 중지되었습니다.');
    }
  };
  const next=inputWrites.then(task,task);inputWrites=next.catch(()=>{});return next;
}
function initialize() {
  // Share successful setup for this worker; a failed attempt remains retryable.
  return initialization ||= initializeOnce().catch(error => { initialization = null; throw error; });
}
async function initializeOnce() {
  await (cdpRecovery ||= cdp.recover().catch(error => { cdpRecovery = null; throw error; }));
  const data = await chrome.storage.local.get(INITIALIZATION_KEYS);
  let profiles = data.ticketProfiles;
  const patch = {};
  if (!data.ticketProfiles?.length) {
    profiles = [C.defaultProfile(), C.nolProfile(), C.practicketProfile()];
    Object.assign(patch, {ticketProfiles: profiles, activeProfileId: 'claude-practice', profileSchemaVersion: '2.1.0'});
  } else if (data.profileSchemaVersion !== '2.1.0') {
    profiles = data.ticketProfiles.some(p => p.id === 'nol-postseason') ? data.ticketProfiles : [...data.ticketProfiles, C.nolProfile()];
    Object.assign(patch, {ticketProfiles: profiles, activeProfileId: data.activeProfileId || profiles[0].id, profileSchemaVersion: '2.1.0'});
  }
  if (data.nolPreparationRevision !== '60s-v1') {
    patch.ticketProfiles = profiles.map(profile => {
      if (profile.siteAdapter !== 'nol-postseason' || !C.pageMatches(profile.url, C.NOL_LEGACY_URL) || Number(profile.settings?.prepareSeconds) !== 30) return profile;
      return {...profile, settings: {...profile.settings, prepareSeconds: 60}};
    });
    patch.nolPreparationRevision = '60s-v1';
  }
  if (data.executionDefaultsRevision !== 'activation-v1') {
    patch.ticketProfiles = (patch.ticketProfiles || profiles).map(profile => {
      if (profile.settings?.mode !== 'hybrid' || profile.settings.scheduledAt != null) return profile;
      return {...profile, settings: {...profile.settings, mode: 'activation'}};
    });
    patch.executionDefaultsRevision = 'activation-v1';
  }
  if (data.practicketProfileRevision !== 'intro-v1') {
    const currentProfiles = patch.ticketProfiles || profiles;
    patch.ticketProfiles = currentProfiles.some(profile => profile.id === 'practicket-n-ticket') ? currentProfiles : [...currentProfiles, C.practicketProfile()];
    patch.practicketProfileRevision = 'intro-v1';
  }
  if (data.nolGateProfileRevision !== 'gate-26014670-v1') {
    const previous = [];
    patch.ticketProfiles = (patch.ticketProfiles || profiles).map(profile => {
      if (profile.siteAdapter !== 'nol-postseason' || !C.pageMatches(profile.url, C.NOL_LEGACY_URL)) return profile;
      previous.push(C.clone(profile));
      const gate = C.nolProfile();
      return {...gate, id: profile.id, name: profile.name === 'NOL 포스트시즌' ? gate.name : profile.name,
        settings: {...gate.settings, ...profile.settings}};
    });
    // Retain old selectors/game choices for reference; they never run automatically.
    if (previous.length) patch.nolGatePreviousProfiles = previous;
    patch.nolGateProfileRevision = 'gate-26014670-v1';
  }
  if (data.nolTicketProfileRevision !== 'name-url-v1') {
    patch.ticketProfiles = (patch.ticketProfiles || profiles).map(profile => {
      if ((profile.id !== 'nol-postseason' && profile.siteAdapter !== 'nol-gate') ||
          !['NOL 포스트시즌', 'NOL 포스트시즌 대기 화면'].includes(profile.name)) return profile;
      // Preserve profile identity, edited product URL, selectors and execution settings.
      return {...profile, name: 'NOL 티켓'};
    });
    patch.nolTicketProfileRevision = 'name-url-v1';
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}
function checkpointLogs(data, run) {
  const logs=Array.isArray(run.logs) ? [...run.logs] : (data.macroLogs || []).filter(entry=>entry.runId===run.id);
  const pending=cdp.session?.run.id===run.id?cdp.session.promotedCheckpoint:null;
  if(pending){
    const key=entry=>JSON.stringify([entry.event,entry.timestamp,entry.monotonicMs,entry.cycle,entry.stepIndex]);
    const seen=new Set(logs.map(key));for(const entry of pending)if(!seen.has(key(entry))){logs.push(entry);seen.add(key(entry));}
    logs.sort((a,b)=>a.timestamp-b.timestamp||(a.monotonicMs||0)-(b.monotonicMs||0));
  }
  // The input gate deliberately omits history. Its latest attempt is durable
  // even if the document disappears before the normal final history save.
  const attempt=run.lastAttempt;
  if(attempt?.runId===run.id && !logs.some(entry=>entry.event===attempt.event && entry.timestamp===attempt.timestamp))logs.push(attempt);
  return logs;
}
async function terminal(run, status, message) {
  cdp.cancel(run.id);
  await inputWrites;
  const data = await chrome.storage.local.get(['macroRun','macroLogs']);
  if (data.macroRun?.id !== run.id || !C.isActive(data.macroRun)) return;
  cdp.cancel(run.id);
  const endedAt=Date.now(), observation=data.macroRun.lastObservation;
  const button=observation?.button||{found:null,connected:null,ready:null,text:'',disabled:null,className:'',ariaDisabled:null};
  const pointer=observation?.pointer||{state:'unknown',ready:null,hasPosition:null,x:null,y:null,lastKnownX:null,lastKnownY:null};
  const wait=checkpointLogs(data,data.macroRun).findLast?.(entry=>entry.event==='step-wait');
  const timing={monitorStartedAt:data.macroRun.monitorStartedAt??null,stepStartedAt:data.macroRun.stepStartedAt??null,
    monitorEndedAt:endedAt,monitorElapsedMs:data.macroRun.monitorStartedAt==null?null:Math.max(0,endedAt-data.macroRun.monitorStartedAt),
    gateAt:wait?.gateAt??wait?.gate??null,deadlineAt:wait?.deadlineAt??null};
  const diagnostic={schemaVersion:1,source:'controller-last-observation',liveDomAvailable:false,capturedAt:endedAt,
    observationCapturedAt:observation?.capturedAt??null,status,message,phase:observation?.phase??null,button,pointer,timing,
    unavailableReason:'종료 시 문서 상태를 직접 확인하지 못했습니다. 버튼·마우스 정보는 마지막 관측값이며 없으면 확인 불가입니다.'};
  const diagnosticEntry={timestamp:endedAt,time:new Date(endedAt).toISOString(),type:'info',event:'run-diagnostics',runId:run.id,
    message:'종료 진단 · 현재 DOM 확인 불가 · 마지막 관측값: 버튼 '+(button.ready==null?'확인 불가':button.ready?'활성':'활성 조건 미충족')+' · 마우스 '+pointer.state,
    buttonFound:button.found,buttonConnected:button.connected,buttonReady:button.ready,buttonText:button.text,buttonDisabled:button.disabled,
    buttonClass:button.className,buttonAriaDisabled:button.ariaDisabled,pointerState:pointer.state,pointerReady:pointer.ready,pointerHasPosition:pointer.hasPosition,
    pointerX:pointer.x,pointerY:pointer.y,lastPointerX:pointer.lastKnownX,lastPointerY:pointer.lastKnownY,...timing,
    diagnosticSource:diagnostic.source,observationCapturedAt:diagnostic.observationCapturedAt,diagnosticJson:JSON.stringify(diagnostic)};
  const entry = {timestamp: endedAt, time: new Date(endedAt).toISOString(), type: status === 'error' ? 'error' : 'warning',
    event: 'controller-stop', message, runId: run.id};
  const logs = [...checkpointLogs(data,data.macroRun), diagnosticEntry, entry].slice(-500);
  await chrome.storage.local.set({macroRun: {...data.macroRun, status, message, endedAt, finalDiagnostics:diagnostic, logs}, macroLogs: logs});
  await closeCdp(run.id);
}
async function closeCdp(runId) {
  try { await cdp.end(runId); }
  catch (e) {
    const data = await chrome.storage.local.get(['macroRun','macroLogs']), {macroRun}=data;
    if (macroRun?.id !== runId) return;
    const message = 'CDP 연결 해제 확인 실패: ' + e.message + '. 확장을 다시 로드하기 전에 디버거 상태를 확인하세요.';
    const logs = [...checkpointLogs(data,macroRun), {timestamp:Date.now(),event:'cdp-detach-error',type:'error',runId,message}].slice(-500);
    await chrome.storage.local.set({macroRun:{...macroRun,message,logs},macroLogs:logs});
  } finally {documentChannels.get(runId)?.close();}
}
async function visibleRun(run) {
  if(!run||Array.isArray(run.logs))return run;
  const data=await chrome.storage.local.get('macroLogs');return {...run,logs:checkpointLogs(data,run)};
}
async function reconcile() {
  const {macroRun: run} = await chrome.storage.local.get('macroRun');
  if (!C.isActive(run)) return run;
  // stopMacro cancels input immediately, before its serialized stop task runs.
  // A queued status poll must not misclassify that cancellation as a lost CDP
  // session and overwrite the requested stop with an interruption.
  const stopping=run.stopRequested || cdp.session?.run.id===run.id && cdp.session.userStopRequested;
  try {
    if (!stopping && run.profile.settings.clickMethod === 'cdp' && !run.profile.settings.testMode && !cdp.matches(run)) throw new Error('CDP 세션이 없습니다. 자동 재연결 없이 종료합니다.');
    const tab = await chrome.tabs.get(run.tabId);
    if (!C.pageMatches(tab.url, run.profile.url, run.profile.exactSearch)) throw new Error('실행 탭의 URL이 변경되었습니다.');
    const pong = await cdp.wait(chrome.tabs.sendMessage(run.tabId, {action: 'engineStatus', runId: run.id},
      {documentId: run.documentId}), '페이지 실행 상태 확인');
    if (pong?.runId !== run.id || (!pong.running && C.ACTIVE.includes(pong.status))) throw new Error('페이지 실행기가 없습니다. 자동 재클릭 없이 종료합니다.');
    return (await chrome.storage.local.get('macroRun')).macroRun;
  } catch (e) {
    await terminal(run, stopping ? 'stopped' : 'interrupted', e.message); return (await chrome.storage.local.get('macroRun')).macroRun;
  }
}
async function activeTabInfo() {
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  return tab?.id ? {id:tab.id,url:tab.url || '',title:tab.title || '',windowId:tab.windowId} : null;
}
async function prepareActive(profile) {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const notice = C.nolPageNotice(profile, tab?.url);
  if (notice) throw new Error(notice);
  if (!tab?.id || !C.pageMatches(tab.url, profile.url, profile.exactSearch)) {
    throw new Error('설정한 사이트의 정확한 페이지를 현재 탭에 열어 주세요.');
  }
  if (!(await chrome.permissions.contains({origins: C.permissionsFor(profile)}))) {
    throw new Error('사이트와 iframe 접근 권한이 필요합니다. 실제 클릭 시작에서 접근을 허용하세요.');
  }
  const frames = await chrome.webNavigation.getAllFrames({tabId: tab.id});
  const frame = C.selectFrame(frames || [], profile);
  const results = await chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [frame.frameId]}, files: ['content.js']});
  const injected = results.find(r => r.frameId === frame.frameId);
  if (!injected?.documentId) throw new Error('프레임 문서에 접근하지 못했습니다.');
  return {tabId: tab.id, windowId:tab.windowId, frameId: frame.frameId, documentId: injected.documentId, topUrl:tab.url, topDocumentId:frames.find(f => f.frameId === 0)?.documentId};
}
function assertCapturedTarget(target, expected) {
  const keys = ['tabId','frameId','documentId','topUrl','topDocumentId'];
  if (!expected || !Number.isInteger(expected.tabId) || !Number.isInteger(expected.frameId) ||
      !['documentId','topUrl','topDocumentId'].every(key => typeof expected[key] === 'string' && expected[key])) {
    throw new Error('수집한 페이지 식별 정보가 없습니다. 실제 클릭 시작으로 다시 준비하세요.');
  }
  if (keys.some(key => target[key] !== expected[key])) throw new Error('수집 후 탭·페이지·iframe이 변경되었습니다. 현재 탭에서 실제 클릭 시작을 다시 누르세요.');
}
function profileSignature(profile) {
  // Chrome storage/message dictionaries can return a different property order.
  return JSON.stringify(profile, (key,value) => value && typeof value === 'object' && !Array.isArray(value) ?
    Object.fromEntries(Object.keys(value).sort().map(name=>[name,value[name]])) : value);
}
async function validatePreparedStart(profile, captureTarget) {
  if (C.isActive(await reconcile())) throw new Error('이미 실행 중입니다. 먼저 중지하세요.');
  const p = C.validateForRun(profile), target = await prepareActive(p);
  assertCapturedTarget(target, captureTarget);
  const check = await chrome.tabs.sendMessage(target.tabId, {action:'validateEngine',profile:p}, {documentId:target.documentId});
  if (!check?.success) throw new Error(check?.error || '감시 조건을 검증하지 못했습니다.');
  return {success:true};
}
async function start(generation = stopGeneration, captureTarget, expectedProfile) {
  if (C.isActive(await reconcile())) throw new Error('이미 실행 중입니다. 먼저 중지하세요.');
  const data = await chrome.storage.local.get(['ticketProfiles', 'activeProfileId', 'ticketClickMethod']);
  const profile = C.validateForRun(data.ticketProfiles.find(p => p.id === data.activeProfileId));
  if (expectedProfile && profileSignature(profile) !== profileSignature(C.validateForRun(expectedProfile))) throw new Error('준비 중 저장된 설정이 변경되었습니다. 실제 클릭 시작을 다시 누르세요.');
  const savedMethod = data.ticketClickMethod || profile.settings.clickMethod;
  if (!['javascript','cdp'].includes(savedMethod)) throw new Error('저장된 클릭 실행 방식이 올바르지 않습니다. JavaScript로 자동 전환하지 않습니다.');
  // Legacy JavaScript preferences are readable, but all new sessions use CDP.
  // profile.settings.clickMethod = savedMethod;
  profile.settings.clickMethod = 'cdp';
  if (profile.settings.mode === 'hybrid' && (!profile.settings.scheduledAt || profile.settings.scheduledAt <= Date.now())) {
    throw new Error('하이브리드 실행에는 미래의 예약 시각이 필요합니다.');
  }
  const target = await prepareActive(profile);
  if (captureTarget) assertCapturedTarget(target, captureTarget);
  const check = await chrome.tabs.sendMessage(target.tabId, {action: 'validateEngine', profile}, {documentId: target.documentId});
  if (!check?.success) throw new Error(check?.error || 'Selector를 검증하지 못했습니다.');
  const run = {id: crypto.randomUUID(), ...target, profile, status: 'starting', createdAt: Date.now(),
    stepIndex: 0, cycle: 1, logs: [], message: '페이지 실행기 시작 중'};
  await chrome.storage.local.set({macroRun: run, macroLogs: []});
  try {
    if (generation !== stopGeneration) throw new Error('시작 중 사용자가 중지했습니다.');
    if (profile.settings.clickMethod === 'cdp' && !profile.settings.testMode) await cdp.start(run);
    if (generation !== stopGeneration) throw new Error('시작 중 사용자가 중지했습니다.');
    const response = await chrome.tabs.sendMessage(target.tabId, {action: 'startEngine', run}, {documentId: target.documentId});
    if (!response?.success) throw new Error(response?.error || '페이지 실행기 시작 실패');
  } catch (e) { await terminal(run, generation !== stopGeneration ? 'stopped' : 'error', e.message); throw e; }
  return {success: true};
}
async function stop() {
  cdp.cancel();await inputWrites;
  const {macroRun: run} = await chrome.storage.local.get('macroRun');
  if (!C.isActive(run)) return {success: true};
  cdp.cancel(run.id);
  // Persist cancellation first: even a sleeping or lost frame cannot resume the run.
  await chrome.storage.local.set({macroRun: {...run, status: 'stopping', stopRequested: true, message: '사용자 중지 요청'}});
  try {
    await cdp.wait(chrome.tabs.sendMessage(run.tabId, {action: 'stopEngine', runId: run.id}, {documentId: run.documentId}), '페이지 중지');
  } catch { await terminal(run, 'stopped', '페이지가 없어 중지 상태를 저장했습니다.'); }
  await closeCdp(run.id);
  return {success: true};
}
async function captureCurrentTab(profile) {
  if (C.isActive((await chrome.storage.local.get('macroRun')).macroRun)) throw new Error('실행을 중지한 뒤 가져오세요.');
  if (profile.frameUrl) {
    const frameUrl = C.httpUrl(profile.frameUrl);
    if (frameUrl.pathname !== '/' || frameUrl.search || frameUrl.hash) throw new Error('iframe 설정에는 origin만 입력하세요.');
    profile = {...profile, frameUrl: frameUrl.origin};
  }
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id || !tab.url) throw new Error('예매 사이트 탭에서 확장 프로그램을 다시 열어 주세요.');
  const url = C.httpUrl(tab.url).href;
  const notice = C.nolPageNotice(profile, url);
  if (notice) throw new Error(notice);
  if (!C.capturePageMatches(profile, url)) throw new Error('현재 프로필과 다른 사이트입니다. 예매 대기 화면을 열고 해당 사이트 프로필을 선택하세요.');
  // A previous capture may have narrowed its selectors to a product-specific ID.
  // For another NOL product, rediscover with the already verified NOL adapter;
  // keep manual context constraints and never change the saved profile here.
  if (C.canReuseNolGateSettings(profile,url) && !C.pageMatches(profile.url,url) && profile.steps?.[0]?.bindButtonText &&
      !profile.steps[0].targetText && !profile.steps[0].containerSelector) {
    const gate=C.nolProfile();
    profile={...profile,scopeSelector:gate.scopeSelector,steps:[{...profile.steps[0],selector:gate.steps[0].selector},...profile.steps.slice(1)]};
  }
  const frames = await chrome.webNavigation.getAllFrames({tabId: tab.id}) || [];
  const frameNotice = C.nolPageNotice(profile, frames.find(item=>item.frameId===0)?.url);
  if (frameNotice) throw new Error(frameNotice);
  const frame = C.selectFrame(frames, profile);
  if (!frame) throw new Error('현재 페이지의 클릭 문서를 찾지 못했습니다.');
  if (frame.frameId !== 0 && C.httpUrl(frame.url).origin !== C.httpUrl(url).origin &&
      !(await chrome.permissions.contains({origins: [C.originPattern(frame.url)]}))) {
    throw new Error('iframe 접근 권한이 필요합니다. 실제 클릭 시작에서 접근을 허용하세요.');
  }
  // activeTab supplies temporary access to the user's current main document.
  // This injects a read-only function, never the click engine or a click event.
  const target = {tabId: tab.id, ...(frame.documentId ? {documentIds: [frame.documentId]} : {frameIds: [frame.frameId]})};
  let results;
  try { results = await chrome.scripting.executeScript({target, func: TicketCapture.readButtons, args: [profile]}); }
  catch (e) {
    const moved = await chrome.tabs.get(tab.id).catch(()=>null);
    const movedNotice = C.nolPageNotice(profile, moved?.url);
    if (movedNotice) throw new Error(movedNotice);
    throw new Error(`가져오기 실패: ${e.message}. 예매 탭에서 확장 프로그램을 다시 열어 주세요.`);
  }
  const injection = results.find(item => item.frameId === frame.frameId);
  const result = injection?.result;
  const currentTab = await chrome.tabs.get(tab.id);
  const activeTab = await activeTabInfo();
  if (activeTab?.id !== tab.id) throw new Error('가져오는 동안 활성 탭이 변경되었습니다. 현재 탭에서 다시 가져오세요.');
  const movedNotice = C.nolPageNotice(profile, currentTab.url);
  if (movedNotice) throw new Error(movedNotice);
  if (result?.captureError) throw new Error('가져오기 실패: ' + result.captureError);
  const currentFrame = (await chrome.webNavigation.getAllFrames({tabId: tab.id}) || []).find(item => item.frameId === frame.frameId);
  if (!result || C.httpUrl(currentTab.url).href !== url ||
      !currentFrame || injection.documentId && currentFrame.documentId && injection.documentId !== currentFrame.documentId ||
      frame.frameId === 0 && C.httpUrl(result.documentUrl).href !== url ||
      frame.frameId !== 0 && C.httpUrl(result.documentUrl).origin !== profile.frameUrl) {
    throw new Error('가져오는 동안 페이지가 이동했습니다. 현재 화면에서 다시 가져오세요.');
  }
  if (!Array.isArray(result.buttons) || !result.buttons.length) throw new Error('현재 페이지에 예매 버튼이 없습니다.');
  return {success: true, captured: {url, frameUrl: profile.frameUrl || '', buttons: result.buttons, capturedAt: Date.now(),
    target:{tabId:tab.id,frameId:frame.frameId,documentId:injection.documentId,topUrl:url,topDocumentId:frames.find(item=>item.frameId===0)?.documentId}}};
}

async function analyzeCurrentPage() {
  if (C.isActive((await chrome.storage.local.get('macroRun')).macroRun)) throw new Error('매크로를 중지한 뒤 웹페이지를 분석하세요.');
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id || !tab.url) throw new Error('활성 Chrome 탭의 주소를 읽지 못했습니다. 대상 탭에서 확장 프로그램을 다시 여세요.');
  const analysis = {url: tab.url, tabId: tab.id, capturedAt: Date.now(), buttons: [], frames: [], warnings: [], partial: false,
    notes: ['렌더링된 버튼을 수집합니다. 화면 밖 버튼은 inViewport=false로 구분하며 스크롤·클릭은 하지 않습니다.',
      '활성/비활성은 DOM·ARIA·inert·pointer-events 기준입니다. JavaScript 내부 조건, 임의 CSS 클래스, 다른 요소의 가림, Canvas 내부 버튼은 판정할 수 없습니다.',
      'CSS 가상 요소(::before/::after)·이미지 내부의 글자와 브라우저가 생성하는 기본 input 문구는 DOM 글자로 확인되지 않을 수 있습니다.']};
  let url;
  try { url = C.httpUrl(tab.url); }
  catch {
    analysis.partial = true;
    analysis.frames.push({frameId: 0, url: tab.url, status: 'inaccessible', reason: 'Chrome 내부 페이지·확장 페이지·파일 등 HTTP/HTTPS 이외 주소는 분석을 지원하지 않습니다. 버튼 누락 수는 알 수 없습니다.'});
    return {success: true, analysis};
  }
  let inventory;
  try { inventory = await chrome.webNavigation.getAllFrames({tabId: tab.id}) || []; }
  catch (e) { analysis.warnings.push('iframe 목록 조회 실패: ' + e.message + '. 하위 프레임 누락 여부를 확인할 수 없습니다.'); analysis.partial = true; inventory = []; }
  if (!inventory.some(frame => frame.frameId === 0)) {
    inventory.unshift({frameId: 0, parentFrameId: -1, url: url.href});
    analysis.warnings.push('최상위 문서 정보가 없어 현재 탭에 직접 분석을 시도합니다. 프레임 목록이 불완전할 수 있습니다.'); analysis.partial = true;
  }
  const selected = inventory.slice(0, 50);
  const reads = await Promise.allSettled(selected.map(async frame => {
    const target = {tabId: tab.id, ...(frame.documentId ? {documentIds: [frame.documentId]} : {frameIds: [frame.frameId]})};
    const injected = await chrome.scripting.executeScript({target, world: 'ISOLATED', func: TicketAnalysis.readPage});
    const item = injected.find(value => value.frameId === frame.frameId);
    if (!item?.result || !Array.isArray(item.result.buttons)) throw new Error('문서에서 분석 결과를 받지 못했습니다.');
    return {frame, documentId: item.documentId, result: item.result};
  }));
  const currentTab = await chrome.tabs.get(tab.id);
  if (currentTab.url !== tab.url) throw new Error('분석 중 탭 주소가 바뀌었습니다. 현재 페이지에서 다시 분석하세요.');
  let currentFrames;
  try { currentFrames = await chrome.webNavigation.getAllFrames({tabId: tab.id}) || []; }
  catch (e) { analysis.warnings.push('분석 후 문서 변경 여부 확인 실패: ' + e.message); analysis.partial = true; }
  const records = new Map();
  for (let i = 0; i < selected.length; i++) {
    const frame = selected[i], read = reads[i];
    const record = {frameId: frame.frameId, parentFrameId: frame.parentFrameId, url: frame.url, status: 'inaccessible'};
    if (read.status === 'rejected') {
      record.reason = '프레임 접근 실패: ' + read.reason.message + '. 다른 origin의 미허용 권한, sandbox, Chrome 보호 문서, 로딩/문서 이동 등이 원인일 수 있습니다. 내부 버튼 누락 수는 알 수 없습니다.';
    } else {
      const {result, documentId} = read.value;
      const now = currentFrames?.find(item => item.frameId === frame.frameId);
      if (currentFrames && (!now || documentId && now.documentId && documentId !== now.documentId ||
          frame.documentId && documentId && frame.documentId !== documentId ||
          now.url !== result.documentUrl) || frame.frameId === 0 && result.documentUrl !== tab.url) {
        record.reason = '분석 중 문서가 교체되거나 이동했습니다. 해당 프레임의 오래된 결과를 제외했습니다.';
      } else {
        Object.assign(record, {status: 'analyzed', url: result.documentUrl, documentId, buttonCount: result.buttons.length,
          coverage: result.coverage, warnings: result.warnings, result});
        if (result.truncated || result.warnings?.length) analysis.partial = true;
      }
    }
    records.set(frame.frameId, record);
  }
  // Match an iframe only when the parent's observed URLs make its visibility unambiguous.
  function frameVisibility(record, seen = new Set()) {
    if (record.frameId === 0) return true;
    if (seen.has(record.frameId)) return null; seen.add(record.frameId);
    const parent = records.get(record.parentFrameId);
    if (!parent?.result) return null;
    const outer = frameVisibility(parent, seen);
    if (outer === false) return false;
    const candidates = parent.result.frames.filter(item => item.url === record.url);
    if (candidates.length && candidates.every(item => !item.visible)) return false;
    if (outer === true && candidates.length && candidates.every(item => item.visible)) return true;
    return null;
  }
  for (const record of records.values()) {
    if (record.result) {
      const seenFrameUrls = new Map();
      for (const observed of record.result.frames) {
        const count = (seenFrameUrls.get(observed.url) || 0) + 1;
        seenFrameUrls.set(observed.url, count);
        const known = inventory.filter(frame => frame.parentFrameId === record.frameId && frame.url === observed.url).length;
        if (known < count) {
          analysis.partial = true;
          record.warnings = [...record.warnings, 'DOM에서 확인한 iframe을 프레임 목록과 연결하지 못했습니다: ' + observed.url + '. 로딩·주소 변경·열거 제한 등으로 내부 버튼이 누락될 수 있으며 개수는 알 수 없습니다.'];
        }
      }
      const visibility = frameVisibility(record);
      record.parentVisibility = visibility === null ? 'unknown' : visibility ? 'visible' : 'hidden';
      if (visibility === false) { record.status = 'hidden'; record.reason = '부모 iframe이 화면에 렌더링되지 않아 버튼 목록에서 제외했습니다.'; }
      else {
        if (visibility === null) { analysis.partial = true; record.warnings = [...record.warnings, '부모 iframe의 표시 여부를 URL로 연결할 수 없어 이 문서 내부의 렌더링 상태만 확인했습니다.']; }
        analysis.buttons.push(...record.result.buttons.map(button => ({...button, frameId: record.frameId, frameUrl: record.url})));
      }
    }
    if (record.status === 'inaccessible') analysis.partial = true;
    analysis.frames.push(record);
  }
  for (const record of records.values()) delete record.result;
  for (const frame of inventory.slice(50)) {
    analysis.partial = true;
    analysis.frames.push({frameId: frame.frameId, url: frame.url, status: 'inaccessible', reason: '50개 프레임 분석 상한으로 제외했습니다. 내부 버튼 수는 알 수 없습니다.'});
  }
  if (currentFrames?.some(frame => !inventory.some(before => before.frameId === frame.frameId && before.documentId === frame.documentId && before.url === frame.url))) {
    analysis.partial = true; analysis.warnings.push('분석 중 새로운 프레임이 나타나거나 문서가 바뀌었습니다. 현재 결과에 누락될 수 있으므로 다시 분석하세요.');
  }
  return {success: true, analysis};
}

async function dispatch(request) {
  await initialize();
  if (request.action === 'getSettings') return {success: true, ...await chrome.storage.local.get(['ticketProfiles', 'activeProfileId', 'macroLogs', 'ticketClickMethod']), run: await visibleRun(await reconcile()), currentTab:await activeTabInfo()};
  if (request.action === 'getTabContext') return {success:true,run:await visibleRun(await reconcile()),currentTab:await activeTabInfo()};
  if (request.action === 'setClickMethod') {
    if (C.isActive(await reconcile())) throw new Error('실행을 중지한 뒤 클릭 방식을 변경하세요.');
    if (request.value !== 'cdp') throw new Error('현재 버전은 CDP 클릭만 지원합니다.');
    await chrome.storage.local.set({ticketClickMethod:request.value});
    return {success:true};
  }
  if (request.action === 'getStatus') return {success: true, run: await visibleRun(await reconcile())};
  if (request.action === 'selectProfile') {
    if (C.isActive(await reconcile())) throw new Error('실행을 중지한 뒤 사이트를 변경하세요.');
    const {ticketProfiles} = await chrome.storage.local.get('ticketProfiles');
    if (typeof request.profileId !== 'string' || !ticketProfiles?.some(profile => profile.id === request.profileId)) {
      throw new Error('선택한 사이트가 저장된 목록에 없습니다.');
    }
    // Persist only the selection; an unfinished draft must not block changing sites.
    await chrome.storage.local.set({activeProfileId:request.profileId});
    return {success:true};
  }
  if (request.action === 'saveProfiles') {
    if (C.isActive(await reconcile())) throw new Error('실행을 중지한 뒤 설정을 저장하세요.');
    if (!Array.isArray(request.profiles) || !request.profiles.length || request.profiles.length > 30) throw new Error('프로필은 1~30개입니다.');
    const profiles = request.profiles.map(C.validateProfile);
    if (new Set(profiles.map(p => p.id)).size !== profiles.length || !profiles.some(p => p.id === request.activeProfileId)) throw new Error('프로필 ID가 올바르지 않습니다.');
    await chrome.storage.local.set({ticketProfiles: profiles, activeProfileId: request.activeProfileId,
      ticketClickMethod:'cdp'});
    return {success: true};
  }
  if (request.action === 'validatePreparedStart') return validatePreparedStart(request.profile, request.captureTarget);
  if (request.action === 'startMacro') return start(request.expectedStopGeneration, request.captureTarget, request.expectedProfile);
  if (request.action === 'stopMacro') return stop();
  if (request.action === 'captureCurrentTab') {
    try { return {...await captureCurrentTab(request.profile),currentTab:await activeTabInfo()}; }
    catch(error) { return {success:false,error:error.message,currentTab:await activeTabInfo()}; }
  }
  if (request.action === 'analyzeCurrentPage') return analyzeCurrentPage();
  if (request.action === 'inspectFrames') {
    const p = request.profile;
    C.httpUrl(p.url);
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !C.pageMatches(tab.url, p.url, p.exactSearch)) throw new Error('설정한 URL을 현재 탭에 열어 주세요.');
    const frames = await chrome.webNavigation.getAllFrames({tabId: tab.id}) || [];
    let report;
    try {
      C.validateProfile(p);
      const target = await prepareActive(p);
      report = await chrome.tabs.sendMessage(target.tabId, {action: 'inspectEngine', profile: p}, {documentId: target.documentId});
    } catch (e) { report = {error: e.message, note: '프레임 목록에서 실제 origin을 확인하고 F12로 Selector를 입력하세요.'}; }
    return {success: true, frames: frames.map(f => ({frameId: f.frameId, url: f.url})), report};
  }
  if (request.action === 'clearLogs') {
    if (C.isActive(await reconcile())) throw new Error('실행 중에는 로그를 삭제할 수 없습니다.');
    const {macroRun} = await chrome.storage.local.get('macroRun');
    await chrome.storage.local.set({macroLogs: [], ...(macroRun ? {macroRun: {...macroRun, logs: []}} : {})});
    return {success: true};
  }
  throw new Error('지원하지 않는 요청입니다.');
}
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  const extensionPage = sender.url?.startsWith('chrome-extension://' + chrome.runtime.id + '/');
  if (sender.id === chrome.runtime.id && sender.tab && !extensionPage && ['cdpClick','cdpPointerAnchor','engineEnded'].includes(request.action)) {
    // CDP requests cannot block the serial stop/navigation/control queue.
    if (['cdpClick','cdpPointerAnchor'].includes(request.action)) {
      initialize().then(() => request.action==='cdpClick'?cdp.click(request,sender):cdp.anchor(request,sender)).then(respond, e => respond({success:false,error:e.message,waitForPointer:!!e.waitForPointer}));
    } else {
      initialize().then(async () => {
        const session = cdp.session;
        if (session && session.run.id === request.runId && sender.tab.id === session.run.tabId && sender.documentId === session.run.documentId) await closeCdp(request.runId);
        respond({success:!session || session.run.id === request.runId});
      }, e => respond({success:false,error:e.message}));
    }
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.tab && !extensionPage) return false;
  if (request.action === 'stopMacro') { stopGeneration++;if(cdp.session)cdp.session.userStopRequested=true;cdp.cancel(); }
  const queued = request.action === 'startMacro' ? {...request,expectedStopGeneration:stopGeneration} : request;
  serial(() => dispatch(queued)).then(respond, e => respond({success: false, error: e.message}));
  return true;
});
chrome.windows?.onFocusChanged?.addListener(windowId => {
  const session=cdp.session;
  if(session && !session.closing)chrome.tabs.sendMessage(session.run.tabId,
    {action:'invalidateCdpPointer',runId:session.run.id,reason:'window-focus-changed',detail:`Chrome 포커스 변경 (windowId=${windowId})`},{documentId:session.run.documentId}).catch(()=>{});
});
chrome.tabs.onActivated?.addListener(info => {
  const session=cdp.session;
  if(session && info.tabId!==session.run.tabId)chrome.tabs.sendMessage(session.run.tabId,
    {action:'invalidateCdpPointer',runId:session.run.id,reason:'tab-changed',detail:`다른 탭 활성화 (tabId=${info.tabId})`},{documentId:session.run.documentId}).catch(()=>{});
});
chrome.storage.onChanged?.addListener((changes, area) => {
  // Removing stored setup (for example storage.clear()) requires fresh defaults.
  if (area === 'local' && INITIALIZATION_KEYS.some(key => changes[key] && changes[key].newValue === undefined)) initialization = null;
  const run = changes.macroRun?.newValue, session = cdp.session;
  if (area !== 'local' || !changes.macroRun || !session) return;
  if (run?.id !== session.run.id || run.stopRequested || !C.isActive(run)) {
    session.controlRun=run;
    cdp.cancel(session.run.id); closeCdp(session.run.id).catch(console.error);
  }
});
chrome.runtime.onInstalled.addListener(() => { serial(initialize).catch(console.error); });
chrome.runtime.onStartup.addListener(() => {
  serial(async () => { await initialize(); const {macroRun} = await chrome.storage.local.get('macroRun');
    if (C.isActive(macroRun)) await terminal(macroRun, 'interrupted', 'Chrome 재시작: 자동 재실행 없이 종료');
  }).catch(console.error);
});
chrome.tabs.onRemoved.addListener(tabId => { serial(async () => {
  const {macroRun} = await chrome.storage.local.get('macroRun');
  if (macroRun?.tabId === tabId) await terminal(macroRun, 'interrupted', `감시 대상 탭 #${tabId}이 닫혀 실행을 종료했습니다. 현재 탭을 가져온 뒤 다시 시작하세요.`);
}).catch(console.error); });
chrome.tabs.onCreated.addListener(tab => { serial(async () => {
  const {macroRun: run} = await chrome.storage.local.get('macroRun');
  if (!C.isActive(run) || tab.openerTabId !== run.tabId || tab.id === run.tabId ||
      !run.profile.steps.some(step => step.verify.kind === 'newContext')) return;
  if (run.profile.settings.clickMethod === 'cdp' && !cdp.session?.inputStartedAt) return;
  // Confirmation happens after the local click, never on the detection/click path.
  // The document engine accepts this only while verifying its claimed attempt.
  try {
    await chrome.tabs.sendMessage(run.tabId, {action: 'contextOpened', runId: run.id, tabId: tab.id}, {documentId: run.documentId});
  } catch { /* Missing source document is handled by navigation/removal reconciliation. */ }
}).catch(console.error); });
chrome.webNavigation.onCommitted.addListener(details => { serial(async () => {
  const {macroRun: run} = await chrome.storage.local.get('macroRun');
  if (C.isActive(run) && details.tabId === run.tabId && (details.frameId === 0 || details.frameId === run.frameId) && details.documentId !== run.documentId) {
    const contextAfterClick = run.profile.steps[run.stepIndex]?.verify.kind === 'newContext' && run.lastAttempt?.event === 'click-attempt' &&
      (run.profile.settings.clickMethod !== 'cdp' || !!cdp.session?.inputStartedAt);
    await terminal(run, contextAfterClick ? 'handoff' : 'interrupted', contextAfterClick ?
      '클릭 후 화면 이동을 확인했습니다. 이후 예매 절차는 직접 진행하세요.' : '페이지/iframe 이동: 완료를 확인할 수 없어 종료했습니다.');
  }
}).catch(console.error); });
