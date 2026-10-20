const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared.js');
test('legacy stored click preferences remain readable and malformed fallback modes are rejected',()=>{
  const old=C.defaultProfile();delete old.settings.clickMethod;
  assert.equal(C.validateProfile(old).settings.clickMethod,'javascript');
  old.settings.clickMethod='cdp';assert.equal(C.validateForRun(old).settings.clickMethod,'cdp');
  old.settings.clickMethod='auto';assert.throws(()=>C.validateProfile(old),/클릭 실행 방식/);
});
test('verified default uses real iframe, .on readiness, and pointerdown', () => {
  const p = C.validateProfile(C.defaultProfile());
  assert.equal(p.settings.mode, 'activation'); assert.equal(p.settings.prepareSeconds, 30);
  assert.equal(p.steps[0].selector, '#bookBtn'); assert.equal(p.steps[0].event, 'pointerdown');
  assert.equal(p.steps[0].readySelector, '#bookBtn.on'); assert.equal(p.settings.pollingMs, 0);
  assert.equal(p.settings.testMode, true);
});
test('new sites cannot start with guessed or missing selectors', () => {
  const p = C.newProfile(); p.url = 'https://example.com/tickets';
  assert.equal(p.steps[0].selector, ''); assert.throws(() => C.validateProfile(p), /관찰 영역/);
});
test('rejects unsafe URLs and credentials; origin permissions are exact', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:pass@example.com', 'not-a-url']) assert.throws(() => C.httpUrl(url));
  assert.deepEqual(C.permissionsFor(C.defaultProfile()), ['https://claude.ai/*', `${C.FRAME_ORIGIN}/*`]);
});
test('page matching excludes another artifact; query match is optional', () => {
  assert(C.pageMatches(C.INITIAL_URL + '?a=1', C.INITIAL_URL));
  assert(!C.pageMatches(C.INITIAL_URL + '?a=1', C.INITIAL_URL, true));
  assert(!C.pageMatches(C.INITIAL_URL + '/other', C.INITIAL_URL));
});
test('rejects polling floods, invalid repetitions, and missing completion', () => {
  for (const [key,value] of [['pollingMs', 1], ['pollingMs', 49], ['count', ''], ['count', -1], ['count', 1.2], ['maxRuntimeSeconds', 7201]]) {
    const p = C.defaultProfile(); p.settings[key] = value; assert.throws(() => C.validateProfile(p));
  }
  const p = C.defaultProfile(); p.steps[0].verify.selector = ''; assert.throws(() => C.validateProfile(p), /완료 Selector/);
});
test('iframe selection never broadcasts to multiple frames', () => {
  const p = C.defaultProfile();
  const frames = [{frameId: 0, url: p.url}, {frameId: 4, url: p.frameUrl + '/_f/123'}];
  assert.equal(C.selectFrame(frames, p).frameId, 4);
  assert.throws(() => C.selectFrame([...frames, {frameId: 5, url:p.frameUrl + '/other'}], p), /2개/);
  assert.throws(() => C.selectFrame(frames.slice(0,1), p), /0개/);
  p.frameUrl = ''; assert.equal(C.selectFrame(frames, p).frameId, 0);
});
test('subframe path/query must not be treated as an origin', () => {
  const p = C.defaultProfile(); p.frameUrl += '/_f/123?x=1';
  assert.throws(() => C.validateProfile(p), /origin/);
});
test('NOL gate uses the supplied button HTML without schedule selection', () => {
  const p = C.validateForRun(C.nolProfile());
  assert.equal(p.name,'NOL 티켓');
  assert.equal(p.frameUrl,''); assert.equal(p.settings.mode,'activation');
  assert.equal(p.settings.prepareSeconds,60);assert.equal(p.steps[0].timeoutMs,60000);
  assert.equal(p.steps[0].selector,'button._primary_2p3w6_7'); assert.equal(p.steps[0].verify.kind,'newContext');
  assert.equal(p.scopeSelector,'button._primary_2p3w6_7:has(> span._content_2p3w6_38)');
  assert.equal(p.steps[0].buttonText,'10/14 09:00 예매하기');assert.equal(p.steps[0].targetText,'');
  assert.match(p.steps[0].readySelector, /:not\(\._disabled_2p3w6_34\)/);
  assert.deepEqual(C.permissionsFor(p),['https://tickets.interpark.com/*']);
  assert.equal(p.steps[0].event,'click');
});
test('NOL product gate URLs are configurable while the run remains bound to one product', () => {
  const p=C.nolProfile();const other='https://tickets.interpark.com/gates/ticket/26099999?bc=1&pc=2';
  assert(C.isNolGateUrl(other));assert(C.canReuseNolGateSettings(p,other));
  p.url=other;assert.equal(C.validateForRun(p).url,other);
  assert(!C.pageMatches(C.NOL_URL,p.url));
  assert(C.pageMatches(other+'&ps=changed',p.url));
  p.exactSearch=true;assert(!C.pageMatches(other+'&ps=changed',p.url,p.exactSearch));
  assert.deepEqual(C.permissionsFor(p),['https://tickets.interpark.com/*']);
});
test('both supplied NOL gates are accepted and may replace the current product settings',()=>{
  const urls=['https://tickets.interpark.com/gates/ticket/26014841?bc=61776&pc=21000190&ps=&pass_code=',
    'https://tickets.interpark.com/gates/ticket/P0004869?bc=61776&pc=P1001005&ps=&pass_code='];
  for(const before of urls)for(const after of urls) {
    const p=C.nolProfile();p.url=before;assert(C.isNolGateUrl(after));assert(C.canReuseNolGateSettings(p,after));
    assert.equal(C.validateForRun({...p,url:after}).url,after);
    const next=C.applyTabCapture(p,{url:after,frameUrl:'',buttons:[{text:'예매하기',selector:'#buy',scopeSelector:'#scope'}]});assert.equal(next.url,after);
  }
  for(const id of ['P','p0004869','Pabc','P0004869/extra','P0004869%2Fextra'])assert(!C.isNolGateUrl('https://tickets.interpark.com/gates/ticket/'+id));
});
test('NOL URL reuse rejects other hosts, routes, protocols and unverified iframe adapters', () => {
  const p=C.nolProfile();
  for(const url of ['http://tickets.interpark.com/gates/ticket/26099999','https://tickets.interpark.com.evil.example/gates/ticket/26099999',
    'https://tickets.interpark.com/goods/26099999','https://tickets.interpark.com/gates/ticket/abc',
    'https://user:pass@tickets.interpark.com/gates/ticket/26099999',C.NOL_LEGACY_URL,'not-a-url']) {
    assert(!C.isNolGateUrl(url));assert(!C.canReuseNolGateSettings(p,url));
  }
  p.frameUrl='https://tickets.interpark.com';assert(!C.canReuseNolGateSettings(p,C.NOL_URL));
  p.frameUrl='';p.siteAdapter='';assert(!C.canReuseNolGateSettings(p,C.NOL_URL));
});
test('external context verification cannot repeat or auto-click later steps', () => {
  const p=C.nolProfile(); p.settings.count=2; assert.throws(()=>C.validateProfile(p),/한 단계·한 번/);
  p.settings.count=1;p.steps.push({...p.steps[0]});assert.throws(()=>C.validateProfile(p),/한 단계·한 번/);
});
test('NOL adapter cannot silently apply on another page or iframe', () => {
  const p=C.nolProfile();p.url='https://example.com';
  assert.throws(()=>C.validateForRun(p),/최상위 문서/);
  p.url=C.NOL_URL;p.frameUrl='https://nol.yanolja.com';assert.throws(()=>C.validateForRun(p),/최상위 문서/);
  p.frameUrl='';p.url=C.NOL_LEGACY_URL;assert.throws(()=>C.validateForRun(p),/최상위 문서/);
  p.siteAdapter='nol-postseason';assert.throws(()=>C.validateForRun(p),/비활성화/);
});
test('Practicket profile uses the inspected gate/button and only that origin', () => {
  const p=C.validateForRun(C.practicketProfile());
  assert.equal(p.url,C.PRACTICKET_URL);assert.equal(p.frameUrl,'');assert.equal(p.scopeSelector,'div.nt-gate');
  assert.equal(p.steps[0].selector,'#bookBtn');assert.equal(p.steps[0].event,'click');
  assert.equal(p.settings.mode,'activation');assert.equal(p.steps[0].timeoutMs,60000);
  assert.equal(p.steps[0].verify.kind,'newContext');assert.deepEqual(p.safetySelectors,['#pkt-alert-overlay']);
  assert.deepEqual(C.permissionsFor(p),['https://practicket.com/*']);
});
test('Practicket adapter rejects other practice stages and iframes', () => {
  const p=C.practicketProfile();p.url='https://practicket.com/practice/n-ticket/queue';
  assert.throws(()=>C.validateForRun(p),/intro/);
  p.url=C.PRACTICKET_URL;p.frameUrl='https://practicket.com';assert.throws(()=>C.validateForRun(p),/intro/);
});
test('capture applies actual URL, label and selectors atomically while preserving schedule/test/verification settings',()=>{
  const p=C.nolProfile();p.exactSearch=true;p.settings.mode='hybrid';p.settings.scheduledAt=Date.now()+3600000;p.settings.testMode=false;
  const captured={url:'https://tickets.interpark.com/gates/ticket/26099999?bc=1',frameUrl:'',buttons:[
    {text:'10/20 10:00 예매하기',selector:'button:nth-of-type(2)',scopeSelector:'button:nth-of-type(2)'}]};
  const result=C.applyTabCapture(p,captured);
  assert.equal(result.url,captured.url);assert.equal(result.steps[0].buttonText,captured.buttons[0].text);
  assert.equal(result.scopeSelector,captured.buttons[0].scopeSelector);assert.equal(result.steps[0].selector,captured.buttons[0].selector);
  assert.deepEqual(result.settings,p.settings);assert.equal(result.steps[0].event,p.steps[0].event);
  assert.equal(result.steps[0].verify.kind,p.steps[0].verify.kind);assert.equal(result.exactSearch,true);
  assert.equal(p.url,C.NOL_URL);assert.equal(p.steps[0].buttonText,'10/14 09:00 예매하기');
});
test('capture application refuses a wrong page/frame, blank text or an unchosen button',()=>{
  const p=C.nolProfile();const capture={url:C.NOL_URL,frameUrl:'',buttons:[{text:'예매하기',selector:'#button',scopeSelector:'#button'}]};
  assert.throws(()=>C.applyTabCapture(p,{...capture,url:'https://example.com'}),/다른 사이트/);
  assert.throws(()=>C.applyTabCapture(p,{...capture,frameUrl:'https://example.com'}),/문서가 달라/);
  assert.throws(()=>C.applyTabCapture(p,capture,-1),/선택/);
  assert.throws(()=>C.applyTabCapture(p,{...capture,buttons:[{...capture.buttons[0],text:''}]}),/문구/);
});
test('NOL structural binding is opt-in from verified capture and cannot leak to another adapter or frame',()=>{
  const p=C.nolProfile(),captured={url:p.url,frameUrl:'',buttons:[{text:'남은시간 35:45',selector:'#a',scopeSelector:'#a',nolPrimary:true}]};
  const next=C.applyTabCapture(p,captured);assert.equal(next.steps[0].nolPrimary,true);assert.equal(next.steps[0].buttonText,'남은시간 35:45');
  assert.equal(p.steps[0].nolPrimary,undefined);
  delete captured.buttons[0].nolPrimary;assert.equal(C.applyTabCapture(next,captured).steps[0].nolPrimary,undefined);
  next.siteAdapter='';assert.throws(()=>C.validateProfile(next),/최상위 문서/);
  next.siteAdapter='nol-gate';next.frameUrl='https://tickets.interpark.com';assert.throws(()=>C.validateProfile(next),/최상위 문서/);
});
test('seat status is specific to the NOL adapter, exact HTTPS host and seat route',()=>{
  const p=C.nolProfile();assert.match(C.nolPageNotice(p,'https://tickets.interpark.com/onestop/seat?x=1'),/이미 좌석 선택/);
  for(const url of ['http://tickets.interpark.com/onestop/seat','https://tickets.interpark.com.evil.example/onestop/seat','https://tickets.interpark.com/onestop/payment',p.url])assert.equal(C.nolPageNotice(p,url),'');
  assert.equal(C.nolPageNotice(C.defaultProfile(),'https://tickets.interpark.com/onestop/seat'),'');
});
