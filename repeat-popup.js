/* UI adapter for the existing popup. Input remains in the repeat engine. */
(()=>{'use strict';
 const $=id=>document.getElementById(id),ACTIVE=['preparing','armed','running','stopping'];
 let hooks,mode='detect',state=null,busy=false,timer,error='';
 const rpc=async request=>{const r=await chrome.runtime.sendMessage(request);if(!r?.success)throw Error(r?.error||'확장 프로그램 응답이 없습니다.');return r;};
 const active=()=>!!state&&ACTIVE.includes(state.status);
 function render(){
   if(!hooks)return;
   const repeating=mode==='repeat';$('executionMode').value=mode;$('repeatControls').hidden=!repeating;
   $('detectSettings').hidden=repeating;$('advancedConfiguration').hidden=repeating;$('legacyLogs').hidden=repeating;$('captureTab').hidden=repeating;
   $('detectCaptureHint').hidden=repeating;
   $('repeatKey').textContent=state?.shortcut?'Chrome 등록 키: '+state.shortcut:'시작 키: Ctrl+Shift+Y · 미할당 시 단축키 설정에서 지정하세요.';
   $('repeatSignal').textContent=state?.startSignal?.message||'시작 신호 대기';
   $('repeatPhase').textContent=error||state?.clickMessage||'클릭 대기 · 준비 후 커서를 버튼 위로 이동하세요.';
   const presses=state?.observedPresses;$('repeatCount').textContent='눌림 횟수: '+(Number.isSafeInteger(presses)?presses.toLocaleString('ko-KR')+'회':state?'확인 불가':'0회');
   $('repeatResult').hidden=!state?.resultSummary;$('repeatSummary').textContent=state?.resultSummary?.lines?.join('\n')||'';$('repeatNote').textContent=state?.resultSummary?.note||'';
   $('repeatTarget').textContent=state?.pageUrl?state.siteName+' · '+state.pageUrl:'현재 NOL 상품 예매 대기 또는 Claude 연습 탭에서 준비합니다.';
   if(repeating&&(state||error))hooks.showStatus(error||state.message,error||['error','interrupted','unconfirmed'].includes(state.status)?'error':'info');
   hooks.updateButtons();
 }
 async function refresh(){if(mode!=='repeat'||busy)return;try{state=(await rpc({action:'repeatPracticeStatus'})).state;render();}catch(e){$('repeatPhase').textContent=e.message;}}
 async function prepare(){
   if(busy||active())return;
   let permission,expected;error='';
   try{
     const tab=hooks.currentTab(),site=TicketRepeatSites.forUrl(tab?.url),profile=hooks.profile(),selected=TicketRepeatSites.forUrl(profile?.url);
     if(!site)throw Error('NOL 상품 예매 대기 또는 Claude 연습 탭에서 준비하세요.');
     if(!selected||selected.id!==site.id)throw Error('현재 탭과 같은 사이트 프로필을 선택하세요.');
     expected={tabId:tab.id,url:tab.url,siteId:site.id};
     // Keep the optional-host permission prompt in the original user gesture.
     permission=chrome.permissions.request({origins:[new URL(tab.url).origin+'/*',...(site.frameOrigin?[site.frameOrigin+'/*']:[])]});
   }catch(e){error=e.message;render();return;}
   busy=true;render();
   try{if(!await permission)throw Error('사이트 접근 권한이 허용되지 않았습니다.');state=(await rpc({action:'repeatPracticePrepare',mode:'repeat',expectedTarget:expected})).state;}
   catch(e){error=e.message;}
   finally{busy=false;render();}
 }
 async function stop(){busy=true;error='';render();try{await rpc({action:'stopMacro'});state=(await rpc({action:'repeatPracticeStatus'})).state;}catch(e){error=e.message;}finally{busy=false;render();}}
 async function select(){
   const next=$('executionMode').value;if(next===mode)return;busy=true;error='';render();
   try{await rpc({action:'setExecutionMode',value:next});mode=next;}
   catch(e){error=e.message;hooks.showStatus(e.message,'error');}finally{busy=false;render();if(mode==='repeat')await refresh();}
 }
 function initialize(data,callbacks){
   hooks=callbacks;state=data.repeatState||null;mode=active()?'repeat':data.ticketExecutionMode==='repeat'?'repeat':'detect';
   $('executionMode').addEventListener('change',select);
   $('repeatShortcuts').onclick=()=>chrome.tabs.create({url:'chrome://extensions/shortcuts'});
   $('repeatCopy').onclick=async()=>{try{const r=await rpc({action:'repeatPracticeStatus'});await navigator.clipboard.writeText(JSON.stringify(r,null,2));$('repeatNotice').textContent='전체 결과를 복사했습니다.';}catch(e){$('repeatNotice').textContent=e.message;}};
   $('repeatDownload').onclick=async()=>{try{const r=await rpc({action:'repeatPracticeStatus'}),url=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='ticket-repeat-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$('repeatNotice').textContent=e.message;}};
   chrome.storage.onChanged.addListener((changes,area)=>{if(area!=='local')return;if(changes.repeatPracticeState)state=changes.repeatPracticeState.newValue||null;if(changes.ticketExecutionMode)mode=changes.ticketExecutionMode.newValue==='repeat'?'repeat':'detect';if(changes.repeatPracticeState||changes.ticketExecutionMode)render();});
   render();timer=setInterval(refresh,500);addEventListener('pagehide',()=>clearInterval(timer),{once:true});
 }
 globalThis.TicketModeUI={initialize,prepare,stop,active,get mode(){return mode;},get busy(){return busy;}};
})();
