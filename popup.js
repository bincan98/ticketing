'use strict';
const C = TicketConfig, $ = id => document.getElementById(id);
const BUTTON_WAIT_MS = 120000;
let profiles = [], activeId = '', run = null, busy = false, scheduledTimeIsDefault = true, generatedScheduledAt = null;
let pendingCapture = null, pageAnalysis = null, currentTab = null, tabContextRevision = 0;
const message = async request => {
  const result = await chrome.runtime.sendMessage(request);
  if (result && 'currentTab' in result) { currentTab=result.currentTab;renderTabContext(); }
  if (!result?.success) throw new Error(result?.error || '확장 프로그램 응답이 없습니다.');
  return result;
};
function showStatus(text, type = 'info') { $('status').textContent = text; $('status').className = type; }
function showPreparation(text, type = 'info') {
  $('preparationStatus').textContent = text ? '실행 준비 · ' + text : ''; $('preparationStatus').className = 'notice ' + type; $('preparationStatus').hidden = !text;
}
function showSaveStatus(text, type = 'info') {
  $('saveStatus').textContent = text ? '저장 결과 · ' + text : ''; $('saveStatus').className = 'notice ' + type; $('saveStatus').hidden = !text;
}
function renderTabContext() {
  const lines=[currentTab ? `현재 탭 #${currentTab.id}: ${currentTab.url || '주소를 읽을 수 없음'}` : '예매 사이트 탭에서 확장 프로그램을 열어 주세요.'];
  if(run?.tabId)lines.push(`${C.isActive(run)?'감시 중인':'최근 실행한'} 탭 #${run.tabId}: ${run.topUrl || run.profile?.url || ''}`);
  if(C.isActive(run) && currentTab?.id!==run.tabId)lines.push('다른 탭을 감시하고 있습니다. 아래 가져오기 버튼으로 이전 감시를 중지한 뒤 현재 탭을 읽을 수 있습니다.');
  $('tabContext').textContent=lines.join('\n');
}
function captureScheduledEdit() {
  if (scheduledTimeIsDefault && generatedScheduledAt !== null && new Date($('scheduledAt').value).getTime() !== generatedScheduledAt) {
    scheduledTimeIsDefault = false;
    generatedScheduledAt = null;
  }
}
function updateExecutionMode() {
  captureScheduledEdit();
  const scheduled = $('mode').value === 'hybrid';
  $('scheduleSettings').hidden = !scheduled;
  $('scheduledAt').disabled = !scheduled;
  if (scheduled && scheduledTimeIsDefault) {
    generatedScheduledAt = C.currentMinute();
    $('scheduledAt').value = localDateInput(generatedScheduledAt);
  }
  updateTimingHint();
}
function updateTimingHint() {
  const prepare = Number($('prepareSeconds').value);
  const timeout = BUTTON_WAIT_MS / 1000;
  $('timingHint').textContent = $('mode').value === 'hybrid' ?
    `예약 ${prepare}초 전부터 감시 · 클릭은 예약 시각부터 · 예약 후 버튼 대기 최대 ${timeout}초` :
    `시작 즉시 감시 · 버튼 대기 최대 ${timeout}초`;
}
function statusType(run) {
  return !run || C.isActive(run) || ['handoff','stopped'].includes(run.status) ? 'info' : ['completed','tested'].includes(run.status) ? 'success' : 'error';
}
function updateButtonState() {
  const running = C.isActive(run);
  $('analyzePage').disabled = running || busy;
  $('copyAnalysis').disabled = busy || !pageAnalysis;
  $('start').disabled = running || busy; $('stop').disabled = !running;
  $('configuration').disabled = running || busy;
  $('advancedConfiguration').disabled = running || busy;
  $('captureTab').disabled = busy;
  $('captureTab').textContent = running ? '감시 중지 후 현재 탭 가져오기' : '현재 탭에서 URL·예매 버튼 가져오기';
  $('clearLog').disabled = running || busy;
  $('start').textContent = '실제 클릭 시작 ▶';
}
async function action(fn, channel = 'status') {
  busy = true; updateButtonState();
  try { await fn(); } catch (e) {
    (channel === 'preparation' ? showPreparation : channel === 'save' ? showSaveStatus : showStatus)(e.message, 'error');
  }
  finally { busy = false; updateButtonState(); }
}

