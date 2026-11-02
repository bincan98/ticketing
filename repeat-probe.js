/* Isolated-world event observer. Never invokes the page's click handlers directly. */
(()=>{'use strict';try{globalThis.__ticketRepeatProbeCleanup?.();}catch{}
 const site=TicketRepeatSites.forDocument(location.href),isNol=site?.id==='nol';
 if(!site)throw Error('지원하지 않는 입력 문서입니다.');
 let config,port,phase='idle',point,lastPoint,rect,armed=false,accepted=false,observer,button,scope,initError;
 let pointerRevision=0,confirmedRevision=-1,hover=false,buttons=0,moveQueued=false,rebinds=0;
 let startedAt,activationAt,validAt,acceptedAt,firstPressAt=null,lastPressAt=null,downs=[],extra=[],events=[],resultText=null,lastMetricsAt=-Infinity,validClicks=0,extraClicks=0,validInputs=0;
 let timingStartedAt,timingButton,wasVisible=false,wasEnabled=false,initiallyVisible=false,initiallyEnabled=false,appearanceAt=null,appearanceKind=null,inputTiming=null;
 const result=site.resultSelector?document.querySelector(site.resultSelector):null;
 try{
   const nodes=[...document.querySelectorAll(site.selector)].filter(n=>!isNol||visible(n));if(nodes.length!==1)throw Error('예매 버튼 후보가 '+nodes.length+'개입니다. 하나로 확인할 수 없습니다.');
   button=nodes[0];scope=button.parentElement;
   if(!isNol&&!result)throw Error('Claude 연습 결과 요소가 없습니다.');
 }catch(e){initError=e.message;}
 const post=message=>{try{port?.postMessage(message);}catch{}};
 const metrics=()=>({presses:downs.length,extraPointerdowns:extra.length,firstPressAt,lastPressAt});
 function finishSignal(reason){post({kind:'stop',reason});}
 function visible(n){if(!n?.isConnected)return false;
   for(let p=n;p;p=p.parentElement){const c=getComputedStyle(p);if(p.hidden||p.hasAttribute('inert')||p.getAttribute('aria-hidden')==='true'||c.display==='none'||['hidden','collapse'].includes(c.visibility)||Number(c.opacity)===0)return false;}
   const r=n.getBoundingClientRect();return r.width>0&&r.height>0;
 }
 function blocked(){return isNol&&[...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],div._content_b5a9t_72,iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"]')].some(visible);}
 function resolveButton(){
   if(!isNol)return button;
   if(!scope?.isConnected)throw Error('NOL 버튼 감시 영역이 교체되었습니다. 다시 준비하세요.');
   if(button?.isConnected){if(!scope.contains(button)||!button.matches(site.selector))throw Error('NOL 버튼 구조/영역이 바뀌었습니다.');return button;}
   const nodes=[...scope.querySelectorAll(site.selector)].filter(visible);
   if(nodes.length>1)throw Error('교체된 NOL 예매 버튼 후보가 여러 개입니다.');
   if(!nodes.length)return null;
   button=nodes[0];rebinds++;return button;
 }
 function ready(b=button){
   if(!isNol)return b.classList.contains('on');
   if(!b||b.matches(':disabled')||b.classList.contains('_disabled_2p3w6_34')||!visible(b))return false;
   for(let n=b;n;n=n.parentElement)if(n.getAttribute('aria-disabled')?.toLowerCase()==='true'||n.hidden||n.hasAttribute('inert'))return false;
   return getComputedStyle(b).pointerEvents!=='none';
 }
 // Observe DOM transitions outside the repeat input/flag path. All times share this document's clock.
 function observeTiming(b){
   if(timingStartedAt==null||validAt!=null)return;
   const shown=visible(b),enabled=shown&&ready(b),replaced=!!b&&b!==timingButton,at=performance.now();
   if(shown&&(!wasVisible||replaced)){appearanceAt=at;appearanceKind=replaced?'replacement':'became-visible';}
   if(enabled&&(!wasEnabled||replaced))activationAt=at;
   if(!enabled)activationAt=null;
   timingButton=b;wasVisible=shown;wasEnabled=enabled;
 }
 function timing(){return {observationStartedAt:timingStartedAt,initiallyVisible,initiallyEnabled,appearanceAt,appearanceKind,activationAt,firstValidInputAt:validAt};}
 function evidence(){return {completionEvent:site.event,validInputs,extraValidInputs:Math.max(0,validInputs-1),validClicks,extraClicks,timing:inputTiming||timing()};}
 function validInput(at){
   validInputs++;
   if(validAt==null){armed=true;validAt=at;inputTiming=timing();post({kind:'latched',...metrics(),evidence:evidence()});}
   else post({kind:'inputEvidence',evidence:evidence()});
 }
 function hitButton(p){
   if(!p||!button?.isConnected)return false;
   const hit=document.elementFromPoint(p.x,p.y);if(hit===button||button.contains(hit))return true;
   // A disabled button can pass pointer hit-testing to its ancestor. Never accept an overlay.
   if(isNol&&!ready()&&getComputedStyle(button).pointerEvents==='none'&&hit?.contains(button)){
     const r=button.getBoundingClientRect();return p.x>=r.left&&p.x<r.right&&p.y>=r.top&&p.y<r.bottom;
   }
   return false;
 }
 function snapshot(){
   const b=resolveButton();if(!b)return {accepted,armed,ready:false,...metrics(),valid:false,point,resultText};
   const now=b.getBoundingClientRect();
   let valid=b.isConnected&&point&&rect&&Math.abs(now.left-rect.left)<.5&&Math.abs(now.top-rect.top)<.5&&Math.abs(now.width-rect.width)<.5&&Math.abs(now.height-rect.height)<.5&&visualViewport.scale===1&&!document.hidden&&hitButton(point);
   if(isNol){
     if(blocked())valid=false;
     for(let n=b;n;n=n.parentElement){const c=getComputedStyle(n);if(c.transform!=='none'||c.perspective!=='none'||Number(c.zoom||1)!==1)valid=false;}
   }
   return {accepted,armed,ready:ready(b),...metrics(),valid:!!valid,point,resultText,rebinds,validClicks};
 }
 function report(){const gaps=downs.slice(1).map((t,i)=>t-downs[i]),sorted=[...gaps].sort((a,b)=>a-b);return {
   siteId:site.id,completionEvent:site.event,status:phase,startedAt,activationAt,firstValidInputAt:validAt,acceptedAt,accepted,siteText:resultText,
   inputConfirmed:validAt!=null,validClicks,extraClicks,validInputs,extraValidInputs:Math.max(0,validInputs-1),rebinds,timing:inputTiming||timing(),
   siteMs:resultText?Number(/^(\d+)ms/.exec(resultText)?.[1]):null,
   activationObserverToInputMs:validAt!=null&&activationAt!=null&&validAt>=activationAt?validAt-activationAt:null,
   ...metrics(),extraTargets:extra,events,
   actualIntervals:{count:gaps.length,meanMs:gaps.length?gaps.reduce((a,b)=>a+b,0)/gaps.length:null,medianMs:sorted[Math.floor(sorted.length/2)]??null,p95Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]??null,minMs:sorted[0]??null,maxMs:sorted.at(-1)??null}};}
 function beginStart(revision){
   if(phase!=='armed'||!lastPoint||!hover||buttons||revision!==pointerRevision||confirmedRevision!==pointerRevision)return {ok:false,error:'예매 버튼 위에서 마우스를 살짝 움직여 초록색 준비 완료를 확인하세요.'};
   resolveButton();if(blocked()||!hitButton(lastPoint))return {ok:false,error:'지정 위치가 다른 요소에 가려졌습니다.'};
   observeTiming(button);point={...lastPoint};rect=button.getBoundingClientRect();phase='running';startedAt=performance.now();return {ok:true,point};
 }
 function pointerState(){return {point:lastPoint,revision:pointerRevision,hover,buttons,confirmed:confirmedRevision===pointerRevision};}
 function moved(event){if(!event.isTrusted||event.pointerType!=='mouse')return;
   if(phase==='running'){if(!point||Math.abs(event.clientX-point.x)>.5||Math.abs(event.clientY-point.y)>.5)finishSignal('사용자가 마우스를 움직였습니다.');return;}
   if(phase==='armed'){
     try{resolveButton();}catch(e){finishSignal(e.message);return;}
     buttons=event.buttons;hover=hitButton({x:event.clientX,y:event.clientY});pointerRevision++;confirmedRevision=-1;
     if(hover&&!buttons)lastPoint={x:event.clientX,y:event.clientY};
     if(!moveQueued){moveQueued=true;queueMicrotask(()=>{moveQueued=false;if(phase==='armed')post({kind:'point',...pointerState()});});}
   }}
 function left(event){if(phase==='armed'&&event.isTrusted&&!event.relatedTarget){hover=false;pointerRevision++;confirmedRevision=-1;post({kind:'point',...pointerState()});}}
 function input(event){if(event.isTrusted&&phase==='armed')buttons=event.buttons;
   if(phase!=='running'||!event.isTrusted||event.button!==0)return;
   const at=performance.now();let onBook=event.target===button||button?.contains(event.target);
   if(isNol&&event.type==='click'){
     try{resolveButton();onBook=event.target===button||button?.contains(event.target);}catch(e){finishSignal(e.message);}
   }
   if(event.type==='pointerdown'){
     lastPressAt=Date.now();firstPressAt??=lastPressAt;downs.push(at);
     if(validAt!=null)extra.push({at,target:event.target.id||event.target.tagName,onBook});
     if(!isNol&&onBook&&ready())validInput(at);
     if(downs.length===1||at-lastMetricsAt>=250){lastMetricsAt=at;post({kind:'metrics',...metrics()});}
   }
   if(event.type==='click'&&onBook&&ready()){
     validClicks++;extraClicks=Math.max(0,validClicks-1);if(isNol)validInput(at);
   }
   if(events.length>=30)events.shift();events.push({type:event.type,at,onBook,target:event.target.id||event.target.tagName,isTrusted:event.isTrusted});
 }
 function key(event){if(!event.isTrusted||phase!=='armed'&&phase!=='running')return;
   if(event.key==='Escape'){event.preventDefault();finishSignal('사용자 Esc 정지');}
   if(event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey&&event.code==='KeyY'&&phase==='armed'&&!event.repeat){event.preventDefault();post({kind:'startRequest',source:'iframe-key'});}}
 const changed=()=>{if(phase==='running')finishSignal('스크롤/화면 크기가 바뀌었습니다.');};
 const onMessage=(m,sender,respond)=>{
   if(!m.repeatPracticeControl||sender.id!==chrome.runtime.id)return;
   if(m.action==='configure'){
     if(initError||m.siteId!==site.id||m.documentUrl!==location.href||isNol&&window!==top){respond({ready:false,error:initError||'대상 문서/사이트 정보가 다릅니다.'});return;}
     if(blocked()){respond({ready:false,error:'NOL 안내/로그인 창을 직접 확인한 뒤 다시 준비하세요.'});return;}
     config=m;phase='armed';timingStartedAt=performance.now();timingButton=button;
     wasVisible=initiallyVisible=visible(button);wasEnabled=initiallyEnabled=wasVisible&&ready(button);
     port=chrome.runtime.connect({name:'ticket-repeat-practice'});
     port.onMessage.addListener(request=>{
       if(request.kind!=='request'||request.runId!==config.runId)return;
       if(request.action==='inputStatus'){post({kind:'reply',runId:config.runId,id:request.id,result:{armed,phase}});return;}
       if(request.action!=='checkpoint')return;
       try{post({kind:'reply',runId:config.runId,id:request.id,result:snapshot()});}catch(e){post({kind:'reply',runId:config.runId,id:request.id,error:e.message});}
     });post({kind:'ready',runId:m.runId});
     observer=new MutationObserver(()=>{
       if(phase!=='running'&&phase!=='armed')return;
       try{observeTiming(resolveButton());}catch(e){if(phase==='running')finishSignal(e.message);}
       if(phase!=='running')return;
       if(isNol&&!armed){try{if(blocked())finishSignal('NOL 안내 창이 표시됐습니다. 직접 확인하세요.');}catch(e){finishSignal(e.message);}}
       if(!isNol&&validAt!=null&&!accepted&&/^\d+ms\s*·/.test(result.textContent)){accepted=true;acceptedAt=performance.now();resultText=result.textContent;post({kind:'accepted'});}
       if(!isNol&&!button.isConnected)finishSignal('연습 버튼이 교체되었습니다.');
     });
     observer.observe(button,{attributes:true,attributeFilter:['class']});if(result)observer.observe(result,{childList:true,subtree:true,characterData:true});
     observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','hidden','disabled','aria-disabled']});
     respond({ready:true});return;
   }
   if(!config||m.runId!==config.runId)return;
   if(m.action==='pointer'){respond(pointerState());return;}
   if(m.action==='pointReady'){if(m.revision===pointerRevision&&phase==='armed')confirmedRevision=m.valid?m.revision:-1;respond({confirmed:confirmedRevision===pointerRevision});return;}
   if(m.action==='begin'){try{respond(beginStart(m.revision));}catch(e){respond({ok:false,error:e.message});}return;}
   if(m.action==='checkpoint'){respond(snapshot());return;}
   if(m.action==='finish'){phase='done';respond(report());return;}
 };
 document.addEventListener('pointermove',moved,{capture:true,passive:true});document.addEventListener('pointerout',left,{capture:true,passive:true});
 for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.addEventListener(type,input,{capture:true,passive:true});
 document.addEventListener('keydown',key,true);addEventListener('scroll',changed,true);addEventListener('resize',changed,true);chrome.runtime.onMessage.addListener(onMessage);
 globalThis.__ticketRepeatProbeCleanup=()=>{observer?.disconnect();try{port?.disconnect();}catch{}document.removeEventListener('pointermove',moved,true);document.removeEventListener('keydown',key,true);document.removeEventListener('pointerout',left,true);
   for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.removeEventListener(type,input,true);
   removeEventListener('scroll',changed,true);removeEventListener('resize',changed,true);chrome.runtime.onMessage.removeListener(onMessage);};
})();
