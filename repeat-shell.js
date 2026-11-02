/* The status and keyboard bridge live in the outer Claude document. */
(()=>{'use strict';try{globalThis.__ticketRepeatShellCleanup?.();}catch{}document.getElementById('ticket-repeat-practice-banner')?.remove();let config,port,lastRevision=-1,lastSignal='';
 const numberFormat=new Intl.NumberFormat('ko-KR'),timeFormat=new Intl.DateTimeFormat('ko-KR',{hour12:false,timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit'});
 const text=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
 const data=(node,key,value)=>{if(node.dataset[key]!==value)node.dataset[key]=value;};
 const host=document.createElement('div');host.id='ticket-repeat-practice-banner';
 host.style.cssText='position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;width:330px!important;pointer-events:auto!important;';
 const shadow=host.attachShadow({mode:'open'});
 const style=document.createElement('style');style.textContent=':host{all:initial}section{background:#172033;color:white;border:3px solid #e8b849;border-radius:12px;padding:12px;font:14px/1.5 system-ui;box-shadow:0 3px 14px #0005}section[data-tone=ready]{border-color:#36cf80}section[data-tone=running]{border-color:#66baff}section[data-tone=error]{border-color:#ff7777}strong{display:block;font-size:15px}p{margin:4px 0 8px}button{font:13px system-ui;padding:6px 10px;margin-right:7px;cursor:pointer}button:disabled{cursor:default;opacity:.55}small{display:block;color:#ccd5e4;margin-top:7px}';
 const box=document.createElement('section');box.dataset.tone='waiting';box.setAttribute('role','status');box.setAttribute('aria-live','polite');
 const title=document.createElement('strong'),message=document.createElement('p'),receipt=document.createElement('p'),clickStatus=document.createElement('p'),clickCount=document.createElement('p'),resultSummary=document.createElement('p'),start=document.createElement('button'),stop=document.createElement('button'),hint=document.createElement('small');
 resultSummary.id='resultSummary';resultSummary.hidden=true;resultSummary.style.cssText='white-space:pre-line;border-top:1px solid #ffffff40;padding-top:8px';
 clickStatus.id='clickStatus';clickStatus.textContent='클릭 대기 · 아직 입력 없음';clickCount.id='clickCount';clickCount.textContent='눌림 횟수: 0회';clickCount.style.cssText='font-size:23px;font-weight:800;font-variant-numeric:tabular-nums;margin:4px 0';clickCount.title='페이지에서 실제 관측한 눌림(pointerdown) 횟수입니다. 사이트 처리 성공 횟수와 구분합니다.';
 receipt.id='startSignal';receipt.textContent='시작 신호 대기';receipt.style.cssText='border-top:1px solid #ffffff40;padding-top:8px;font-weight:700';receipt.setAttribute('aria-live','polite');
 title.textContent='반복 정지 검증 · 연결 중';start.textContent='3초 후 시작';stop.textContent='정지';start.disabled=true;hint.textContent='Ctrl+Shift+Y로 즉시 시작 · Esc로 정지';box.append(title,message,clickStatus,clickCount,resultSummary,receipt,start,stop,hint);shadow.append(style,box);document.documentElement.append(host);
 const post=m=>{try{port?.postMessage(m);}catch{}};
 function geometry(origin,local,siteId){
   if(siteId==='nol'){
     if(visualViewport.scale!==1||visualViewport.offsetLeft||visualViewport.offsetTop)throw Error('화면 배율/좌표가 불확실합니다.');
     return {left:0,top:0,width:innerWidth,height:innerHeight,viewportWidth:innerWidth,viewportHeight:innerHeight};
   }
   const nodes=[...document.querySelectorAll('iframe')].filter(n=>{try{return new URL(n.src).origin===origin;}catch{return false;}});
   if(nodes.length!==1)throw Error('Claude 프레임을 하나로 확인하지 못했습니다.');
   const n=nodes[0],rect=n.getBoundingClientRect();
   for(let p=n;p;p=p.parentElement){const c=getComputedStyle(p);if(c.transform!=='none'||c.perspective!=='none'||Number(c.zoom||1)!==1)throw Error('변환된 프레임 좌표는 지원하지 않습니다.');}
   if(visualViewport.scale!==1||visualViewport.offsetLeft||visualViewport.offsetTop||rect.width<=0||rect.height<=0)throw Error('화면 배율/프레임 좌표가 불확실합니다.');
   if(document.elementFromPoint(rect.left+n.clientLeft+local.x,rect.top+n.clientTop+local.y)!==n)throw Error('다른 요소가 연습 프레임을 가리고 있습니다.');
   return {left:rect.left+n.clientLeft,top:rect.top+n.clientTop,width:n.clientWidth,height:n.clientHeight,viewportWidth:innerWidth,viewportHeight:innerHeight};
 }
 start.onclick=event=>{if(event.isTrusted)post({kind:'countdown'});};stop.onclick=()=>post({kind:'stop',reason:'페이지 정지 버튼'});
 function key(event){if(!config||!event.isTrusted)return;if(event.key==='Escape')post({kind:'stop',reason:'사용자 Esc 정지'});
   if(event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&event.code==='KeyY'&&!event.repeat){event.preventDefault();post({kind:'startRequest',source:'outer-key'});}}
 function accept(s){if(Number.isFinite(s.viewRevision)&&s.viewRevision<lastRevision)return false;
     if(Number.isFinite(s.viewRevision))lastRevision=s.viewRevision;
     return true;}
 function counts(s){data(host,'clickPhase',s.clickPhase||'waiting');data(host,'observedPresses',Number.isSafeInteger(s.observedPresses)?String(s.observedPresses):'unknown');
     text(clickStatus,s.clickMessage||'클릭 대기');text(clickCount,Number.isSafeInteger(s.observedPresses)?'눌림 횟수: '+numberFormat.format(s.observedPresses)+'회':'눌림 횟수: 확인 불가');}
 function displayProgress(s){if(s.runId!==config?.runId||!accept(s))return;counts(s);}
 function display(s){if(!accept(s))return;
     data(host,'state',s.status);data(host,'pointerReady',String(!!s.pointerReady));counts(s);
     resultSummary.hidden=!s.resultSummary;text(resultSummary,s.resultSummary?s.resultSummary.lines.join('\n')+'\n'+s.resultSummary.note:'');
     const signal=s.startSignal;host.dataset.startSignalState=signal?.state||'none';
     const signalKey=signal?signal.receivedAt+'|'+signal.state+'|'+signal.message:'none';
     if(signalKey!==lastSignal){lastSignal=signalKey;text(receipt,signal?signal.message+' ('+timeFormat.format(signal.receivedAt)+')':'시작 신호 대기');}
     receipt.style.color=signal?.state==='started'?'#91efb7':signal?.state==='not-started'?'#ffb0a7':'#ffe4a0';
     const tone=s.status==='running'?'running':['error','interrupted','unconfirmed'].includes(s.status)?'error':s.pointerReady||['completed','handoff'].includes(s.status)?'ready':'waiting';
     box.dataset.tone=tone;title.textContent=s.status==='armed'?(s.pointerReady?'준비 완료 · 마우스 위치 확인됨':'연결 완료 · 마우스 위치 대기'):s.status==='running'?'실행 중 · 커서를 그대로 두세요':s.status==='completed'?'완료 · 사이트 기록 확인':s.status==='handoff'?'반복 종료 · 이후 절차는 직접 진행':'검증 '+s.status;
     text(message,s.message);start.disabled=s.status!=='armed'||!!s.countdown;stop.disabled=!['preparing','armed','running','stopping'].includes(s.status);
     hint.textContent=s.shortcut?'Chrome 등록 키: '+s.shortcut+' · 3초 후 시작 버튼도 사용 가능':'Chrome 단축키 미할당 · 확장의 단축키 설정에서 Ctrl+Shift+Y 지정 또는 3초 후 시작';
 }
 const onMessage=(m,sender,respond)=>{if(!m.repeatPracticeControl)return;
   if(m.action==='configureShell'){
     config=m;port=chrome.runtime.connect({name:'ticket-repeat-practice-shell'});port.onMessage.addListener(message=>{
       if(message.kind==='progress'){displayProgress(message.state);return;}
       if(message.kind!=='request'||message.runId!==config.runId||message.action!=='geometry')return;
       try{post({kind:'reply',runId:config.runId,id:message.id,result:geometry(message.origin,message.local,message.siteId)});}
       catch(e){post({kind:'reply',runId:config.runId,id:message.id,error:e.message});}
     });post({kind:'ready',runId:m.runId});respond({ready:true});return;
   }
   if(!config||m.runId!==config.runId)return;
   if(m.action==='display'){
     display(m.state);respond({shown:true});
   }};
 document.addEventListener('keydown',key,true);chrome.runtime.onMessage.addListener(onMessage);
 globalThis.__ticketRepeatShellCleanup=()=>{document.removeEventListener('keydown',key,true);try{chrome.runtime.onMessage.removeListener(onMessage);port?.disconnect();}catch{}host.remove();};
})();
