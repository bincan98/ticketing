'use strict';
(async () => {
  const results = [], $ = id => document.getElementById(id);
  function check(name, fn) {
    try { fn(); results.push({name,pass:true}); }
    catch(e) { results.push({name,pass:false,error:e.message}); }
  }
  function assert(value,message) { if(!value) throw new Error(message); }
  let clicks=0, mutations=0;
  document.addEventListener('click',()=>clicks++,true);
  document.addEventListener('pointerdown',()=>clicks++,true);
  $('shadow').attachShadow({mode:'open'}).innerHTML='<button id="inner">그림자 예매</button><div id="nested"></div>';
  $('shadow').shadowRoot.getElementById('nested').attachShadow({mode:'open'}).innerHTML='<button disabled>중첩 비활성</button>';
  const closed=$('closed').attachShadow({mode:'closed'});closed.innerHTML='<button>닫힌 루트 버튼</button>';
  $('hostButton').attachShadow({mode:'open'}).innerHTML='<span>Shadow 역할 글자</span>';
  await new Promise(resolve => {if($('frame').contentWindow?.TicketAnalysis)resolve();else $('frame').addEventListener('load',resolve,{once:true});});
  const observer=new MutationObserver(records=>mutations+=records.length);observer.observe($('scope'),{subtree:true,childList:true,attributes:true,characterData:true});
  const report=TicketAnalysis.readPage();
  await Promise.resolve(); observer.disconnect();
  const byId=id=>report.buttons.find(button=>button.path==='#'+id);
  check('표시 텍스트와 숨긴 자식 분리',()=>assert(byId('enabled').text==='예매 시작',byId('enabled').text));
  check('native/fieldset 비활성',()=>assert(byId('disabled').disabled&&byId('fieldset').disabled,'disabled state missing'));
  check('aria-disabled 조상',()=>assert(byId('aria').disabled,'aria state missing'));
  check('inert 표시 버튼 포함/비활성',()=>assert(byId('inert').disabled,'inert excluded'));
  check('pointer-events 상태 사유',()=>assert(byId('pointer').disabledReasons.some(reason=>reason.includes('pointer-events')),'pointer state'));
  check('input value / role 버튼',()=>assert(byId('submit').text==='신청하기'&&byId('role').text==='역할 버튼','button types'));
  check('아이콘 버튼 표시 글자와 접근성 이름 구분',()=>assert(byId('icon').text===''&&byId('icon').accessibleLabel==='닫기','label distinction'));
  check('hidden/opacity/visibility 제외',()=>assert(!byId('hidden')&&!byId('transparent')&&!byId('visibility'),'hidden collected'));
  check('visibility 재정의 표시',()=>assert(byId('override'),'visible descendant omitted'));
  check('open/중첩 Shadow DOM',()=>assert(report.buttons.some(b=>b.text==='그림자 예매')&&report.buttons.some(b=>b.text==='중첩 비활성'&&b.disabled),'shadow traversal'));
  check('Shadow role host 글자',()=>assert(byId('hostButton').text==='Shadow 역할 글자','shadow host label'));
  check('closed 미지원 누락 안내',()=>assert(report.warnings.some(w=>w.includes('closed Shadow')),'closed warning'));
  check('화면 밖 버튼 구분',()=>assert(byId('offscreen')&&!byId('offscreen').inViewport,'offscreen marker'));
  check('iframe 표시 상태 목록',()=>assert(report.frames.length===2&&report.frames.some(f=>!f.visible),'iframe inventory'));
  check('iframe 내부 문서 수집',()=>{
    const child=$('frame').contentWindow.TicketAnalysis.readPage();
    assert(child.documentUrl==='about:srcdoc'&&child.buttons.length===1&&child.buttons[0].text==='iframe 버튼','iframe capture');
  });
  check('실제 Chrome closed API 경로 모의 검증',()=>{
    const originalChrome=window.chrome;
    window.chrome={dom:{openOrClosedShadowRoot:node=>node===$('closed')?closed:null}};
    try {
      const withClosed=TicketAnalysis.readPage();
      assert(withClosed.buttons.some(b=>b.text==='닫힌 루트 버튼')&&withClosed.coverage.closedShadowRoots===1,'closed support');
    } finally { window.chrome=originalChrome; }
  });
  check('이벤트 및 DOM 수정 없음',()=>assert(clicks===0&&mutations===0,'events/mutations: '+clicks+'/'+mutations));
  check('복사 직렬화에 전체 버튼/누락 사유 포함',()=>assert(JSON.parse(TicketAnalysis.formatResult(report)).buttons.length===report.buttons.length,'JSON copy'));
  for(const result of results) {
    const row=document.createElement('li');row.className=result.pass?'pass':'fail';
    row.textContent=(result.pass?'PASS ':'FAIL ')+result.name+(result.error?' — '+result.error:'');$('results').append(row);
  }
  $('summary').textContent=results.filter(r=>r.pass).length+'/'+results.length+' 통과 · 클릭 '+clicks+' · DOM 변경 '+mutations;
  window.analysisTestResults=results;window.analysisTestsDone=true;
})();
