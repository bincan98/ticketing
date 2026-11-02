/* CDP repeat mode; control operations are serialized by the existing background. */
(()=>{'use strict';
 const Sites=TicketRepeatSites;
 const ACTIVE=['preparing','armed','running','stopping'];let session,preparing=false,saving=Promise.resolve();
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 // Read-only RPCs use the already authenticated document ports. A timeout never retries input.
 function portRequest(s,isShell,action,extra={}){
   const port=isShell?s.shellPort:s.port;
   if(!port)return Promise.reject(Error('문서 연결이 끊겼습니다.'));
   const id=(s.rpcSequence=(s.rpcSequence||0)+1),pending=s.pendingRpc||(s.pendingRpc=new Map());
   return new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>{pending.delete(id);reject(Error('문서 상태 확인 시간 초과 · 재클릭하지 않습니다.'));},1500);
     pending.set(id,{port,resolve,reject,timer});
     try{port.postMessage({kind:'request',runId:s.id,id,action,...extra});}
     catch(e){clearTimeout(timer);pending.delete(id);reject(e);}
   });
 }
 function portReply(s,port,m){
   if(m.kind!=='reply')return false;
   const pending=s.pendingRpc?.get(m.id);
   if(m.runId!==s.id||!pending||pending.port!==port)return true;
   clearTimeout(pending.timer);s.pendingRpc.delete(m.id);
   if(m.error)pending.reject(Error(m.error));else pending.resolve(m.result);
   return true;
 }
 function portClosed(s,port){
   for(const [id,pending]of s.pendingRpc||[]){if(pending.port!==port)continue;clearTimeout(pending.timer);s.pendingRpc.delete(id);pending.reject(Error('문서 연결이 끊겼습니다.'));}
   if(s.site.id==='nol'&&s.status==='running'&&(s.navigationPending||s.context)){s.documentGone=true;return;}
   if(ACTIVE.includes(s.status)){s.stop=true;s.stopReason='문서 연결이 끊겼습니다.';if(s.status==='armed')void finish(s,'interrupted',s.stopReason);}
 }
 const send=async(s,action,extra={})=>{const result=action==='checkpoint'?await portRequest(s,false,action,extra):await chrome.tabs.sendMessage(s.tabId,{repeatPracticeControl:true,runId:s.id,action,...extra},{documentId:s.documentId});if(action==='checkpoint'||action==='finish')updateCounts(s,result);return result;};
 const shell=(s,action,extra={})=>chrome.tabs.sendMessage(s.tabId,{repeatPracticeControl:true,runId:s.id,action,...extra},{documentId:s.topDocumentId});
 function clickMessage(s){if(s.observedPresses>0){if(s.clickPhase==='verifying')return '클릭 시작됨 · 입력 정지 / 결과 확인 중';if(s.clickPhase==='ended')return '클릭 시작됨 · 입력 종료';return '클릭 시작됨 · '+(s.mode==='once'?'1회 입력':'연속 입력 중');}
   if(s.clickPhase==='ended')return '클릭 없이 종료';if(s.countdown)return '클릭 대기 · 시작 카운트다운 중';if(s.status==='running')return s.mode==='once'?'활성화 대기 · 아직 클릭하지 않음':'클릭 시작 준비 중 · 실제 입력 대기';return '클릭 대기 · 아직 입력 없음';}
 function stateFor(s,advance=true){if(advance)s.viewRevision=(s.viewRevision||0)+1;return {runId:s.id,version:chrome.runtime.getManifest().version,siteId:s.site.id,siteName:s.site.name,pageUrl:s.url,maxRunSeconds:s.site.maxRunMs/1000,completionEvent:s.site.event,context:s.context||null,inputConfirmed:!!s.inputConfirmed,countsComplete:!!s.countsComplete,status:s.status,mode:s.mode,message:s.message,attempts:s.attempts||0,requestedIntervalMs:1,perClickChecks:s.mode==='once',guardIntervalMs:s.mode==='once'?null:50,extraClicksAllowed:s.mode!=='once',stopSignal:s.stopSignal?{...s.stopSignal,pressAttemptsAfterReceipt:s.attempts-s.stopSignal.attemptsAtReceipt}:null,clickMessage:clickMessage(s),
   perPairInputCheck:s.mode==='repeat'&&s.site.id==='nol',inputFlagReads:s.inputFlagReads||0,viewRevision:s.viewRevision||0,clickPhase:s.clickPhase||'waiting',observedPresses:s.observedPresses||0,extraPointerdowns:s.extraPointerdowns||0,firstPressAt:s.firstPressAt||null,lastPressAt:s.lastPressAt||null,
   pointerReady:!!s.pointerReady,countdown:!!s.countdown,shortcut:s.shortcut||'',startSource:s.startSource||null,lastShortcutAt:s.lastShortcutAt||null,startSignal:s.startSignal?{...s.startSignal}:null,result:s.result||null,inputEvidence:s.inputEvidence||null,resultSummary:s.resultSummary||null};}
 function save(s){const state=stateFor(s);
   saving=saving.catch(()=>{}).then(async()=>{await chrome.storage.local.set({repeatPracticeState:state});await shell(s,'display',{state}).catch(()=>{});});return saving;
 }
 function progress(s,force=false){if(session!==s||s.status!=='running'||s.finishing||s.stop)return;
   const now=performance.now();if(!force&&now-(s.progressSentAt||0)<250)return;s.progressSentAt=now;
   s.viewRevision=(s.viewRevision||0)+1;
   try{s.shellPort?.postMessage({kind:'progress',state:{runId:s.id,viewRevision:s.viewRevision,status:s.status,clickPhase:s.clickPhase,observedPresses:s.observedPresses||0,clickMessage:clickMessage(s)}});}catch{}
 }
 function updateCounts(s,metrics){if(!Number.isSafeInteger(metrics?.presses)||metrics.presses<0)return;
   const previous=s.observedPresses||0;if(metrics.presses<previous)return;
   s.observedPresses=metrics.presses;s.extraPointerdowns=metrics.extraPointerdowns||0;s.firstPressAt=metrics.firstPressAt||s.firstPressAt||null;s.lastPressAt=metrics.lastPressAt||s.lastPressAt||null;
   if(s.status==='running'&&s.observedPresses&&['starting','waiting'].includes(s.clickPhase))s.clickPhase='clicking';
   if(!previous&&s.observedPresses)progress(s,true);
 }
 async function mapPoint(s,local){
   // Full preflight and independent periodic guard; repeat input does not wait for this per pair.
   const [{tab,win},frames,r]=await Promise.all([
     chrome.tabs.get(s.tabId).then(async tab=>({tab,win:await chrome.windows.get(tab.windowId)})),
     chrome.webNavigation.getAllFrames({tabId:s.tabId}),
     portRequest(s,true,'geometry',{siteId:s.site.id,origin:s.site.frameOrigin,local})
   ]);
   if(!tab.active||!win.focused||tab.url!==s.url||tab.windowId!==s.windowId)throw Error('대상 탭/창이 바뀌었습니다.');
   const current=frames.find(f=>f.documentId===s.documentId);
   if(!current||(s.site.id==='claude'?current.parentFrameId!==0:current.frameId!==0)||current.url!==s.frameUrl||!frames.some(f=>f.frameId===0&&f.documentId===s.topDocumentId))throw Error('대상 문서/프레임이 바뀌었습니다.');
   if(local.x<0||local.y<0||local.x>=r.width||local.y>=r.height)throw Error('지정 위치가 프레임 밖입니다.');
   const point={x:r.left+local.x,y:r.top+local.y};
   if(point.x<0||point.y<0||point.x>=r.viewportWidth||point.y>=r.viewportHeight)throw Error('지정 위치가 화면 밖입니다.');
   if(s.point&&(Math.abs(s.point.x-point.x)>.5||Math.abs(s.point.y-point.y)>.5))throw Error('실행 중 프레임 위치가 바뀌었습니다.');
   return point;
 }
 async function input(s,event){
   let timer;
   try{await Promise.race([
     chrome.debugger.sendCommand({tabId:s.tabId},'Input.dispatchMouseEvent',event),
     new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('CDP 입력 응답 시간 초과 · 눌림을 재전송하지 않습니다.')),1500);})
   ]);}finally{clearTimeout(timer);}
 }
 async function release(s,outside){
   await input(s,{type:'mouseReleased',x:outside?-1:s.point.x,y:outside?-1:s.point.y,button:'left',buttons:0,clickCount:outside?0:1,pointerType:'mouse'});s.down=false;
 }
 function latch(s,source){if(!s.latched){s.latched=true;s.stopSignal={source,receivedAt:Date.now(),attemptsAtReceipt:s.attempts};}}
 function contextOpened(s,detail){
   if(s?.site.id!=='nol'||s.status!=='running'||!s.attempts||s.finishing)return;
   s.context ||= {...detail,observedAt:Date.now()};latch(s,'context-'+detail.kind);
 }
 function startRepeatGuard(s){
   const active=()=>session===s&&s.status==='running'&&!s.stop&&!s.latched&&!s.finishing;
   const check=async()=>{
     if(!active())return;
     try{
       const [state]=await Promise.all([send(s,'checkpoint'),mapPoint(s,s.local)]);
       if(!active())return;
       if(state?.armed||state?.accepted){latch(s,'periodic-guard');return;}
       if(!state?.valid)throw Error('마우스 위치/화면이 유효하지 않습니다.');
     }catch(e){if(active()){s.stop=true;s.stopReason='별도 상태 감시: '+e.message;}}
     finally{if(active())s.guardTimer=setTimeout(check,50);}
   };
   s.guardTimer=setTimeout(check,50);
 }
 async function finish(s,status,message){
   if(s.finishing)return s.finishing;
   s.finishing=(async()=>{s.stop=true;clearTimeout(s.timer);clearTimeout(s.countdownTimer);clearTimeout(s.guardTimer);s.countdown=false;s.pointerReady=false;s.status=status;s.message=message;s.clickPhase='ended';
     if(s.startSignal?.state==='received'){s.startSignal={...s.startSignal,state:'not-started',message:(s.startSignal.trigger==='keyboard'?'단축키는 수신됐지만':'시작 버튼 신호는 받았지만')+' 모드가 실행되지 않았습니다. '+message};}
     if(s.down)await release(s,true).catch(()=>{});
     s.result=await send(s,'finish').catch(()=>null);s.countsComplete=!!s.result;
     s.inputConfirmed ||= !!s.result?.inputConfirmed;
     s.resultSummary=TicketRepeatResults.summarize(s);
     await chrome.debugger.detach({tabId:s.tabId}).catch(()=>{});
     s.port?.disconnect();s.attached=false;
     const {repeatPracticeRecovery:r}=await chrome.storage.local.get('repeatPracticeRecovery');if(r?.runId===s.id)await chrome.storage.local.remove('repeatPracticeRecovery');
     await save(s);s.shellPort?.disconnect();
   })();return s.finishing;
 }
 async function checkPointer(s,m){
   if(session!==s||s.status!=='armed')return;
   s.pointerRevision=m.revision;s.pointerReady=false;s.latestPointer=m;
   if(!m.hover||m.buttons||!m.point){s.message=s.countdown?'시작 대기 · 예매 버튼으로 마우스를 이동하세요.':'연결 완료 · 예매 버튼 위에서 마우스를 움직여 위치를 기록하세요.';await save(s);return;}
   if(!s.countdown)s.message='마우스 위치 확인 중';void save(s);
   if(s.checkingPointer)return;
   s.checkingPointer=true;
   try{
     for(;;){const candidate=s.latestPointer;
       if(s.status!=='armed'||!candidate?.hover||candidate.buttons||!candidate.point)break;
       try{
         await mapPoint(s,candidate.point);
         if(s.status!=='armed')break;
         if(candidate.revision!==s.pointerRevision)continue;
         const ack=await send(s,'pointReady',{revision:candidate.revision,valid:true});
         if(candidate.revision!==s.pointerRevision)continue;
         s.pointerReady=!!ack?.confirmed;s.message=s.pointerReady?'준비 완료 · Ctrl+Shift+Y 또는 페이지의 3초 후 시작':'마우스 위치가 바뀌었습니다. 버튼 위에서 다시 움직여 주세요.';await save(s);break;
       }catch(e){if(candidate.revision!==s.pointerRevision)continue;s.pointerReady=false;s.message='위치 확인 실패: '+e.message;await save(s);break;}
     }
   }finally{s.checkingPointer=false;}
 }
 async function requestStart(s,source){
   if(session!==s||s.status!=='armed'||s.starting)return;
   s.starting=true;s.startSource=source;s.lastShortcutAt=Date.now();
   const trigger=source==='countdown-button'?'button':'keyboard';
   s.startSignal={trigger,source,receivedAt:Date.now(),state:'received',mode:s.mode,
     key:trigger==='keyboard'?(source==='chrome-command'?(s.shortcut||'등록된 단축키'):'Ctrl+Shift+Y'):null,
     message:trigger==='keyboard'?'단축키가 수신되었습니다. 실행 준비를 확인하고 있습니다.':'시작 버튼 신호를 받았습니다. 실행 준비를 확인하고 있습니다.'};
   clearTimeout(s.countdownTimer);s.countdown=false;
   try{
     await save(s);
     const p=await send(s,'pointer');
     if(!p?.point||!p.hover||p.buttons||!p.confirmed||!s.pointerReady){s.message='시작 신호는 받았습니다. 예매 버튼 위에서 마우스를 살짝 움직여 초록색 준비 완료를 확인하세요.';
       s.startSignal={...s.startSignal,state:'not-started',message:(trigger==='keyboard'?'단축키는 수신됐지만':'시작 버튼 신호는 받았지만')+' 모드가 실행되지 않았습니다. 마우스 위치의 초록색 준비 완료를 먼저 확인하세요.'};await save(s);return;}
     await mapPoint(s,p.point);
     if(s.stop||s.status!=='armed')return;
     const begin=await send(s,'begin',{revision:p.revision});
     if(!begin?.ok){s.message=begin?.error||'마우스 준비가 끝나지 않았습니다.';s.startSignal={...s.startSignal,state:'not-started',message:(trigger==='keyboard'?'단축키는 수신됐지만':'시작 버튼 신호는 받았지만')+' 모드가 실행되지 않았습니다. '+s.message};await save(s);return;}
     await run(s,begin.point);
   }catch(e){await finish(s,'error',e.message);}finally{s.starting=false;}
 }
 function countdown(s){
   if(session!==s||s.status!=='armed'||s.countdown||s.starting)return;
   s.countdown=true;let seconds=3;
   const tick=()=>{if(s.stop||s.status!=='armed'){s.countdown=false;return;}
     if(!seconds){void requestStart(s,'countdown-button');return;}
     s.message=seconds+'초 후 시작 · 예매 버튼으로 마우스를 이동하고 초록색 준비 표시를 확인하세요.';void save(s);seconds--;s.countdownTimer=setTimeout(tick,1000);
   };tick();
 }
 async function run(s,local){
   if(session!==s||s.status!=='armed')return;
   s.status='running';s.message='측정 중 · Esc 또는 마우스 이동으로 정지';s.local=local;s.clickPhase=s.mode==='once'?'waiting':'starting';
   try{
     s.point=await mapPoint(s,local);
     // One durable run marker. Restart never resumes or resends input.
     await chrome.storage.local.set({repeatPracticeRecovery:{tabId:s.tabId,runId:s.id,inputPossible:true}});
     if(s.stop)throw Error(s.stopReason||'사용자 정지');
     s.startSignal={...s.startSignal,state:'started',startedAt:Date.now(),
       message:(s.startSignal?.trigger==='keyboard'?'단축키 수신 · ':'버튼 시작 · ')+(s.mode==='once'?'활성화 감지 후 1회 모드':'반복 클릭 모드')+'가 정상적으로 실행되었습니다.'};
     await save(s);
     if(s.mode==='repeat'){
       const initial=await send(s,'checkpoint');
       if(!initial?.valid)throw Error('시작 전 마우스 위치/화면이 유효하지 않습니다.');
       startRepeatGuard(s);
     }
     const started=performance.now();
     for(;;){
       if(s.stop)throw Error(s.stopReason||'사용자 정지');
       if(s.latched)break;
       if(performance.now()-started>s.site.maxRunMs)throw Error(s.site.maxRunMs/1000+'초 실행 제한 시간 초과');
       const cycleStarted=performance.now();
       if(s.mode==='once'){
         const before=await send(s,'checkpoint');
         if(!before?.valid)throw Error('마우스 위치/화면이 유효하지 않습니다.');
         if(before.armed||before.accepted)break;
         if(!before.ready){await sleep(1);continue;}
         await mapPoint(s,local);
       }
       if(s.stop)throw Error(s.stopReason||'사용자 정지');
       if(s.latched)break;
       s.down=true;s.attempts++;
       await input(s,{type:'mousePressed',...s.point,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
       if(s.mode==='once'){
         const after=await send(s,'checkpoint');
         if(after?.armed||after?.accepted||s.latched||s.stop){await release(s,true);if(s.stop)throw Error(s.stopReason||'사용자 정지');break;}
         if(!after?.valid)throw Error('눌림 후 좌표/화면이 바뀌었습니다.');
       }else if(s.latched||s.stop){await release(s,true);if(s.stop)throw Error(s.stopReason||'사용자 정지');break;}
       await release(s,false);
       if(s.mode==='repeat'&&s.site.id==='nol'){
         if(s.stop)throw Error(s.stopReason||'사용자 정지');if(s.latched)break;
         s.inputFlagReads=(s.inputFlagReads||0)+1;
         const flags=await portRequest(s,false,'inputStatus');
         if(typeof flags?.armed!=='boolean'||flags.phase!=='running')throw Error('입력 확인 응답이 유효하지 않습니다. 다시 준비하세요.');
         if(flags.armed){s.inputConfirmed=true;latch(s,'fast-pair-flag');break;}
       }
       if(s.mode==='once'){
         const released=await send(s,'checkpoint');
         if(released?.armed||released?.accepted||s.latched)break;
         if(!released?.valid)throw Error('놓임 후 좌표/화면이 바뀌었습니다.');
         throw Error('1회 입력 후 결과 미확인 · 재클릭하지 않습니다.');
       }
       // NOL waits only for the event flag, without querying DOM/geometry here.
       progress(s);
       const remaining=1-(performance.now()-cycleStarted);
       if(remaining>0)await sleep(remaining);
     }
     clearTimeout(s.guardTimer);
     // No more input is sent once the asynchronous stop signal is received.
     s.clickPhase='verifying';progress(s,true);
     const deadline=Date.now()+s.site.verifyMs;let result;
     do{
       if(s.stop)throw Error(s.stopReason||'사용자 정지');if(s.site.id==='nol'&&s.context)break;
       if(!s.documentGone)result=await send(s,'checkpoint').catch(e=>{if(s.site.id==='nol'&&s.navigationPending)return null;throw e;});
       if(s.site.id==='claude'&&result?.accepted)break;await sleep(10);
     }while(Date.now()<deadline);
     if(s.site.id==='nol')await finish(s,s.context?'handoff':'unconfirmed',s.context?'입력 후 새 창/화면 이동 확인 · 반복 종료 · 이후 절차는 직접 진행하세요.':'입력 중단 · 새 창/화면 이동 미확인 · 자동 재시작하지 않습니다.');
     else await finish(s,result?.accepted?'completed':'unconfirmed',result?.accepted?'사이트 기록 확인 · 반복 종료':'첫 유효 입력 후 정지 · 사이트 결과 미확인 · 재클릭하지 않음');
   }catch(e){
     if(s.site.id==='nol'&&!s.stop&&(s.navigationPending||s.context)){
       if(s.down)await release(s,true).catch(()=>{});
       const deadline=Date.now()+s.site.verifyMs;while(!s.context&&!s.stop&&Date.now()<deadline)await sleep(10);
       await finish(s,s.stop?'stopped':s.context?'handoff':'unconfirmed',s.context?'입력 후 화면 이동 확인 · 반복 종료 · 이후 절차는 직접 진행하세요.':'이동 중 입력 중단 · 결과 미확인 · 자동 재시작하지 않습니다.');
     }else await finish(s,s.stop?'stopped':'error',e.message);
   }
 }
 async function prepare(mode,expected){
   await recovery;
   if(preparing||session&&ACTIVE.includes(session.status))throw Error('이미 준비/실행 중입니다.');
   preparing=true;let s;
   try{
     const {macroRun,ticketCdpSession}=await chrome.storage.local.get(['macroRun','ticketCdpSession']);
     if(ticketCdpSession||macroRun&&C.isActive(macroRun))throw Error('기존 매크로를 먼저 정지하세요.');
     const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
     const site=Sites.forUrl(tab?.url);if(!site)throw Error('Claude 연습 또는 NOL 상품 예매 대기(gates/ticket) 탭에서 준비하세요. 로그인·좌석 선택 화면은 지원하지 않습니다.');
     if(expected&&(tab.id!==expected.tabId||tab.url!==expected.url||site.id!==expected.siteId))throw Error('준비 중 대상 탭/사이트가 바뀌었습니다. 현재 탭에서 다시 준비하세요.');
     const origins=[new URL(tab.url).origin+'/*',...(site.frameOrigin?[site.frameOrigin+'/*']:[])];
     if(!await chrome.permissions.contains({origins}))throw Error('사이트 접근 권한이 없습니다. 반복 입력 준비에서 권한을 허용하세요.');
     const frames=await chrome.webNavigation.getAllFrames({tabId:tab.id}),matches=frames.filter(f=>site.id==='nol'?f.frameId===0:f.parentFrameId===0&&f.url.startsWith(site.frameOrigin+'/'));
     if(matches.length!==1)throw Error('대상 문서/프레임을 확인하지 못했습니다.');
     const top=frames.find(f=>f.frameId===0);s=session={id:crypto.randomUUID(),site,url:tab.url,tabId:tab.id,windowId:tab.windowId,documentId:matches[0].documentId,frameUrl:matches[0].url,topDocumentId:top.documentId,
       frameId:matches[0].frameId,mode:mode==='once'?'once':'repeat',status:'preparing',message:'연결 준비',attempts:0,attached:false,stop:false};await save(s);
     await chrome.debugger.attach({tabId:s.tabId},'1.3');s.attached=true;
     await chrome.storage.local.set({repeatPracticeRecovery:{tabId:s.tabId,runId:s.id,inputPossible:false}});
     await chrome.scripting.executeScript({target:{tabId:s.tabId,documentIds:[s.documentId]},files:['repeat-sites.js','repeat-probe.js']});
     const configured=await chrome.tabs.sendMessage(s.tabId,{repeatPracticeControl:true,runId:s.id,siteId:site.id,documentUrl:s.frameUrl,action:'configure'},{documentId:s.documentId});
     if(!configured?.ready)throw Error(configured?.error||'대상 버튼 준비 실패');
     await chrome.scripting.executeScript({target:{tabId:s.tabId,documentIds:[s.topDocumentId]},files:['repeat-shell.js']});
     await shell(s,'configureShell',{siteId:site.id});
     s.shortcut=(await chrome.commands.getAll()).find(c=>c.name==='repeat-practice-start-v3')?.shortcut||'';
     s.status='armed';s.message='연결 완료 · Popup을 닫고 예매 버튼 위에서 마우스를 살짝 움직여 초록색 준비 완료를 확인하세요.';await save(s);
     s.timer=setTimeout(()=>finish(s,'timeout','준비 후 2분이 지나 종료했습니다.'),120000);
   }catch(e){if(s)await finish(s,'error',e.message);throw e;}finally{preparing=false;}
 }
 chrome.runtime.onConnect.addListener(port=>{
   const isShell=port.name==='ticket-repeat-practice-shell';if(!isShell&&port.name!=='ticket-repeat-practice')return;
   const s=session;if(!s||port.sender?.tab?.id!==s.tabId||port.sender.documentId!==(isShell?s.topDocumentId:s.documentId)){port.disconnect();return;}
   if(isShell){s.shellPort=port;port.onMessage.addListener(m=>{
     if(portReply(s,port,m))return;
     if(m.kind==='startRequest')void requestStart(s,m.source||'outer-key');
     if(m.kind==='countdown')countdown(s);
     if(m.kind==='stop'){s.stop=true;s.stopReason=m.reason;if(s.status==='armed')void finish(s,'stopped',m.reason);}
   });port.onDisconnect.addListener(()=>portClosed(s,port));return;}
   s.port=port;port.onMessage.addListener(m=>{
     if(portReply(s,port,m))return;
     if(m.kind==='startRequest')void requestStart(s,m.source||'iframe-key');
     if(m.kind==='point')void checkPointer(s,m);
     if(m.kind==='latched'){updateCounts(s,m);s.inputEvidence=m.evidence||s.inputEvidence;s.inputConfirmed=true;latch(s,s.site.id==='nol'?'qualified-click':'first-valid-input');}
     if(m.kind==='inputEvidence'&&m.evidence)s.inputEvidence=m.evidence;
     if(m.kind==='accepted')latch(s,'result-observer');
     if(m.kind==='metrics'){updateCounts(s,m);progress(s);}
     if(m.kind==='hint'){s.message=m.message;void save(s);}
     if(m.kind==='stop'){s.stop=true;s.stopReason=m.reason;if(s.status==='armed')void finish(s,'stopped',m.reason);}
   });port.onDisconnect.addListener(()=>portClosed(s,port));
 });
 chrome.commands.onCommand.addListener((command,tab)=>{
   const s=session;if(command==='repeat-practice-start-v3'&&s&&(!tab||tab.id===s.tabId))void requestStart(s,'chrome-command');
 });
 function requestStop(){if(session&&ACTIVE.includes(session.status)){session.stop=true;session.stopReason='사용자 정지';if(session.status==='armed')void finish(session,'stopped','사용자 정지');}}
 async function stop(){requestStop();while(session&&ACTIVE.includes(session.status)&&!session.finishing)await sleep(10);if(session?.finishing)await session.finishing;}
 async function status(){if(session?.finishing)await session.finishing;return session?stateFor(session,false):(await chrome.storage.local.get('repeatPracticeState')).repeatPracticeState||null;}
 async function clearPresentation(){
   if(!session||preparing||ACTIVE.includes(session.status))return;
   const s=session;await Promise.allSettled([...new Set([s.documentId,s.topDocumentId])].map(documentId=>chrome.scripting.executeScript({target:{tabId:s.tabId,documentIds:[documentId]},func:()=>{
     globalThis.__ticketRepeatProbeCleanup?.();globalThis.__ticketRepeatShellCleanup?.();delete globalThis.__ticketRepeatProbeCleanup;delete globalThis.__ticketRepeatShellCleanup;
   }})));
 }
 chrome.debugger.onDetach.addListener(source=>{const s=session;if(s?.tabId===source.tabId&&ACTIVE.includes(s.status)){s.stop=true;s.stopReason='debugger 연결 해제';if(s.status==='armed')void finish(s,'interrupted',s.stopReason);}});
 chrome.tabs.onRemoved.addListener(id=>{const s=session;if(s?.tabId===id){s.stop=true;s.stopReason='대상 탭 종료';if(s.status==='armed')void finish(s,'interrupted',s.stopReason);}});
 function interruptRun(s,reason){if(s&&ACTIVE.includes(s.status)){s.stop=true;s.stopReason=reason;if(s.status==='armed')void finish(s,'interrupted',reason);}}
 function focusChanged(s,reason){if(s.site.id==='nol'&&s.attempts){latch(s,'focus-change');s.contextWaitReason=reason;}else interruptRun(s,reason);}
 chrome.tabs.onCreated.addListener(tab=>{const s=session;if(s&&tab.openerTabId===s.tabId)contextOpened(s,{kind:'new-tab',tabId:tab.id});});
 chrome.tabs.onActivated.addListener(info=>{const s=session;if(s?.status==='running'&&info.windowId===s.windowId&&info.tabId!==s.tabId)focusChanged(s,'활성 탭이 바뀌었습니다.');});
 chrome.windows.onFocusChanged.addListener(id=>{const s=session;if(s?.status==='running'&&id!==s.windowId)focusChanged(s,'대상 창의 포커스가 바뀌었습니다.');});
 chrome.webNavigation.onCommitted.addListener(info=>{const s=session;if(s&&info.tabId===s.tabId&&(info.frameId===0||info.frameId===s.frameId)&&info.documentId!==s.documentId){
   if(s.site.id==='nol'&&s.status==='running'&&s.attempts)contextOpened(s,{kind:'navigation',url:info.url});else interruptRun(s,'대상 문서가 이동했습니다.');
 }});
 chrome.webNavigation.onBeforeNavigate.addListener(info=>{const s=session;if(s?.status==='running'&&info.tabId===s.tabId&&(info.frameId===0||info.frameId===s.frameId)){
   if(s.site.id==='nol'&&s.attempts){s.navigationPending=true;latch(s,'navigation-start');}else interruptRun(s,'대상 문서 이동이 시작됐습니다.');
 }});
 chrome.webNavigation.onHistoryStateUpdated.addListener(info=>{const s=session;if(s?.site.id!=='nol'||s.status!=='running'||info.tabId!==s.tabId||info.frameId!==0||info.url===s.url)return;
   const before=new URL(s.url),after=new URL(info.url);
   if(s.attempts&&(before.origin!==after.origin||before.pathname!==after.pathname))contextOpened(s,{kind:'history-navigation',url:info.url});
   else interruptRun(s,'상품 URL이 바뀌었습니다. 다시 준비하세요.');
 });
 // Recovery cannot resume the loop or repeat a prior press.
 const recovery=chrome.storage.local.get('repeatPracticeRecovery').then(async({repeatPracticeRecovery:r})=>{
   if(!r)return;
   if(r.inputPossible)await chrome.debugger.sendCommand({tabId:r.tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x:-1,y:-1,button:'left',buttons:0,clickCount:0,pointerType:'mouse'}).catch(()=>{});
   await chrome.debugger.detach({tabId:r.tabId}).catch(()=>{});
   const recovered={runId:r.runId,status:'interrupted',clickPhase:'ended',clickMessage:r.inputPossible?'실행 중 재시작 · 마지막 입력 횟수 확인 불가':'클릭 없이 종료',observedPresses:r.inputPossible?null:0,message:'확장 재시작 · 이전 실행을 재개하거나 재클릭하지 않았습니다. 입력 중 재시작된 경우 횟수는 확인할 수 없습니다.'};
   recovered.resultSummary=TicketRepeatResults.summarize(recovered);await chrome.storage.local.set({repeatPracticeState:recovered});
   await chrome.storage.local.remove('repeatPracticeRecovery');
 });
 globalThis.TicketRepeatEngine={prepare,requestStop,stop,status,clearPresentation,isActive:()=>preparing||!!session&&(ACTIVE.includes(session.status)||!!session.finishing&&session.attached),ready:recovery};
})();
