/* Shared validation: no page selectors are inferred for new sites. */
(function (root) {
  'use strict';
  const INITIAL_URL = 'https://claude.ai/artifact/TZ6E7URiDk5584MDPEEC2G';
  const FRAME_ORIGIN = 'https://d708a060-a8d9-48df-b1d5-a84f53c6a06d.frame.claudeusercontent.com';
  const NOL_LEGACY_URL = 'https://nol.yanolja.com/ticket/genre/sports/postseason';
  const NOL_URL = 'https://tickets.interpark.com/gates/ticket/26014670?bc=61776&pc=26001278&ps=&pass_code=';
  const PRACTICKET_URL = 'https://practicket.com/practice/n-ticket/intro';
  const ACTIVE = ['starting', 'scheduled', 'watching', 'verifying', 'repeat-wait', 'stopping'];
  const clone = value => JSON.parse(JSON.stringify(value));
  function currentMinute(now = Date.now()) {
    const date = new Date(now);
    date.setSeconds(0, 0);
    return date.getTime();
  }
  function httpUrl(value) {
    let url;
    try { url = new URL(value); } catch { throw new Error('올바른 사이트 URL을 입력하세요.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('인증 정보 없는 HTTP/HTTPS URL만 사용할 수 있습니다.');
    }
    return url;
  }
  function originPattern(value) { return `${httpUrl(value).origin}/*`; }
  function pageMatches(actual, expected, exactSearch = false) {
    try {
      const a = httpUrl(actual), b = httpUrl(expected);
      return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '') &&
        (!exactSearch || a.search === b.search);
    } catch { return false; }
  }
  function isNolGateUrl(value) {
    try {
      const url = httpUrl(value);
      return url.origin === 'https://tickets.interpark.com' && /^\/gates\/ticket\/(?:\d+|P\d+)\/?$/.test(url.pathname);
    } catch { return false; }
  }
  function canReuseNolGateSettings(profile, nextUrl) {
    return profile?.siteAdapter === 'nol-gate' && !profile.frameUrl && isNolGateUrl(profile.url) && isNolGateUrl(nextUrl);
  }
  function nolPageNotice(profile, value) {
    if (profile?.siteAdapter !== 'nol-gate') return '';
    try {
      const url = httpUrl(value);
      if (url.origin === 'https://tickets.interpark.com' && /^\/onestop\/seat\/?$/.test(url.pathname)) {
        return '이미 좌석 선택 화면으로 이동했습니다. 예매 대기 버튼 감시는 시작하지 않습니다. 이후 절차는 직접 진행하세요.';
      }
    } catch {}
    return '';
  }
  function capturePageMatches(profile, nextUrl) {
    // Import intentionally replaces the query; run-time matching still uses exactSearch.
    return canReuseNolGateSettings(profile, nextUrl) || pageMatches(profile?.url, nextUrl);
  }
  function applyTabCapture(input, captured, index = 0) {
    if (!captured || !capturePageMatches(input, captured.url)) throw new Error('현재 프로필과 다른 사이트입니다. 해당 사이트 프로필을 선택하세요.');
    if (!Array.isArray(captured.buttons) || captured.buttons.length > 20 || !Number.isInteger(index) || index < 0 || index >= captured.buttons.length) {
      throw new Error('가져올 예매 버튼을 선택하세요.');
    }
    const frameUrl = captured.frameUrl ? httpUrl(captured.frameUrl).origin : '';
    if ((input.frameUrl ? httpUrl(input.frameUrl).origin : '') !== frameUrl) throw new Error('클릭 문서가 달라졌습니다. 프레임 설정을 확인하세요.');
    const button = captured.buttons[index], p = clone(input);
    p.url = httpUrl(captured.url).href; p.frameUrl = frameUrl;
    p.scopeSelector = text(button.scopeSelector, '확인한 관찰 영역', true);
    p.steps[0].selector = text(button.selector, '확인한 버튼 Selector', true);
    p.steps[0].buttonText = text(button.text, '확인한 버튼 문구', true);
    p.steps[0].bindButtonText = true;
    // This marker comes only from read-only capture of the verified NOL structure.
    // Keep the displayed label for diagnostics; it is no longer a countdown identity.
    if (p.siteAdapter === 'nol-gate' && !frameUrl && button.nolPrimary === true) p.steps[0].nolPrimary = true;
    else delete p.steps[0].nolPrimary;
    if (p.siteAdapter === 'nol-gate') p.steps[0].name = 'NOL 예매 버튼 활성화 대기';
    return validateProfile(p);
  }
  function numeric(value, label, min, max, integer = false) {
    const n = Number(value);
    if (value === '' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw new Error(`${label}: ${min}~${max}${integer ? ' 정수' : ''} 범위를 입력하세요.`);
    }
    return n;
  }
  function text(value, label, required = false) {
    const s = typeof value === 'string' ? value.trim() : '';
    if ((required && !s) || s.length > 2000) throw new Error(`${label}을 확인하세요.`);
    return s;
  }
  function newProfile(id = crypto.randomUUID()) {
    return {id, name: '새 사이트', url: '', exactSearch: false, frameUrl: '', scopeSelector: '', safetySelectors: [],
      steps: [{name: '예매', selector: '', readySelector: '', event: 'click', timeoutMs: 15000,
        verify: {kind: 'appeared', selector: '', value: '', timeoutMs: 10000}}],
      settings: {mode: 'activation', clickMethod: 'javascript', scheduledAt: null, prepareSeconds: 30, pollingMs: 0, count: 1,
        delaySeconds: 3, maxRuntimeSeconds: 600, testMode: true}};
  }
  function defaultProfile() {
    const p = newProfile('claude-practice');
    Object.assign(p, {name: 'Claude 예매 반응 연습', url: INITIAL_URL, frameUrl: FRAME_ORIGIN,
      scopeSelector: '.screen', safetySelectors: ['#queue', '#cap', '#retryBtn']});
    p.steps = [{name: '예매 활성화 후 한 번 누르기', selector: '#bookBtn', readySelector: '#bookBtn.on',
      event: 'pointerdown', timeoutMs: 15000,
      verify: {kind: 'textChanged', selector: '#result', value: '', timeoutMs: 10000}}];
    return p;
  }
  /* Legacy schedule scanning/selection disabled in 2.1.4: user selects the gate manually.
  function nolProfile() {
    const p = newProfile('nol-postseason');
    p.settings.prepareSeconds = 60;
    Object.assign(p, {name: 'NOL 포스트시즌', siteAdapter: 'nol-postseason', url: NOL_URL,
      scopeSelector: 'section[id^="GOODS_RESERVATION-"]',
      safetySelectors: ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]']});
    p.steps = [{name: '선택한 경기 예매하기', selector: 'button.grid-area_cta', buttonText: '예매하기',
      containerSelector: 'div:has(> .grid-area_info):has(> button.grid-area_cta)', targetText: '',
      readySelector: 'button:not(:disabled):not([aria-disabled="true"])', event: 'click', timeoutMs: 60000,
      verify: {kind: 'newContext', selector: '', value: '', timeoutMs: 15000}}];
    return p;
  }
  */
  function nolProfile() {
    const p = newProfile('nol-postseason');
    p.settings.prepareSeconds = 60;
    Object.assign(p, {name: 'NOL 티켓', siteAdapter: 'nol-gate', url: NOL_URL,
      // Parent DOM was not supplied; observe the confirmed button itself.
      scopeSelector: 'button._primary_2p3w6_7:has(> span._content_2p3w6_38)',
      safetySelectors: ['[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]', 'div._content_b5a9t_72']});
    p.steps = [{name: '10/14 09:00 예매 버튼 활성화 대기', selector: 'button._primary_2p3w6_7',
      buttonText: '10/14 09:00 예매하기', containerSelector: '', targetText: '',
      readySelector: 'button._primary_2p3w6_7:not(:disabled):not([aria-disabled="true"]):not(._disabled_2p3w6_34)',
      event: 'click', timeoutMs: 60000,
      verify: {kind: 'newContext', selector: '', value: '', timeoutMs: 15000}}];
    return p;
  }
  function practicketProfile() {
    const p = newProfile('practicket-n-ticket');
    p.settings.prepareSeconds = 60;
    Object.assign(p, {name: 'Practicket N-Ticket 연습', siteAdapter: 'practicket-n-ticket',
      url: PRACTICKET_URL, scopeSelector: 'div.nt-gate', safetySelectors: ['#pkt-alert-overlay']});
    p.steps = [{name: 'Practicket 예매 버튼 활성화 대기', selector: '#bookBtn',
      readySelector: '#bookBtn:not(:disabled):not([aria-disabled="true"])', event: 'click', timeoutMs: 60000,
      verify: {kind: 'newContext', selector: '', value: '', timeoutMs: 15000}}];
    return p;
  }
  function validateProfile(input) {
    const p = clone(input);
    p.id = text(p.id, '프로필 ID', true); p.name = text(p.name, '프로필 이름', true);
    p.url = httpUrl(p.url).href; p.exactSearch = !!p.exactSearch;
    p.frameUrl = text(p.frameUrl, '프레임 URL');
    if (p.frameUrl) {
      const f = httpUrl(p.frameUrl);
      if (f.search || f.hash || f.pathname !== '/') throw new Error('프레임 URL에는 정확한 origin(https://호스트)만 입력하세요.');
      p.frameUrl = f.origin;
    }
    p.scopeSelector = text(p.scopeSelector, '관찰 영역 Selector', true);
    p.siteAdapter = text(p.siteAdapter, '사이트 종류');
    if (!Array.isArray(p.safetySelectors) || p.safetySelectors.length > 20) throw new Error('안전 종료 Selector는 최대 20개입니다.');
    p.safetySelectors = p.safetySelectors.map(s => text(s, '안전 종료 Selector', true));
    if (!Array.isArray(p.steps) || !p.steps.length || p.steps.length > 20) throw new Error('클릭 단계는 1~20개입니다.');
    for (const step of p.steps) {
      step.name = text(step.name, '단계 이름', true);
      step.selector = text(step.selector, '클릭 Selector', true);
      step.readySelector = text(step.readySelector, '추가 활성 조건 Selector');
      step.containerSelector = text(step.containerSelector, '경기 컨테이너 Selector');
      step.targetText = text(step.targetText, '경기 식별 텍스트');
      step.buttonText = text(step.buttonText, '버튼 텍스트');
      if (step.bindButtonText !== undefined) step.bindButtonText = !!step.bindButtonText;
      if (step.nolPrimary !== undefined) {
        step.nolPrimary = step.nolPrimary === true;
        if (step.nolPrimary && (p.siteAdapter !== 'nol-gate' || p.frameUrl)) throw new Error('NOL 버튼 구조 감시는 NOL 대기 화면 최상위 문서에서만 사용합니다.');
      }
      if (step.targetText && !step.containerSelector) throw new Error('경기 식별 텍스트에는 컨테이너 Selector가 필요합니다.');
      if (!['click', 'pointerdown'].includes(step.event)) throw new Error('이벤트는 click 또는 pointerdown입니다.');
      step.timeoutMs = numeric(step.timeoutMs, '버튼 대기(ms)', 100, 300000, true);
      const v = step.verify;
      if (!v || !['appeared', 'disappeared', 'textChanged', 'textIncludes', 'attributeEquals', 'newContext'].includes(v.kind)) {
        throw new Error('모든 단계에 완료 검증 조건이 필요합니다.');
      }
      v.selector = text(v.selector, '완료 Selector', v.kind !== 'newContext'); v.value = text(v.value, '완료 값');
      v.attribute = text(v.attribute, '완료 속성');
      if (v.kind === 'textIncludes' && !v.value) throw new Error('완료 텍스트를 입력하세요.');
      if (v.kind === 'attributeEquals' && !v.attribute) throw new Error('검증 속성을 입력하세요.');
      v.timeoutMs = numeric(v.timeoutMs, '완료 대기(ms)', 100, 300000, true);
    }
    const s = p.settings;
    if (!s || !['hybrid', 'activation'].includes(s.mode)) throw new Error('실행 방식을 확인하세요.');
    s.clickMethod ??= 'javascript';
    if (!['javascript','cdp'].includes(s.clickMethod)) throw new Error('클릭 실행 방식은 JavaScript 또는 CDP입니다.');
    s.prepareSeconds = numeric(s.prepareSeconds, '사전 준비(초)', 0, 3600);
    s.pollingMs = numeric(s.pollingMs, '보완 폴링(ms)', 0, 2000, true);
    if (s.pollingMs !== 0 && s.pollingMs < 50) throw new Error('보완 폴링은 0(끄기) 또는 50~2000ms입니다.');
    s.count = numeric(s.count, '반복 횟수', 0, 10000, true);
    s.delaySeconds = numeric(s.delaySeconds, '반복 대기(초)', 0.5, 30);
    s.maxRuntimeSeconds = numeric(s.maxRuntimeSeconds, '감시 시작 후 최대 실행(초)', 1, 7200);
    s.testMode = !!s.testMode;
    if (p.steps.some(step => step.verify.kind === 'newContext') && (p.steps.length !== 1 || s.count !== 1)) {
      throw new Error('새 창/화면 이동 확인은 한 단계·한 번 실행만 지원합니다. 이후 절차는 직접 진행하세요.');
    }
    if (s.scheduledAt !== null) s.scheduledAt = numeric(s.scheduledAt, '예약 시각', 0, 8640000000000000, true);
    return p;
  }
  function validateForRun(input) {
    const p = validateProfile(input);
    /* Legacy schedule selection disabled in 2.1.4.
    if (p.siteAdapter === 'nol-postseason') {
      if (!pageMatches(p.url, NOL_URL) || p.frameUrl) throw new Error('NOL 프로필은 확인한 포스트시즌 최상위 문서에서만 실행합니다.');
      if (!p.steps[0].targetText.trim()) throw new Error('NOL 경기 목록을 불러와 예매할 경기를 선택하세요.');
      if (!p.steps[0].containerSelector) throw new Error('NOL 경기 컨테이너 Selector가 필요합니다.');
    }
    */
    if (p.siteAdapter === 'nol-postseason') throw new Error('이전 NOL 경기 목록 프로필은 비활성화되었습니다. 새 대기 화면 프로필을 사용하세요.');
    if (p.siteAdapter === 'nol-gate' && (!isNolGateUrl(p.url) || p.frameUrl)) {
      throw new Error('NOL 티켓은 https://tickets.interpark.com/gates/ticket/상품번호 형태의 대기 화면 최상위 문서에서 실행합니다.');
    }
    if (p.siteAdapter === 'practicket-n-ticket' && (!pageMatches(p.url, PRACTICKET_URL) || p.frameUrl)) {
      throw new Error('Practicket 프로필은 확인한 N-Ticket intro 최상위 문서에서만 실행합니다.');
    }
    return p;
  }
  function permissionsFor(p) {
    return [...new Set([originPattern(p.url), ...(p.frameUrl ? [originPattern(p.frameUrl)] : [])])];
  }
  function selectFrame(frames, p) {
    if (!p.frameUrl) return frames.find(f => f.frameId === 0);
    const matches = frames.filter(f => f.frameId !== 0 && (() => {
      try { return httpUrl(f.url).origin === p.frameUrl; } catch { return false; }
    })());
    if (matches.length !== 1) throw new Error(`프레임 origin과 일치하는 iframe이 ${matches.length}개입니다. 정확히 하나여야 합니다. DOM/권한을 확인하세요.`);
    return matches[0];
  }
  root.TicketConfig = {INITIAL_URL, FRAME_ORIGIN, NOL_URL, NOL_LEGACY_URL, PRACTICKET_URL, ACTIVE, clone, currentMinute, httpUrl, originPattern, pageMatches,
    isNolGateUrl, canReuseNolGateSettings, nolPageNotice, capturePageMatches, applyTabCapture,
    newProfile, defaultProfile, nolProfile, practicketProfile, validateProfile, validateForRun, permissionsFor, selectFrame,
    isActive: run => !!run && ACTIVE.includes(run.status)};
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TicketConfig;
})(globalThis);