function clearAnalysis() {
  pageAnalysis = null; $('analysisResult').hidden = true;
  $('analysisButtons').replaceChildren(); $('analysisFrames').replaceChildren();
}
function renderAnalysis(result) {
  pageAnalysis = result;
  $('analysisResult').hidden = false;
  $('analysisUrl').textContent = result.url;
  $('analysisSummary').textContent = result.buttons.length + '개 버튼 · ' + result.frames.length + '개 문서 · ' +
    (result.partial ? '일부 누락 또는 확인 제한 있음' : '접근 가능한 문서 분석 완료') +
    ' · ' + new Date(result.capturedAt).toLocaleTimeString('ko-KR', {hour12: false});
  $('analysisButtons').replaceChildren(...result.buttons.map(button => {
    const row = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = (button.text || '(표시 글자 없음)' + (button.accessibleLabel ? ' · 접근성 이름: ' + button.accessibleLabel : '')) +
      ' · ' + (button.disabled ? '비활성' : '활성') + (button.inViewport ? '' : ' · 화면 밖');
    const detail = document.createElement('div'); detail.className = 'hint';
    detail.textContent = 'frame ' + button.frameId + ' · ' + button.frameUrl + '\n' + button.path +
      (button.disabledReasons.length ? '\n사유: ' + button.disabledReasons.join(', ') : '') +
      (button.shadow ? '\nShadow DOM: ' + button.shadow : '');
    row.append(label, detail); return row;
  }));
  $('analysisFrames').replaceChildren(...result.frames.map(frame => {
    const row = document.createElement('li');
    row.textContent = 'frame ' + frame.frameId + ' · ' + frame.url + ' · ' +
      ({analyzed: '분석 완료', hidden: '숨겨진 문서 제외', inaccessible: '접근 불가/누락'}[frame.status] || frame.status) +
      (frame.reason ? '\n' + frame.reason : '') +
      (frame.coverage ? '\nShadow 루트 ' + frame.coverage.shadowRoots + '개 (closed ' + frame.coverage.closedShadowRoots + '개) · 숨겨진 버튼 ' + frame.coverage.hiddenButtons + '개 제외' : '') +
      (frame.warnings?.length ? '\n' + frame.warnings.join('\n') : '');
    return row;
  }));
  $('analysisNotes').textContent = [...result.warnings, ...result.notes].join('\n');
}

