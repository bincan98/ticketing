'use strict';
const cases = ['disabled', 'aria-disabled', 'class-ready', 'style', 'ancestor-style', 'dynamic-button', 'scope-late', 'scope-replaced',
  'duplicate-trigger', 'pointerdown', 'hybrid-gate', 'prepare-window', 'dry-run', 'verification-timeout', 'preexisting-success',
  'text-verification', 'external-completion', 'stop', 'safety-before', 'safety-after', 'dynamic-safety', 'bounded-poll', 'two-steps', 'repeat', 'runtime-cap', 'reinjection',
  'ambiguous-target', 'covered-target', 'url-change', 'storage-stop', 'data-ready',
  'nol-gate-activation','nol-gate-class-disabled','nol-gate-aria-disabled','nol-gate-style',
  'nol-gate-test-mode','nol-gate-popup-timeout','nol-gate-wrong-run','nol-gate-route-handoff',
  'nol-gate-duplicate','nol-gate-wrong-text','nol-gate-text-mutation','nol-gate-replaced','nol-gate-late',
  'nol-gate-access-block','nol-gate-hybrid','nol-gate-label-change','nol-gate-replaced-wrong-text',
  'practicket-activation','practicket-test-mode','practicket-alert','practicket-timeout','practicket-duplicate','practicket-replaced','practicket-captured-label'];
window.testResults = [];
(async () => {
  for (const name of cases) {
    const result = await new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.src = `fixture.html?case=${encodeURIComponent(name)}`;
      const timeout = setTimeout(() => {window.removeEventListener('message',receive);resolve({name,pass:false,error:'fixture timeout'});},5000);
      function receive(event) {
        if(event.source !== frame.contentWindow || event.data?.kind !== 'test-result') return;
        clearTimeout(timeout);window.removeEventListener('message',receive);resolve(event.data.result);
      }
      window.addEventListener('message',receive);document.getElementById('stage').replaceChildren(frame);
    });
    window.testResults.push(result);
    const row=document.createElement('li');row.className=result.pass?'pass':'fail';row.textContent=`${result.pass?'PASS':'FAIL'} ${name}${result.error?' — '+result.error:''}${result.latencyMs!==undefined?' · '+result.latencyMs.toFixed(3)+'ms':''}`;
    document.getElementById('results').append(row);
    document.getElementById('summary').textContent=`${window.testResults.length}/${cases.length} 완료 · ${window.testResults.filter(r=>r.pass).length} 통과`;
  }
  const pass=window.testResults.every(r=>r.pass);
  document.getElementById('summary').textContent=`${pass?'모두 통과':'실패 있음'}: ${window.testResults.filter(r=>r.pass).length}/${cases.length}`;
  document.getElementById('stage').replaceChildren();window.testsDone=true;
})();
