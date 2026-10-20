'use strict';
(async()=>{
  const F=fixture,name=new URL(location.href).searchParams.get('case');
  const $=id=>document.getElementById(id);
  const p=TicketConfig.newProfile('test');
  p.url=location.href;p.name='Test';p.scopeSelector='#scope';p.safetySelectors=['#guard'];
  p.settings={mode:'activation',scheduledAt:null,prepareSeconds:30,pollingMs:0,count:1,delaySeconds:.5,maxRuntimeSeconds:2,testMode:false};
  p.steps=[{name:'Click',selector:'#target',readySelector:'',event:'click',timeoutMs:350,verify:{kind:'appeared',selector:'#done',value:'',attribute:'',timeoutMs:150}}];
  const assert=(value,message)=>{if(!value)throw Error(message);};
  let complete=true,activate=()=>{$('target').disabled=false;},expected='completed';
  let added=false;
  function handler(){F.clicks++;if(complete)$('done').hidden=false;}
  $('target').addEventListener('click',handler);
  if(name==='aria-disabled'){
    $('target').disabled=false;$('target').setAttribute('aria-disabled','true');activate=()=>{$('target').setAttribute('aria-disabled','false');};
  }
  if(name==='class-ready'){
    $('target').disabled=false;p.steps[0].readySelector='#target.on';activate=()=>{$('target').classList.add('on');};
  }
  if(name==='style'){
    $('target').disabled=false;$('target').style.pointerEvents='none';activate=()=>{$('target').style.pointerEvents='auto';};
  }
  if(name==='ancestor-style'){
    $('target').disabled=false;document.body.style.visibility='hidden';activate=()=>{document.body.style.visibility='visible';};
  }
  if(name==='dynamic-button'){
    $('target').remove();activate=()=>{const button=document.createElement('button');button.id='target';button.textContent='동적 예매';button.addEventListener('click',handler);$('scope').prepend(button);};
  }
  if(name==='scope-late'){
    const scope=$('scope');scope.remove();activate=()=>{document.body.prepend(scope);$('target').disabled=false;};
  }
  if(name==='scope-replaced'){
    activate=()=>{const scope=document.createElement('div');scope.id='scope';scope.innerHTML='<button id="target">새 예매</button><div id="done" hidden>완료</div>';$('scope').replaceWith(scope);$('target').addEventListener('click',handler);};
  }
  if(name==='duplicate-trigger')p.settings.pollingMs=50;
  if(name==='pointerdown'){
    p.steps[0].event='pointerdown';$('target').removeEventListener('click',handler);$('target').addEventListener('pointerdown',handler);
  }
  if(name==='hybrid-gate'||name==='prepare-window'){
    $('target').disabled=false;p.settings.mode='hybrid';p.settings.scheduledAt=Date.now()+220;p.settings.prepareSeconds=name==='prepare-window'?.08:30;
  }
  if(name==='dry-run'){p.settings.testMode=true;expected='tested';}
  if(name==='verification-timeout'){complete=false;expected='timeout';p.settings.count=0;}
  if(name==='preexisting-success'){$('done').hidden=false;expected='error';}
  if(name==='text-verification'){
    p.steps[0].verify={kind:'textChanged',selector:'#result',timeoutMs:150};
    $('target').removeEventListener('click',handler);$('target').addEventListener('click',()=>{F.clicks++;$('result').textContent='after';});
  }
  if(name==='external-completion'){
    $('done').remove();p.steps[0].verify.selector='#external';complete=false;
    $('target').addEventListener('click',()=>setTimeout(()=>{const done=document.createElement('p');done.id='external';done.textContent='new';document.body.append(done);},20));
  }
  if(name==='stop')expected='stopped';
  if(name==='safety-before'){$('guard').hidden=false;expected='handoff';}
  if(name==='safety-after'){$('target').addEventListener('click',()=>{$('guard').hidden=false;});expected='handoff';}
  if(name==='dynamic-safety'){
    $('guard').remove();expected='handoff';activate=()=>{const guard=document.createElement('p');guard.id='guard';guard.textContent='대기열';document.body.append(guard);};
  }
  if(name==='bounded-poll'){
    $('target').disabled=false;$('sheet').sheet.cssRules[0].style.pointerEvents='none';p.settings.pollingMs=50;
    activate=()=>{$('sheet').sheet.cssRules[0].style.pointerEvents='auto';};
  }
  if(name==='two-steps'){
    const button=document.createElement('button');button.id='second';button.disabled=true;button.textContent='다음';$('scope').append(button);
    const done=document.createElement('div');done.id='secondDone';done.hidden=true;done.textContent='step2 done';$('scope').append(done);
    $('target').addEventListener('click',()=>{button.disabled=false;});button.addEventListener('click',()=>{F.clicks++;done.hidden=false;});
    p.steps.push({...p.steps[0],name:'second',selector:'#second',verify:{kind:'appeared',selector:'#secondDone',timeoutMs:150}});
  }
  if(name==='repeat'){
    p.settings.count=2;
    $('target').addEventListener('click',()=>{
      $('target').disabled=true;
      if(F.clicks===1)setTimeout(()=>{$('done').hidden=true;$('target').disabled=false;},100);
    });
  }
  if(name==='runtime-cap'){p.settings.maxRuntimeSeconds=.06;expected='timeout';activate=()=>{};}
  if(name==='ambiguous-target'){
    const extra=$('target').cloneNode(true);$('scope').append(extra);expected='error';
  }
  if(name==='covered-target'){
    const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;background:white;z-index:9999';document.body.append(cover);
    $('target').disabled=false;activate=()=>{cover.remove();};
  }
  if(name==='url-change'){
    expected='interrupted';activate=()=>{history.pushState({},'',location.pathname+'?changed=1');$('target').disabled=false;};
  }
  if(name==='storage-stop')expected='stopped';
  if(name==='data-ready'){
    $('target').disabled=false;$('target').setAttribute('data-ready','false');p.steps[0].readySelector='#target[data-ready="true"]';
    activate=()=>{$('target').setAttribute('data-ready','true');};
  }
  /* Legacy schedule-scanning fixture disabled with the legacy profile in 2.1.4.
  if(name.startsWith('nol-')){
    const settings=p.settings;Object.assign(p,TicketConfig.nolProfile());p.settings=settings;
    p.steps[0].timeoutMs=350;p.steps[0].verify.timeoutMs=150;
    p.steps[0].targetText='와일드카드결정전 2차전\n10월 15일(목) 18:30';
    $('scope').innerHTML='<section id="GOODS_RESERVATION-492"><div><div class="grid-area_info"><span>와일드카드결정전 1차전</span><div><span>10월 14일(수) 18:30</span></div></div><button class="grid-area_cta" id="other">예매하기</button></div><div><div class="grid-area_info"><span>와일드카드결정전 2차전</span><div><span>10월 15일(목) 18:30</span></div></div><button class="grid-area_cta" id="target" disabled>예매하기</button></div></section>';
    $('other').addEventListener('click',()=>{F.otherClicks=(F.otherClicks||0)+1;});
    $('target').addEventListener('click',()=>{
      F.clicks++;
      if(name==='nol-popup-timeout')return;
      if(name==='nol-route-handoff'){history.pushState({},'',location.pathname+'?booking=next');return;}
      setTimeout(()=>{
        if(name==='nol-wrong-run')assert(!F.send({action:'contextOpened',runId:'wrong',tabId:99}).success,'accepted unrelated run');
        F.send({action:'contextOpened',runId:'test-run',tabId:99});
      },10);
    });
    complete=false;expected='handoff';activate=()=>{$('target').disabled=false;};
    if(name==='nol-test-mode'){p.settings.testMode=true;expected='tested';}
    if(name==='nol-popup-timeout')expected='timeout';
    if(name==='nol-duplicate-game'){
      const copy=$('target').parentElement.cloneNode(true);copy.querySelector('button').id='duplicate';
      document.querySelector('section').append(copy);expected='error';
    }
  }
  */
  if(name.startsWith('nol-gate-')){
    const settings=p.settings;Object.assign(p,TicketConfig.nolProfile());p.settings=settings;
    p.steps[0].timeoutMs=350;p.steps[0].verify.timeoutMs=150;
    // Button markup copied from the user's actual disabled gate element.
    $('scope').innerHTML='<button type="button" disabled="" class="_primary_2p3w6_7 _disabled_2p3w6_34"><span class="_content_2p3w6_38">10/14 09:00 예매하기</span></button>';
    let button=document.querySelector('button._primary_2p3w6_7');
    const click=()=>{
      F.clicks++;
      if(name==='nol-gate-popup-timeout')return;
      if(name==='nol-gate-route-handoff'){history.pushState({},'',location.pathname+'?booking=next');return;}
      setTimeout(()=>{
        if(name==='nol-gate-wrong-run')assert(!F.send({action:'contextOpened',runId:'wrong',tabId:99}).success,'accepted unrelated run');
        F.send({action:'contextOpened',runId:'test-run',tabId:99});
      },10);
    };
    button.addEventListener('click',click);
    activate=()=>{button.disabled=false;button.classList.remove('_disabled_2p3w6_34');};
    complete=false;expected='handoff';
    if(name==='nol-gate-class-disabled'){button.disabled=false;}
    if(name==='nol-gate-aria-disabled'){
      activate();button.setAttribute('aria-disabled','true');activate=()=>button.setAttribute('aria-disabled','false');
    }
    if(name==='nol-gate-style'){
      activate();button.style.pointerEvents='none';activate=()=>button.style.pointerEvents='auto';
    }
    if(name==='nol-gate-test-mode'){p.settings.testMode=true;expected='tested';}
    if(name==='nol-gate-popup-timeout')expected='timeout';
    if(name==='nol-gate-duplicate'){
      activate=()=>{const copy=button.cloneNode(true);$('scope').append(copy);button.disabled=false;};expected='error';
    }
    if(name==='nol-gate-wrong-text'){button.querySelector('span').textContent='10/15 09:00 예매하기';expected='timeout';}
    if(name==='nol-gate-text-mutation'){
      activate();button.querySelector('span').firstChild.data='10/15 09:00 예매하기';
      activate=()=>{button.querySelector('span').firstChild.data='10/14 09:00 예매하기';};
    }
    if(name==='nol-gate-label-change')activate=()=>{
      button.querySelector('span').textContent='예매하기';button.disabled=false;button.classList.remove('_disabled_2p3w6_34');
    };
    if(name==='nol-gate-replaced-wrong-text'){
      activate=()=>{
        const copy=button.cloneNode(true);copy.querySelector('span').textContent='10/15 09:00 예매하기';
        copy.disabled=false;copy.classList.remove('_disabled_2p3w6_34');button.replaceWith(copy);copy.addEventListener('click',click);
      };expected='timeout';
    }
    if(name==='nol-gate-replaced')activate=()=>{
      const copy=button.cloneNode(true);button.replaceWith(copy);button=copy;button.addEventListener('click',click);
      button.disabled=false;button.classList.remove('_disabled_2p3w6_34');
    };
    if(name==='nol-gate-late'){
      button.remove();activate=()=>{$('scope').append(button);button.disabled=false;button.classList.remove('_disabled_2p3w6_34');};
    }
    if(name==='nol-gate-access-block'){
      const block=document.createElement('div');block.className='_content_b5a9t_72';block.textContent='정상적인 접근이 아닙니다.';document.body.append(block);
    }
    if(name==='nol-gate-hybrid'){
      p.settings.mode='hybrid';p.settings.scheduledAt=Date.now()+220;p.settings.prepareSeconds=60;
    }
  }
  if(name.startsWith('practicket-')){
    const settings=p.settings;Object.assign(p,TicketConfig.practicketProfile());p.settings=settings;
    p.steps[0].timeoutMs=350;p.steps[0].verify.timeoutMs=150;
    if(name==='practicket-captured-label'){p.steps[0].buttonText='남은시간 00:05';p.steps[0].bindButtonText=true;}
    $('scope').innerHTML='<div class="nt-gate"><button class="nt-book" id="bookBtn" disabled>남은시간 00:05</button></div><div id="pkt-alert-overlay" hidden>닉네임 필요</div>';
    const click=()=>{F.clicks++;if(name!=='practicket-timeout')history.pushState({},'',location.pathname+'?practice-next=1');};
    $('bookBtn').addEventListener('click',click);
    activate=()=>{$('bookBtn').textContent='예매하기';$('bookBtn').disabled=false;};
    complete=false;expected='handoff';
    if(name==='practicket-test-mode'){p.settings.testMode=true;expected='tested';}
    if(name==='practicket-timeout')expected='timeout';
    if(name==='practicket-alert')$('pkt-alert-overlay').hidden=false;
    if(name==='practicket-duplicate'){
      const duplicate=$('bookBtn').cloneNode(true);document.querySelector('.nt-gate').append(duplicate);expected='error';
    }
    if(name==='practicket-replaced')activate=()=>{
      const gate=document.createElement('div');gate.className='nt-gate';gate.innerHTML='<button class="nt-book" id="bookBtn">예매하기</button>';
      document.querySelector('.nt-gate').replaceWith(gate);$('bookBtn').addEventListener('click',click);
    };
  }
  try{
    const run={id:'test-run',profile:p,status:'starting',createdAt:Date.now(),stepIndex:0,cycle:1,logs:[]};F.data.macroRun=clone(run);
    assert(F.send({action:'startEngine',run})?.success,'start rejected');
    if(name.startsWith('nol-'))assert(!F.send({action:'contextOpened',runId:'test-run',tabId:99}).success,'accepted popup before click');
    if(name==='reinjection'){
      await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/content.js';s.onload=resolve;s.onerror=reject;document.body.append(s);});
      assert(F.listeners.length===1,'duplicate message listeners after injection');
    }
    await F.sleep(25);
    assert(F.clicks===0,'clicked before activation/gate');
    if(name==='prepare-window')assert(F.data.macroRun.status==='scheduled','watching before prepare window');
    if(name==='stop'){F.send({action:'stopEngine',runId:run.id});activate();}
    else if(name==='storage-stop'){
      await chrome.storage.local.set({macroRun:{...F.data.macroRun,status:'stopping',stopRequested:true,message:'사용자 중지 요청'}});activate();
    }else activate();
    if(name==='hybrid-gate'||name==='nol-gate-hybrid'){await F.sleep(35);assert(F.clicks===0,'clicked before scheduled time');}
    await F.until(()=>F.data.macroRun&&!TicketConfig.isActive(F.data.macroRun));
    const result=F.data.macroRun;
    assert(result.status===expected,`expected ${expected}, got ${result.status}: ${result.message}`);
    const noClick=['dry-run','preexisting-success','stop','safety-before','dynamic-safety','runtime-cap','ambiguous-target','url-change','storage-stop',
      'nol-gate-test-mode','nol-gate-duplicate','nol-gate-wrong-text','nol-gate-access-block','nol-gate-replaced-wrong-text',
      'practicket-test-mode','practicket-alert','practicket-duplicate'].includes(name);
    assert(F.clicks===(noClick?0:['repeat','two-steps'].includes(name)?2:1),`wrong event count: ${F.clicks}`);
    assert(!F.otherClicks,'clicked another game');
    if(name==='hybrid-gate'||name==='prepare-window'||name==='nol-gate-hybrid')assert(result.lastAttempt.timestamp>=p.settings.scheduledAt,'timestamp before gate');
    const clicks=F.clicks;await F.sleep(50);assert(F.clicks===clicks,'late/duplicate click after finish');
    const status=await F.sendAsync({action:'engineStatus'});assert(!status.running,'engine still running after finish');
    parent.postMessage({kind:'test-result',result:{name,pass:true,status:result.status,clicks:F.clicks,latencyMs:result.lastAttempt?.detectToAttemptMs}},location.origin);
  }catch(e){parent.postMessage({kind:'test-result',result:{name,pass:false,error:e.message,clicks:F.clicks}},location.origin);}
})();