function visibleProfiles() {
  return profiles.filter(p => p.id !== 'practicket-n-ticket' && p.siteAdapter !== 'practicket-n-ticket')
    .sort((a,b) => Number(b.id === 'nol-postseason') - Number(a.id === 'nol-postseason'));
}
function renderProfiles() {
  $('profile').replaceChildren(...visibleProfiles().map(p => {
    const option = document.createElement('option'); option.value = p.id;
    option.textContent = p.id === 'nol-postseason' ? 'NOL 티켓 (기본)' : p.id === 'claude-practice' ? 'Claude 예매 반응 (연습)' : p.name;
    return option;
  })); $('profile').value = activeId;
}
function localDateInput(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23);
}
function renderSteps(steps) {
  $('steps').replaceChildren();
  for (const [index, step] of steps.entries()) {
    const card = $('stepTemplate').content.firstElementChild.cloneNode(true);
    card.dataset.bindButtonText = String(!!step.bindButtonText);
    card.dataset.nolPrimary = String(step.nolPrimary === true);
    card.querySelector('.step-number').textContent = `단계 ${index + 1}`;
    for (const input of card.querySelectorAll('[data-field]')) {
      const [key, nested] = input.dataset.field.split('.'); input.value = key === 'timeoutMs' ? BUTTON_WAIT_MS : (nested ? step[key][nested] : step[key]) ?? '';
    }
    for (const button of card.querySelectorAll('button')) button.addEventListener('click', () => {
      const list = readSteps();
      if (button.hasAttribute('data-remove')) { if (list.length > 1) list.splice(index, 1); }
      else { const dest = index + Number(button.dataset.move); if (dest >= 0 && dest < list.length) [list[index], list[dest]] = [list[dest], list[index]]; }
      renderSteps(list);
    });
    $('steps').append(card);
  }
  updateTimingHint();
}
function readSteps() {
  return [...$('steps').children].map(card => {
    const step = {verify: {}};
    if (card.dataset.bindButtonText === 'true') step.bindButtonText = true;
    if (card.dataset.nolPrimary === 'true') step.nolPrimary = true;
    for (const input of card.querySelectorAll('[data-field]')) {
      const [key, nested] = input.dataset.field.split('.');
      const value = input.type === 'number' ? Number(input.value) : input.value;
      if (nested) step[key][nested] = value; else step[key] = value;
    } step.timeoutMs = BUTTON_WAIT_MS; return step;
  });
}
function clearCapture() {
  pendingCapture = null; $('captureChoices').hidden = true;
  $('captureChoice').replaceChildren(); $('capturedSummary').hidden = true;
}
function applyCapture(captured, index = 0, profile = readProfile(false)) {
  const p = C.applyTabCapture(profile, captured, index);
  clearCapture(); fillProfile(p);
  const button = captured.buttons[index];
  const waitNote = p.settings.mode === 'activation' && button.nolPrimary === true && button.remainingSeconds > BUTTON_WAIT_MS/1000 ?
    ' · 남은 시간이 2분보다 깁니다. 오픈 2분 이내에 시작하거나 예약 시각을 설정하세요. 현재 감시는 최대 2분 후 종료됩니다.' : '';
  $('capturedSummary').textContent = `가져온 버튼: ${p.steps[0].buttonText}` + waitNote;
  $('capturedSummary').hidden = false;
  showPreparation('현재 페이지 정보 수집 완료 · 실제 클릭 시작을 누르면 다시 확인하고 실행합니다.', 'success');
  return {profile:p,captureTarget:captured.target,waitNote};
}
async function captureCurrentSite(intent = 'capture') {
  clearCapture();
  const profileId = activeId, profile = readProfile(false), profileKey = JSON.stringify(profile), tabRevision=tabContextRevision;
  const result = await message({action:'captureCurrentTab',profile});
  if (activeId !== profileId || C.isActive(run) || JSON.stringify(readProfile(false)) !== profileKey) throw new Error('수집 중 설정이나 실행 상태가 변경되었습니다. 다시 시작하세요.');
  const captured = result.captured;
  if (tabRevision!==tabContextRevision || captured?.target && currentTab && captured.target.tabId!==currentTab.id) throw new Error('수집 중 활성 탭이 변경되었습니다. 현재 탭에서 다시 가져오세요.');
  if (!captured?.buttons?.length) throw new Error('현재 화면에서 예매 버튼을 찾지 못했습니다.');
  if (captured.buttons.length === 1) return applyCapture(captured,0,profile);
  pendingCapture = {profileId,captured,profile,profileKey,intent};
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '가져올 예매 버튼을 선택하세요';
  $('captureChoice').replaceChildren(placeholder, ...captured.buttons.map((button,index) => {
    const option = document.createElement('option'); option.value = String(index);
    option.textContent = `${index + 1}. ${button.contextText || button.text} · ${button.disabled ? '비활성' : '활성'}`;
    return option;
  }));
  $('captureChoices').hidden = false;
  $('applyCapture').textContent = intent === 'start' ? '선택한 버튼으로 감시 시작' : '선택한 버튼 가져오기';
  showPreparation(`${captured.buttons.length}개 버튼을 찾았습니다. 감시할 버튼을 선택하세요. 선택 전에는 실행하지 않습니다.`);
  return null;
}
async function captureWithAccessCheck() {
  if (!await chrome.permissions.contains({origins:C.permissionsFor(readProfile(false))})) {
    clearCapture();
    showPreparation('처음 사용 시 실제 클릭 시작을 눌러 사이트 접근을 허용하세요. 권한 승인 후 페이지 정보를 다시 수집합니다.');
    return;
  }
  return captureCurrentSite();
}
async function manualCaptureCurrentTab() {
  const context=await message({action:'getTabContext'});run=context.run;renderTabContext();
  if(C.isActive(run)) {
    await message({action:'stopMacro'});run=(await message({action:'getStatus'})).run;
    if(C.isActive(run))throw new Error('이전 감시를 중지하지 못했습니다. 중지 상태를 확인한 뒤 다시 가져오세요.');
    showStatus(run?.message || '이전 감시를 중지했습니다.',statusType(run));
  }
  await captureWithAccessCheck();renderTabContext();
}
async function applyPendingCapture() {
  const pending = pendingCapture, choice = $('captureChoice').value;
  if (!pending || pending.profileId !== activeId || choice === '') throw new Error('감시할 버튼을 선택하세요.');
  if (pending.profileKey !== JSON.stringify(readProfile(false))) throw new Error('버튼 선택 중 설정이 변경되었습니다. 다시 가져오거나 실제 클릭 시작을 누르세요.');
  const selected = pending.captured.buttons[Number(choice)];
  if (!selected) throw new Error('선택한 버튼이 없습니다. 다시 수집하세요.');
  // Selection may take time: reread the document instead of using an old candidate.
  const {captured} = await message({action:'captureCurrentTab',profile:pending.profile});
  if (JSON.stringify(captured.target) !== JSON.stringify(pending.captured.target)) throw new Error('버튼 선택 중 페이지가 변경되었습니다. 다시 시작하세요.');
  const indexes = captured.buttons.map((button,index) => ({button,index})).filter(({button}) =>
    button.selector === selected.selector && button.scopeSelector === selected.scopeSelector &&
      (button.text === selected.text || pending.profile.siteAdapter === 'nol-gate' && button.nolPrimary === true && selected.nolPrimary === true));
  if (indexes.length !== 1) throw new Error('선택한 버튼이 변경되었습니다. 다시 수집해 선택하세요.');
  const prepared = applyCapture(captured,indexes[0].index,pending.profile);
  if (pending.intent === 'start') await startPrepared(prepared);
}
function fillProfile(p) {
  clearCapture();
  $('siteUrl').value = p.url; $('exactSearch').checked = p.exactSearch;
  $('profileHelp').hidden = !['practicket-n-ticket', 'nol-gate'].includes(p.siteAdapter);
  $('profileHelp').textContent = p.siteAdapter === 'practicket-n-ticket' ?
    '사이트의 닉네임 안내를 먼저 처리하세요. 확장 감시를 시작한 뒤 사이트의 연습 시작하기를 직접 누르세요.' :
    p.siteAdapter === 'nol-gate' ? '공연·경기의 대기 화면을 열고 위 가져오기 버튼을 누르면 주소와 버튼 문구를 채웁니다. 로그인·일정 선택은 직접 진행하세요.' : '';
  $('frameUrl').value = p.frameUrl; $('scope').value = p.scopeSelector;
  $('safety').value = p.safetySelectors.join('\n'); renderSteps(p.steps);
  const s = p.settings;
  $('mode').value = s.mode || 'activation';
  scheduledTimeIsDefault = s.scheduledAt == null;
  generatedScheduledAt = scheduledTimeIsDefault ? C.currentMinute() : null;
  $('scheduledAt').value = localDateInput(s.scheduledAt ?? generatedScheduledAt);
  $('prepareSeconds').value = s.prepareSeconds;
  /* Legacy schedule scanning/selection disabled in 2.1.4.
  $('nolControls').hidden = p.siteAdapter !== 'nol-postseason';
  $('nolGame').replaceChildren();
  const option = document.createElement('option'); option.value = p.steps[0].targetText || '';
  option.textContent = option.value ? option.value.replace(/\n/g, ' · ') : '현재 탭 경기 목록을 불러와 선택하세요';
  $('nolGame').append(option);
  $('nolSelection').textContent = p.steps[0].targetText ? `선택: ${p.steps[0].targetText.replace(/\n/g, ' · ')}` : '경기를 선택해야 실행할 수 있습니다.';
  */
  updateExecutionMode();
  updateButtonState();
}
function readProfile(validate = true) {
  captureScheduledEdit();
  const existing = profiles.find(profile => profile.id === activeId);
  const steps = readSteps(), prepareSeconds = Number($('prepareSeconds').value);
  // A stored short runtime must not cut off the new two-minute activation wait.
  const neededRuntime = ($('mode').value === 'hybrid' ? prepareSeconds : 0) +
    steps.reduce((seconds,step) => seconds + (BUTTON_WAIT_MS + Number(step.verify.timeoutMs)) / 1000, 0) + 1;
  const maxRuntimeSeconds = Math.min(7200,Math.max(existing?.settings?.maxRuntimeSeconds || 600,neededRuntime));
  const p = {id: activeId, siteAdapter: existing?.siteAdapter || '', name: existing?.name || '예매 설정', url: $('siteUrl').value, exactSearch: $('exactSearch').checked,
    frameUrl: $('frameUrl').value, scopeSelector: $('scope').value,
    safetySelectors: $('safety').value.split('\n').map(s => s.trim()).filter(Boolean), steps,
    settings: {mode: $('mode').value, scheduledAt: $('mode').value === 'activation' && scheduledTimeIsDefault ? null : $('scheduledAt').value ? new Date($('scheduledAt').value).getTime() : null,
      prepareSeconds, pollingMs: existing?.settings?.pollingMs ?? 0,
      count: 1, delaySeconds: existing?.settings?.delaySeconds ?? 3, maxRuntimeSeconds, testMode: false, clickMethod: 'cdp'}};
  return validate ? C.validateProfile(p) : p;
}
function captureDraft() { const i = profiles.findIndex(p => p.id === activeId); if (i >= 0) profiles[i] = readProfile(false); }
function selectSite() {
  if (busy || C.isActive(run)) { $('profile').value = activeId; return; }
  const selected = profiles.find(profile => profile.id === $('profile').value);
  if (!selected) { $('profile').value = activeId; showStatus('선택한 사이트를 찾을 수 없습니다.', 'error'); return; }
  const previousId = activeId;
  captureDraft(); activeId = selected.id; fillProfile(selected);
  return action(async () => {
    try {
      await message({action:'selectProfile',profileId:selected.id});
      showSaveStatus('선택한 사이트를 자동 저장했습니다.', 'success');
    } catch (error) {
      activeId = previousId; renderProfiles(); fillProfile(profiles.find(profile => profile.id === previousId));
      throw new Error('사이트 선택 저장 실패: ' + error.message);
    }
    await captureWithAccessCheck();
  }, 'preparation');
}
function permissionRequest(p) {
  // Called synchronously from the click listener: Chrome requires a user gesture.
  return chrome.permissions.request({origins: C.permissionsFor(p)});
}
async function save(p) {
  const next = profiles.map(existing => existing.id === p.id ? p : existing);
  await message({action: 'saveProfiles', profiles: next, activeProfileId: p.id});
  profiles = next; scheduledTimeIsDefault = p.settings.scheduledAt == null; renderProfiles();
}
async function startPrepared(prepared) {
  const p = C.validateForRun(prepared.profile);
  if (p.settings.mode === 'hybrid' && (!p.settings.scheduledAt || p.settings.scheduledAt <= Date.now())) throw new Error('미래의 예약 시각을 입력하세요.');
  showPreparation('수집한 페이지와 감시 조건을 확인하는 중…');
  await message({action:'validatePreparedStart',profile:p,captureTarget:prepared.captureTarget});
  await save(p);
  showSaveStatus('현재 페이지에 맞춘 설정을 저장했습니다.', 'success');
  await message({action:'startMacro',captureTarget:prepared.captureTarget,expectedProfile:p});
  run = (await message({action:'getStatus'})).run;
  showPreparation('권한·페이지·감시 조건 확인 완료' + (prepared.waitNote || ''), 'success');
  showStatus(run?.message || '실행 시작',statusType(run));
}
function startWithPreparation() {
  if (busy || C.isActive(run)) return;
  let granted;
  try {
    // Keep the permission request directly in the user's click, before any await.
    granted = permissionRequest(readProfile());
  } catch (e) { showPreparation(e.message,'error'); return; }
  action(async () => {
    showPreparation('사이트 접근 권한 확인 중…');
    if (!await granted) throw new Error('사이트 접근이 허용되지 않았습니다. 실제 클릭 시작을 눌러 권한을 허용하세요. 설정과 실행 상태는 변경하지 않았습니다.');
    showPreparation('권한 확인 완료 · 현재 페이지 정보를 새로 수집하는 중…');
    const prepared = await captureCurrentSite('start');
    if (prepared) await startPrepared(prepared);
  }, 'preparation');
}
function saveSettings() {
  if (busy || C.isActive(run)) return;
  action(async () => { await save(readProfile()); showSaveStatus('설정을 저장했습니다. 사이트 접근 권한은 실제 클릭 시작에서 확인합니다.','success'); }, 'save');
}
function loadLogs(logs = []) {
  const box = $('logBox'); box.replaceChildren();
  for (const entry of logs) {
    const div = document.createElement('div'); div.className = `log-entry log-${['info','error','warning','success'].includes(entry.type) ? entry.type : 'info'}`;
    const time = document.createElement('span'); time.className = 'log-time';
    time.textContent = `[${new Date(entry.timestamp).toLocaleTimeString('ko-KR', {hour12: false})}.${String(entry.timestamp % 1000).padStart(3, '0')}] `;
    div.append(time, document.createTextNode(entry.message)); box.append(div);
  }
  box.scrollTop = box.scrollHeight;
  const timings=logs.filter(e=>e.event==='click-timing'&&Number.isFinite(e.clickLatencyMs));
  if(timings.length){
    const latest=timings.at(-1),same=timings.filter(e=>e.inputTimingSource===latest.inputTimingSource);
    const label=latest.inputTimingSource==='trusted-pointerdown'?'감지→실제 눌림':'감지→CDP 전송(근사)';
    $('performance').textContent=`${label}: 최근 ${latest.clickLatencyMs.toFixed(1)}ms · 평균 ${(same.reduce((n,e)=>n+e.clickLatencyMs,0)/same.length).toFixed(1)}ms (${same.length}건)`;
  }else{
    const attempts = logs.filter(e => typeof e.detectToAttemptMs === 'number');
    $('performance').textContent = attempts.length ? `감지→시도: 최근 ${attempts.at(-1).detectToAttemptMs.toFixed(3)}ms · 평균 ${(attempts.reduce((n,e)=>n+e.detectToAttemptMs,0)/attempts.length).toFixed(3)}ms (${attempts.length}건)` : '아직 클릭 시도 측정값이 없습니다.';
  }
}
async function downloadLog() {
  const {macroLogs = []} = await chrome.storage.local.get('macroLogs');
  const keys = ['time','timestamp','monotonicMs','event','runId','cycle','stepIndex','scheduledAt','actionableDetectedAt','actionableMonotonicMs','detectToAttemptMs','clickMethod','inputStartedAt','inputFinishedAt','detectToInputMs','zoomFactor','scheduledDeltaMs','source','message','type','pointerReason','pointerDetail','pointerRevision','pointerX','pointerY','phase',
    'buttonFound','buttonConnected','buttonReady','buttonText','buttonDisabled','buttonClass','buttonAriaDisabled','pointerState','pointerReady','pointerHasPosition',
    'lastPointerX','lastPointerY','monitorStartedAt','monitorEndedAt','monitorElapsedMs','gateAt','deadlineAt','diagnosticSource','observationCapturedAt','diagnosticJson',
    'repeatCount','firstErrorAt','lastErrorAt','preInputPersistMs','cdpRoundTripMs','claimPersistMs','cdpPreflightMs','pressCommandMs','afterPressCheckMs','releaseCommandMs',
    'observedPointerdownAt','observedPointerdownMonotonicMs','observedClickAt','activationToPointerdownMs','activationToClickMs','pointerReadyAt','pointerReadyMonotonicMs','pointerWaitMs','readyToPointerdownMs','clickLatencyMs','inputTimingSource','attemptId','preInputQueueMs'];
  const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = '\uFEFF' + keys.join(',') + '\r\n' + macroLogs.map(e => keys.map(k => escape(e[k])).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = `ticket-click-log-${new Date().toISOString().slice(0,10)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('analyzePage').addEventListener('click', () => action(async () => {
  clearAnalysis(); $('analysisStatus').textContent = '현재 탭의 URL과 버튼을 읽는 중…';
  try {
    const result = await message({action: 'analyzeCurrentPage'});
    renderAnalysis(result.analysis);
    $('analysisStatus').textContent = '분석 완료 · 페이지 버튼은 클릭하지 않았습니다.';
  } catch (e) { $('analysisStatus').textContent = '분석 실패: ' + e.message; throw e; }
}));
$('copyAnalysis').addEventListener('click', () => {
  if (!pageAnalysis) return;
  // Keep the clipboard request in this user gesture; no asynchronous messages before it.
  const text = TicketAnalysis.formatResult(pageAnalysis);
  action(async () => {
    try {
      await navigator.clipboard.writeText(text);
      $('analysisStatus').textContent = '전체 분석 결과(URL·버튼·상태·누락 사유)를 클립보드에 복사했습니다.';
    } catch (e) {
      $('analysisStatus').textContent = '복사 실패: ' + e.message + '. 복사 버튼을 다시 눌러 주세요.';
      throw new Error($('analysisStatus').textContent);
    }
  });
});

$('captureTab').addEventListener('click', () => action(manualCaptureCurrentTab, 'preparation'));
$('applyCapture').addEventListener('click', () => action(applyPendingCapture, 'preparation'));
$('start').addEventListener('click', startWithPreparation);
$('save').addEventListener('click', saveSettings);
$('stop').addEventListener('click', () => action(async () => {
  await message({action: 'stopMacro'}); run = (await message({action: 'getStatus'})).run; showStatus(run?.message || '중지 요청 완료');
}));
$('profile').addEventListener('change', selectSite);
/* Legacy schedule scanning/selection disabled in 2.1.4.
$('loadNolGames').addEventListener('click', () => {
  let p, granted;
  try { p = readProfile(); granted = permissionRequest(p); } catch(e) { showStatus(e.message, 'error'); return; }
  action(async () => {
    if (!(await granted)) throw new Error('NOL 사이트 접근 권한이 필요합니다.');
    const result = await message({action:'inspectFrames', profile:p});
    if (!result.report?.success) throw new Error(result.report?.error || '경기 목록을 읽지 못했습니다.');
    const games = result.report.candidates.filter(g => g.targetText);
    if (!games.length) throw new Error('확인한 경기 DOM이 없습니다. 페이지 로딩/Selector를 확인하세요.');
    const empty = document.createElement('option'); empty.value=''; empty.textContent='예매할 경기를 선택하세요';
    $('nolGame').replaceChildren(empty, ...games.map(game => {
      const option=document.createElement('option');option.value=game.targetText;
      option.textContent=`${game.label} · ${game.disabled ? '비활성' : '활성'}`;return option;
    }));
    $('nolGame').value = p.steps[0].targetText || '';
    showStatus(`${games.length}개 경기 확인. 원하는 경기를 선택하고 저장하세요.`, 'success');
  });
});
$('nolGame').addEventListener('change', () => {
  const steps=readSteps(); steps[0].targetText=$('nolGame').value; renderSteps(steps);
  $('nolSelection').textContent = steps[0].targetText ? `선택: ${steps[0].targetText.replace(/\n/g,' · ')}` : '경기를 선택해야 실행할 수 있습니다.';
});
*/
$('addStep').addEventListener('click', () => {
  const steps = readSteps(); if (steps.length >= 20) return;
  steps.push(C.newProfile().steps[0]); renderSteps(steps);
});
$('mode').addEventListener('change', updateExecutionMode);
for (const event of ['input','change']) $('scheduledAt').addEventListener(event, () => {
  scheduledTimeIsDefault = false; generatedScheduledAt = null;
});
$('prepareSeconds').addEventListener('input', updateTimingHint);
$('steps').addEventListener('input', event => {
  updateTimingHint();
  if (['selector', 'buttonText'].includes(event.target.dataset.field)) {
    const card=event.target.closest('.step-card');card.dataset.bindButtonText='false';card.dataset.nolPrimary='false';
  }
});
$('openSite').addEventListener('click', () => action(async () => { const url = C.httpUrl($('siteUrl').value).href; await chrome.tabs.create({url}); }));
$('siteUrl').addEventListener('change', () => {
  clearCapture();
  const original = profiles.find(p => p.id === activeId);
  if (original?.url && !C.pageMatches($('siteUrl').value, original.url, original.exactSearch)) {
    if (C.canReuseNolGateSettings(original, $('siteUrl').value)) {
      showStatus('NOL 상품 URL 변경: 버튼 설정을 유지했습니다. 해당 상품의 버튼 날짜·시간 문구를 수정하고 프레임 · Selector 확인 후 저장하세요.');
      return;
    }
    original.siteAdapter = ''; $('profileHelp').hidden = true;
    // $('nolControls').hidden = true; // Legacy schedule selector disabled in 2.1.4.
    $('frameUrl').value = ''; $('scope').value = ''; $('safety').value = '';
    renderSteps(C.newProfile().steps);
    showStatus('사이트 변경: 기존 DOM 설정을 비웠습니다. 프레임 확인/F12 검사 후 Selector를 입력하세요.');
  }
});
$('clearLog').addEventListener('click', () => action(async () => { await message({action: 'clearLogs'}); loadLogs([]); }));
$('downloadLog').addEventListener('click', () => action(downloadLog));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.macroRun) {
    run = changes.macroRun.newValue; updateButtonState();renderTabContext();
    if (run) showStatus(run.message, statusType(run));
  }
  if (changes.macroLogs) loadLogs(changes.macroLogs.newValue);
});
chrome.tabs.onActivated?.addListener(() => {
  tabContextRevision++;
  if(busy)return;
  clearCapture();
  message({action:'getTabContext'}).then(context=>{
    run=context.run;renderTabContext();updateButtonState();
    if(!C.isActive(run))showPreparation('활성 탭이 변경되었습니다. 현재 탭 가져오기 또는 실제 클릭 시작으로 새로 확인하세요.');
  }).catch(error=>showPreparation(error.message,'error'));
});
action(async () => {
  const data = await message({action: 'getSettings'});
  profiles = data.ticketProfiles; activeId = data.activeProfileId; run = data.run;currentTab=data.currentTab;
  renderTabContext();
  const visible = visibleProfiles();
  if (!visible.some(profile => profile.id === activeId) && visible.length && !C.isActive(run)) {
    activeId = visible[0].id;
    await message({action:'selectProfile',profileId:activeId});
  }
  renderProfiles(); fillProfile(profiles.find(p => p.id === activeId)); loadLogs(data.macroLogs);
  showStatus(run?.message || '준비 완료 · CDP 실제 입력 · 버튼 활성화 최대 2분 감시', statusType(run));
  if (!C.isActive(run)) {
    await captureWithAccessCheck();
  }
}, 'preparation');
