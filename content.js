/* Shared document detection and verification; optional CDP final input RPC. */
(() => {
  'use strict';
  if (globalThis.__ticketClickEngine) return;
  globalThis.__ticketClickEngine = true;
  const ATTRS = ['id', 'disabled', 'aria-disabled', 'class', 'style', 'hidden', 'inert', 'open', 'aria-hidden'];
  const ACTIVE = ['starting', 'scheduled', 'watching', 'verifying', 'repeat-wait', 'stopping'];
  const GENERIC_BLOCKERS = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]';
  const NOL_PRIMARY_SELECTOR = 'button._primary_2p3w6_7:has(> span._content_2p3w6_38)';
  const POINTER_HELP = '예매 버튼에 마우스를 이동해 주세요';
  const POINTER_REASONS = {'pointer-buttons':'마우스 버튼이 눌린 상태로 이동', 'pointer-left-document':'실행 문서 밖으로 마우스 이탈',
    'pointer-cancel':'브라우저가 포인터 취소', 'window-blur':'페이지 포커스 이탈', 'document-hidden':'페이지가 숨겨짐',
    scroll:'화면 스크롤', resize:'화면 크기 변경', 'window-focus-changed':'Chrome 창 포커스 변경', 'tab-changed':'활성 탭 변경',
    'viewport-changed':'화면 좌표 체계 변경', 'anchor-failed':'iframe·마우스 좌표 검증 실패',
    'anchor-rpc-failed':'마우스 좌표 확인 응답 실패', 'cdp-preflight':'CDP 입력 직전 좌표 검증 실패'};
  const viewportKey = () => JSON.stringify([scrollX,scrollY,innerWidth,innerHeight,devicePixelRatio,
    window.visualViewport?.scale,window.visualViewport?.offsetLeft,window.visualViewport?.offsetTop]);
  const pointerError = message => Object.assign(new Error(message), {waitForPointer:true});
  const documentToken = crypto.randomUUID();
  // CDP reads this only in this extension's isolated world, never in the page world.
  Object.defineProperty(globalThis, '__ticketCdpDocumentToken', {value: documentToken});
  let engine = null, saving = Promise.resolve();
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();

  const parentOf = node => node.assignedSlot || node.parentElement || node.getRootNode()?.host || null;
  function shadowOf(node) {
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
    return node.shadowRoot || (typeof chrome.dom?.openOrClosedShadowRoot === 'function' ? chrome.dom.openOrClosedShadowRoot(node) : null);
  }
  function findAll(selector, root = document) {
    const parts = selector.split('>>>').map(s => s.trim());
    if (parts.some(s => !s)) throw new Error('Shadow 경로는 host >>> 내부 Selector 형태여야 합니다.');
    if (parts.length === 1) return [...root.querySelectorAll(parts[0])];
    for (const part of parts) document.querySelectorAll(part);
    let roots = [root], nodes = [];
    for (let i = 0; i < parts.length; i++) {
      nodes = roots.flatMap(context => [...context.querySelectorAll(parts[i])]);
      if (i < parts.length - 1) roots = nodes.map(shadowOf).filter(Boolean);
    }
    return nodes;
  }
  const matches = (node, selector) => selector.includes('>>>') ? findAll(selector).includes(node) : node.matches(selector);
  function contains(parent, node) {
    if (parent === node || parent.contains(node)) return true;
    for (let current = node; current; current = parentOf(current)) if (current === parent) return true;
    return false;
  }
  function hitAt(doc, x, y) {
    let hit = doc.elementFromPoint(x, y);
    for (let i = 0; hit && i < 20; i++) {
      const inner = shadowOf(hit)?.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }
  // The configured button is an activation signal, not a restriction on CDP input.
  // Use the observed pointer verbatim without examining the element under it.
  function cdpPointerPoint(pointer) {
    if (!pointer || pointer.viewportKey!==viewportKey() || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y) ||
        pointer.x<0 || pointer.x>=innerWidth || pointer.y<0 || pointer.y>=innerHeight) throw pointerError('현재 페이지 안에서 마우스를 이동해 주세요. 위치가 기록되지 않았거나 화면이 변경되었습니다.');
    const local = {x:pointer.x,y:pointer.y};
    const visual = window.visualViewport;
    if (visual && (Math.abs(visual.scale-1)>0.001 || Math.abs(visual.offsetLeft)>0.001 || Math.abs(visual.offsetTop)>0.001)) throw new Error('pinch zoom/visual viewport 좌표 변환은 확인할 수 없습니다.');
    const viewport = {width:innerWidth,height:innerHeight,scrollX,scrollY};
    return {...local,viewport,space:window === window.top ? 'top' : 'frame',documentToken,documentUrl:location.href,pointerRevision:pointer.revision,viewportKey:pointer.viewportKey,
      signature:JSON.stringify([viewport,pointer.viewportKey,local.x,local.y,location.href,documentToken,pointer.revision])};
  }
  function shadowRoots(scope) {
    const roots = new Set();
    const outer = scope.getRootNode();
    if (outer instanceof ShadowRoot) roots.add(outer);
    const queue = [scope];
    while (queue.length) {
      const node = queue.pop(), root = shadowOf(node);
      if (root && !roots.has(root)) { roots.add(root); queue.push(...root.children); }
      queue.push(...node.children);
      if (roots.size > 100) throw new Error('Shadow 루트가 너무 많아 관찰 범위를 확인할 수 없습니다.');
    }
    return [...roots];
  }

  function candidateMatches(node, step, scope, boundTarget = null) {
    if (step.nolPrimary) {
      if (!node.matches(NOL_PRIMARY_SELECTOR)) return false;
      const label = normalize(node.textContent);
      if (node !== boundTarget && !label.includes('예매') && !/^남은\s*시간\s+\d{1,3}:[0-5]\d$/.test(label)) return false;
    } else if (step.buttonText && normalize(node.textContent) !== normalize(step.buttonText) && node !== boundTarget) return false;
    if (!step.targetText) return true;
    const container = node.closest(step.containerSelector);
    return !!container && contains(scope,container) && step.targetText.split('\n').map(normalize).filter(Boolean)
      .every(text => normalize(container.textContent).includes(text));
  }
  function candidates(step, scope, boundTarget = null) {
    // A confirmed button can itself be the smallest observation scope.
    const found = step.selector.includes('>>>') ? findAll(step.selector).filter(node => contains(scope,node)) : findAll(step.selector,scope);
    return [...new Set([...(scope instanceof Element && matches(scope,step.selector) ? [scope] : []), ...found])]
      .filter(node => candidateMatches(node,step,scope,boundTarget));
  }
  function targetFor(step, scope, boundTarget) {
    const nodes = candidates(step, scope, boundTarget);
    if (nodes.length > 1) throw new Error(`경기/Selector가 ${nodes.length}개에 일치합니다. 경기명과 날짜로 하나를 지정하세요: ${step.selector}`);
    return nodes[0] || null;
  }
  function unique(selector, root = document) {
    const nodes = findAll(selector,root);
    if (nodes.length > 1) throw new Error(`Selector가 ${nodes.length}개에 일치합니다: ${selector}`);
    return nodes[0] || null;
  }
  function shown(el, requirePointer = false) {
    if (!el?.isConnected) return false;
    for (let node = el; node?.nodeType === 1; node = parentOf(node)) {
      const style = getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' ||
          style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0 ||
          requirePointer && node===el && style.pointerEvents==='none') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function activationReady(el, step) {
    // Reject inactive candidates before reading computed styles or layout.
    if (!el?.isConnected || el.matches(':disabled') || el.disabled) return false;
    if (step.readySelector && !matches(el,step.readySelector)) return false;
    for (let node = el; node?.nodeType === 1; node = parentOf(node)) {
      if (node.getAttribute('aria-disabled')?.toLowerCase() === 'true') return false;
    }
    return shown(el,true);
  }
  function clickable(el, step) {
    if (!activationReady(el,step) || typeof el.click !== 'function') return false;
    // Hit-test visible part of the target; never scroll/focus on the click path.
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    if (right <= left || bottom <= top) return false;
    const x=(left+right)/2,y=(top+bottom)/2;
    const hit = hitAt(document,x,y);
    return !!hit && contains(el,hit);
  }
  function validateDOM(profile) {
    const selectors = [profile.scopeSelector, ...profile.safetySelectors, ...profile.steps.flatMap(s =>
      [s.selector, s.readySelector, s.containerSelector, s.verify.selector].filter(Boolean))];
    for (const selector of selectors) findAll(selector); // validates CSS and explicit Shadow paths
    unique(profile.scopeSelector);
    return {success: true};
  }
  class Engine {
    constructor(run) {
      this.run = JSON.parse(JSON.stringify(run));
      this.profile = this.run.profile; this.settings = this.profile.settings;
      this.active = true; this.claimed = false; this.observers = []; this.verificationObservers=[]; this.guardNodes = [];
      this.scope = null; this.target = null; this.timers = new Set(); this.pollTimer = null;
      this.run.logs ||= []; this.run.cycle = 1; this.run.stepIndex = 0;
      this.initialUrl = location.href;
    }
    log(event, message, type = 'info', extra = {}) {
      const entry = {timestamp: Date.now(), monotonicMs: performance.now(), time: new Date().toISOString(),
        event, message, type, runId: this.run.id, cycle: this.run.cycle, stepIndex: this.run.stepIndex, ...extra};
      this.run.logs.push(entry); this.run.logs = this.run.logs.slice(-500);
      (this.consoleEntries ||= []).push([entry,extra]);
      if(!this.consoleFlushQueued){this.consoleFlushQueued=true;queueMicrotask(()=>{
        this.consoleFlushQueued=false;if(this.phase!=='dispatching')this.flushConsole();
      });}
      return entry;
    }
    flushConsole() {
      for(const [entry,extra] of this.consoleEntries||[])console.log(`[Ticket Click][${entry.time}][${entry.event}] ${entry.message}`,extra);
      this.consoleEntries=[];
    }
    persist({input = false} = {}) {
      // Keep the durable input gate, but do not serialize/rewrite history before
      // sending input. The last detailed checkpoint remains in macroLogs; the
      // complete history is saved normally on completion/stop/error.
      const {logs, ...state} = this.run;
      const snapshot = JSON.parse(JSON.stringify(input ? state : this.run));
      // Only replace an ordinary checkpoint which has not started. Input and
      // terminal writes are barriers; an in-flight write is always drained.
      const ordinary=!input && this.active && ['watching','scheduled'].includes(this.phase) && ['watching','scheduled'].includes(snapshot.status);
      if(ordinary && this.pendingCheckpoint) {
        this.pendingCheckpoint.snapshot=snapshot;
        return this.pendingCheckpoint.promise;
      }
      const checkpoint={snapshot};
      this.pendingCheckpoint=ordinary?checkpoint:null;
      saving = saving.catch(() => {}).then(async () => {
        if(this.pendingCheckpoint===checkpoint)this.pendingCheckpoint=null;
        if(checkpoint.promoted)return;
        checkpoint.started=true;
        const snapshot=checkpoint.snapshot;
        const {macroRun: current} = await chrome.storage.local.get('macroRun');
        if (!current || current.id !== snapshot.id || (!ACTIVE.includes(current.status) && ACTIVE.includes(snapshot.status))) return;
        if (current.stopRequested && ACTIVE.includes(snapshot.status)) return;
        // History is written once under macroLogs while waiting. Terminal
        // snapshots keep the full legacy shape; input guards read compact state.
        const {logs,...compact}=snapshot;
        await chrome.storage.local.set(input ? {macroRun: snapshot} : {macroRun:ordinary?compact:snapshot, macroLogs:logs});
      }).catch(error => {
        // Persistence failure must not allow further steps/repeats.
        if (this.active) { this.active = false; this.cleanup(); this.notifyEnd(); console.error('상태 저장 실패: 안전 종료', error); }
      });
      checkpoint.promise=saving;
      return saving;
    }
    status(status, message, options) { this.run.status = status; this.run.message = message; return this.persist(options); }
    later(fn, delay) {
      const id = setTimeout(() => { this.timers.delete(id); if (this.active) this.safe(fn); }, Math.max(0, delay));
      this.timers.add(id); return id;
    }
    safe(fn) { try { fn(); } catch (e) { this.finish('error', e.message); } }
    pointerSnapshot() {
      const point=this.lastPointer, previous=this.lastKnownPointer;
      const viewportMatches=!!point && point.viewportKey===viewportKey();
      const valid=viewportMatches && Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.x>=0 && point.y>=0 && point.x<innerWidth && point.y<innerHeight;
      const ready=!!valid && this.pointerAnchor?.revision===point.revision;
      const state=ready?'ready':!point?(this.pointerIssue?'invalidated':'missing'):!valid?'invalid':this.pointerAnchorPending?'anchoring':'recorded';
      return {state,ready,hasPosition:!!point,x:point?.x??null,y:point?.y??null,revision:this.pointerRevision??0,
        anchorPending:!!this.pointerAnchorPending,viewportMatches,lastKnownX:previous?.x??null,lastKnownY:previous?.y??null,
        lastKnownAt:previous?.capturedAt??null,reason:this.pointerIssue||(!valid&&point?'화면 좌표 변경':''),lastInvalidation:this.lastPointerInvalidation||null};
    }
    buttonSnapshot(node, ready, found=!!node) {
      return {found,connected:!!node?.isConnected,ready:!!ready,text:normalize(node?.textContent).slice(0,2000),
        disabled:node?!!node.disabled:null,ariaDisabled:node?.getAttribute('aria-disabled')??null,
        className:node?String(node.className).slice(0,2000):'',id:node?.id||'',
        disabledClass:node?node.classList.contains('_disabled_2p3w6_34'):null};
    }
    observeReadiness(target, ready, source) {
      if (target) this.lastActivationTarget=target;
      const button=this.buttonSnapshot(target,ready), key=JSON.stringify([button.found,button.connected,button.ready,button.disabled,button.ariaDisabled,button.disabledClass]);
      this.observedButtonReady=ready;
      this.run.lastObservation={capturedAt:Date.now(),phase:this.phase,stepIndex:this.run.stepIndex,cycle:this.run.cycle,button,pointer:this.pointerSnapshot()};
      if (key!==this.buttonStateKey) {
        this.buttonStateKey=key;
        if (!ready) {
          this.detected=null;
          this.log('button-state', target?'버튼 활성 조건 미충족: '+button.text:'감시 버튼 확인 대기', 'info',
            {source,buttonFound:button.found,buttonReady:false,buttonText:button.text,buttonDisabled:button.disabled,buttonClass:button.className,buttonAriaDisabled:button.ariaDisabled});
        }
        this.saveObservationSoon();
      }
      if (ready && !this.detected) {
        const pointer=this.run.lastObservation.pointer;
        this.detected=this.log('button-detected', `${this.step.name}: 버튼 활성화 감지 · ${pointer.ready?'마우스 준비 완료':'마우스 준비 미완료'}`, 'info',
          {source,buttonFound:true,buttonReady:true,buttonText:button.text,buttonDisabled:button.disabled,buttonClass:button.className,
            pointerReady:pointer.ready,pointerState:pointer.state});
        this.saveObservationSoon();
      }
      if (Date.now()-(this.observationSavedAt||0)>=5000) this.saveObservationSoon();
    }
    recordPointerState() {
      const pointer=this.pointerSnapshot(), previous=this.loggedPointer;
      if (this.run.lastObservation) this.run.lastObservation={...this.run.lastObservation,capturedAt:Date.now(),pointer};
      // Mouse movement may briefly require a new anchor. Do not flood the log
      // with pending/ready pairs for every move after a valid position existed.
      if (previous?.ready && ['recorded','anchoring'].includes(pointer.state)) return;
      const key=JSON.stringify([pointer.state,pointer.reason]);
      if (key===this.pointerStateKey) return;
      this.pointerStateKey=key;this.loggedPointer=pointer;
      const labels={ready:'마우스 위치 확인 완료',missing:'마우스 위치 미기록',invalidated:'마우스 위치 무효화',invalid:'마우스 좌표 확인 필요',anchoring:'마우스 위치 검증 중',recorded:'마우스 위치 기록 · 검증 대기'};
      this.log('pointer-state', (labels[pointer.state]||pointer.state)+(pointer.reason?' · '+pointer.reason:''), 'info',
        {pointerState:pointer.state,pointerReady:pointer.ready,pointerHasPosition:pointer.hasPosition,pointerX:pointer.x,pointerY:pointer.y,buttonReady:!!this.observedButtonReady});
      this.saveObservationSoon();
    }
    saveObservationSoon() {
      if (this.observationSaveQueued) return;
      this.observationSaveQueued=true;
      queueMicrotask(()=>{
        this.observationSaveQueued=false;
        if (this.active && ['watching','scheduled'].includes(this.phase)) {
          this.observationSavedAt=Date.now();this.persist();
        }
      });
    }
    finalDiagnostic(status, message, endedAt) {
      const step=this.step||this.profile.steps[this.run.stepIndex];
      let target=this.lastActivationTarget||this.boundTarget, found=false, count=0, lookupError=null;
      try {
        const scope=this.nolBinding?.anchor || unique(this.profile.scopeSelector);
        if (scope?.isConnected) {
          const nodes=step.nolPrimary && this.nolBinding ?
            (this.boundTarget?.isConnected && contains(scope,this.boundTarget) && candidateMatches(this.boundTarget,step,scope,this.boundTarget) ? [this.boundTarget] : candidates({...step,selector:NOL_PRIMARY_SELECTOR},scope).filter(shown)) :
            candidates(step,scope,this.boundTarget);
          count=nodes.length;if (count===1) { target=nodes[0];found=true; }
        }
      } catch(error) { lookupError=error.message; }
      const ready=found && activationReady(target,step);
      const button={...this.buttonSnapshot(target,ready,found),candidateCount:count,lookupError,source:found?'current':'last-known'};
      return {schemaVersion:1,source:'document',liveDomAvailable:true,capturedAt:endedAt,observationCapturedAt:endedAt,status,message,phase:this.phase,
        button,pointer:this.pointerSnapshot(),timing:{createdAt:this.run.createdAt??null,monitorStartedAt:this.run.monitorStartedAt??null,
          stepStartedAt:this.run.stepStartedAt??null,gateAt:this.gate??null,deadlineAt:this.deadline??null,monitorEndedAt:endedAt,
          monitorElapsedMs:this.run.monitorStartedAt==null?null:Math.max(0,endedAt-this.run.monitorStartedAt),waitLimitMs:step?.timeoutMs??null}};
    }
    at(time, fn) {
      const check = () => {
        const remaining = time - Date.now();
        if (remaining > 0) this.later(check, Math.min(remaining, 60000));
        else fn();
      }; check();
    }
    start() {
      if (this.settings.clickMethod !== 'cdp') throw new Error('현재 버전은 CDP 입력만 지원합니다. 확장과 페이지를 새로고침하세요.');
      if (this.settings.clickMethod === 'cdp') { if(!this.settings.testMode)this.openCdpChannel();this.installUserPointer(); }
      const gate = this.settings.mode === 'hybrid' ? this.settings.scheduledAt : Date.now();
      const prepareAt = gate - this.settings.prepareSeconds * 1000;
      this.log('run-start', `실행 시작 · ${this.settings.testMode ? '테스트' : '실제 실행'} · ${this.settings.mode}`, 'info',
        {scheduledAt: this.settings.scheduledAt, prepareAt});
      this.status('scheduled', '예약 감시 준비 대기'+(this.settings.clickMethod==='cdp'?' · '+POINTER_HELP:''));
      this.at(Math.max(Date.now(), prepareAt), () => {
        this.run.monitorStartedAt = Date.now();
        this.log('monitor-start', '대상 감시 준비 완료');
        this.later(() => this.finish('timeout', '최대 실행 시간 초과: 자동 종료'), this.settings.maxRuntimeSeconds * 1000);
        this.beginStep();
      });
    }
    installUserPointer() {
      this.pointerRevision=0;this.lastPointer=null;this.pointerAnchor=null;this.pointerListeners=[];
      const listen=(node,type,fn,options)=>{node.addEventListener(type,fn,options);this.pointerListeners.push([node,type,fn,options]);};
      const moved=(event,fresh=false)=>{
        if (!event.isTrusted || event.pointerType!=='mouse' || !this.active) return;
        const previous=this.lastPointer;
        if (event.buttons && this.phase==='watching') { this.invalidatePointer('pointer-buttons');return; }
        const key=viewportKey();
        if (fresh || !previous || previous.x!==event.clientX || previous.y!==event.clientY || previous.screenX!==event.screenX ||
            previous.screenY!==event.screenY || previous.viewportKey!==key) {
          this.lastPointer={x:event.clientX,y:event.clientY,screenX:event.screenX,screenY:event.screenY,viewportKey:key,revision:++this.pointerRevision};
          this.lastKnownPointer={...this.lastPointer,capturedAt:Date.now()};
          this.pointerAnchor=null;this.pointerIssue=null;
        }
        if (this.phase==='watching') this.safe(()=>this.evaluate('user-pointer'));
      };
      listen(document,'pointermove',moved,{capture:true,passive:true});
      listen(document,'pointerover',moved,{capture:true,passive:true});
      listen(document,'pointerup',event=>{
        // Releasing a held button can leave the cursor perfectly still. Treat
        // that trusted position as fresh, then run the existing anchor checks.
        // CDP cleanup releases during dispatch must never rearm the watcher.
        if(this.active && this.phase==='watching' && event.buttons===0)moved(event,true);
      },{capture:true,passive:true});
      for(const type of ['pointerdown','click'])listen(document,type,event=>this.observeInputEvent(event),{capture:true,passive:true});
      listen(document,'pointerout',event=>{if(event.isTrusted && event.pointerType==='mouse' && !event.relatedTarget)this.invalidatePointer('pointer-left-document');},{capture:true,passive:true});
      listen(document,'pointercancel',()=>this.invalidatePointer('pointer-cancel'),{capture:true,passive:true});
      listen(window,'blur',event=>{if(event.target===window)this.invalidatePointer('window-blur');});
      listen(document,'visibilitychange',()=>{if(document.visibilityState==='hidden')this.invalidatePointer('document-hidden');});
      for (const type of ['scroll','resize']) listen(window,type,()=>this.invalidatePointer(type),{capture:true,passive:true});
      this.pointerNotice=document.createElement('div');this.pointerNotice.id='ticket-click-pointer-help';
      this.pointerNotice.setAttribute('role','status');this.pointerNotice.setAttribute('aria-live','polite');
      Object.assign(this.pointerNotice.style,{position:'fixed',right:'12px',bottom:'12px',zIndex:'2147483647',pointerEvents:'none',
        background:'#183153',color:'#fff',padding:'10px 14px',borderRadius:'8px',font:'14px system-ui',maxWidth:'300px',boxShadow:'0 2px 8px #0004'});
      document.documentElement.append(this.pointerNotice);this.pointerHint(POINTER_HELP);
    }
    pointerHint(text) {
      this.recordPointerState();
      if(text===POINTER_HELP && this.pointerIssue)text += ' · ' + this.pointerIssue;
      if(this.observedButtonReady && text.startsWith(POINTER_HELP))text='버튼 활성화 확인 · '+text;
      if (this.pointerNotice && this.pointerNotice.textContent!==text) this.pointerNotice.textContent=text;
      if (this.phase==='watching') {
        const message=`${this.run.cycle}회 · ${this.step.name}: ${text}`;
        if (this.run.message!==message) this.status('watching',message);
      }
    }
    invalidatePointer(reason = 'unknown', detail = '', quiet = false) {
      const previous=this.lastPointer, label=POINTER_REASONS[reason] || '좌표 무효화';
      const now=Date.now(), last=this.lastPointerInvalidation;
      if (previous) this.lastKnownPointer={...previous,capturedAt:this.lastKnownPointer?.capturedAt??now};
      const record=!quiet && (!!previous || !!this.pointerAnchor || !last || last.reason!==reason || last.detail!==detail || now-last.at>=2000);
      this.lastPointer=null;this.pointerAnchor=null;this.pointerRevision++;
      this.pointerReadyMonotonicMs=null;this.pointerReadyAt=null;
      this.pointerIssue=label + (detail ? ': ' + detail : '');
      if(this.active && record) {
        this.lastPointerInvalidation={reason,detail,at:now};
        this.log('pointer-invalidated','마우스 위치 무효화 · '+this.pointerIssue,'warning',
          {pointerReason:reason,pointerDetail:detail,pointerRevision:this.pointerRevision,pointerX:previous?.x,pointerY:previous?.y,phase:this.phase});
        this.persist();
      }
      if (this.active) this.pointerHint(POINTER_HELP);
    }
    pointerPoint() {
      return cdpPointerPoint(this.lastPointer);
    }
    flushPointerFailures() {
      const failure=this.pointerFailure;
      if (failure?.count>1) this.log('pointer-error-summary', `같은 마우스 위치 확인 오류 ${failure.count}회: ${failure.detail}`, 'warning',
        {pointerReason:failure.reason,pointerDetail:failure.detail,repeatCount:failure.count,firstErrorAt:failure.firstAt,lastErrorAt:failure.lastAt});
      this.pointerFailure=null;
    }
    pointerFailureResult(reason, detail) {
      const now=Date.now(), previous=this.pointerFailure;
      const repeated=previous?.reason===reason && previous.detail===detail;
      if (repeated) { previous.count++;previous.lastAt=now; }
      else {
        this.flushPointerFailures();
        this.pointerFailure={reason,detail,count:1,firstAt:now,lastAt:now};
        this.log('pointer-position-error',detail,'warning');
      }
      // Every failed point is still invalidated. Only repeated diagnostics are
      // coalesced; no focus/geometry check or input gate is bypassed.
      this.invalidatePointer(reason,detail,repeated);
    }
    ensurePointerAnchor(point) {
      if (this.settings.testMode) { this.pointerAnchor={revision:point.pointerRevision,signature:'local-test-only'};return true; }
      if (this.pointerAnchor?.revision===point.pointerRevision) return true;
      if (this.pointerAnchorPending) return false;
      const revision=point.pointerRevision;
      if (!this.pointerFailure) this.pointerHint('현재 마우스 위치 기록 중 · 그대로 두세요');
      this.pointerAnchorPending=true;
      Promise.resolve(this.channelReady).then(()=>{
        if(!this.active)throw new Error('CDP 위치 확인 전에 실행이 중지되었습니다.');
        return chrome.runtime.sendMessage({action:'cdpPointerAnchor',runId:this.run.id,point});
      }).then(result=>{
        if (!this.active || this.phase!=='watching' || this.lastPointer?.revision!==revision) return;
        if (result?.success) {
          this.pointerAnchor={revision,signature:result.parentSignature};
          this.pointerReadyMonotonicMs=performance.now();this.pointerReadyAt=Date.now();this.flushPointerFailures();
        }
        else this.pointerFailureResult('anchor-failed',result?.error || '위치 확인 실패');
      },error=>{if(this.active)this.pointerFailureResult('anchor-rpc-failed',error?.message || String(error));}).finally(()=>{
        this.pointerAnchorPending=false;
        if (this.active && this.phase==='watching' && this.lastPointer) this.safe(()=>this.evaluate('pointer-ready'));
      });
      return false;
    }
    validatePointer(request) {
      if (!this.active || this.phase!=='watching' || this.lastPointer?.revision!==request.pointerRevision) throw pointerError('마우스 위치가 변경되었습니다. '+POINTER_HELP);
      return {success:true,point:this.pointerPoint()};
    }
    disconnect() {
      this.removeVisualListeners();
      for (const observer of this.observers) observer.disconnect();
      this.disconnectVerification();
      this.observers = []; this.guardNodes = []; this.scope = null; this.target = null;
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.timers.delete(this.pollTimer); this.pollTimer = null; }
    }
    disconnectVerification() {
      for(const observer of this.verificationObservers||[])observer.disconnect();
      this.verificationObservers=[];this.verificationPrepared=false;
    }
    observe(root, options, callback, role='watch') {
      if (!root) return;
      const observer = new MutationObserver(records => {
        if (this.active && (role==='verify'||this.phase==='watching')) this.safe(() => callback(records));
      });
      observer.observe(root, options);(role==='verify'?(this.verificationObservers ||= []):this.observers).push(observer);
    }
    stopForBlocker() {
      for (const selector of [...this.profile.safetySelectors, GENERIC_BLOCKERS]) {
        for (const node of findAll(selector)) {
          if (shown(node)) { this.finish('handoff', `안전 종료: ${selector} 표시. 사용자 확인이 필요합니다.`); return true; }
        }
      }
      return false;
    }
    bindGuards(callback,role='watch') {
      for (const selector of [...this.profile.safetySelectors, GENERIC_BLOCKERS]) {
        for (const node of findAll(selector)) {
          if(role==='watch')this.guardNodes.push(node);
          // Covers hidden ancestors too, without broad attribute subtree scanning.
          for (let parent = node; parent?.nodeType === 1 && parent !== this.scope; parent = parentOf(parent)) {
            if (this.scope && contains(this.scope,parent)) break;
            this.observe(parent, {attributes: true, attributeFilter: ATTRS}, callback,role);
          }
        }
      }
    }
    beginStep() {
      this.disconnect(); this.claimed = false; this.baseline = null; this.detected = null; this.boundTarget = null; this.nolBinding = null; this.pendingInput = null; this.pendingContext = null;
      this.step = this.profile.steps[this.run.stepIndex];
      this.lastActivationTarget=null;this.buttonStateKey=null;this.observedButtonReady=false;this.run.stepStartedAt=Date.now();
      this.phase = 'watching'; this.stepToken = Symbol();
      const token = this.stepToken;
      const gate = this.settings.mode === 'hybrid' && this.run.cycle === 1 && this.run.stepIndex === 0 ? this.settings.scheduledAt : Date.now();
      this.gate = gate; this.deadline = Math.max(Date.now(), gate) + this.step.timeoutMs;
      this.log('step-wait', `${this.step.name}: 활성화 대기`, 'info', {gate,gateAt:gate,deadlineAt:this.deadline,monitorStartedAt:this.run.monitorStartedAt});
      this.status('watching', `${this.run.cycle}회 · ${this.step.name} 대기`);
      if(this.settings.clickMethod==='cdp')this.pointerHint(POINTER_HELP);
      this.installWatching();
      this.at(gate, () => { if (this.stepToken === token && this.phase === 'watching') {
        this.log('schedule-gate', '예약 시각 도달', 'info', {scheduledAt: gate, gateDelayMs: Date.now() - gate});
        this.evaluate('schedule');
      }});
      this.at(this.deadline, () => { if (this.stepToken === token && this.phase === 'watching') this.finish('timeout', `${this.step.name}: 버튼 대기 시간 초과`); });
      if (this.settings.pollingMs) this.poll();
      this.evaluate('initial');
    }
    installWatching() {
      const attributeFilter = [...new Set([...ATTRS, ...[this.profile.scopeSelector, this.step.selector, this.step.readySelector, this.step.containerSelector, ...this.profile.safetySelectors]
        .flatMap(selector => [...(selector || '').matchAll(/\[\s*([\w:-]+)/g)].map(match => match[1]))])];
      const scope = this.nolBinding?.anchor || unique(this.profile.scopeSelector);
      if (!scope) {
        // Temporary discovery observer: childList only; removed as soon as scope appears.
        this.observe(document.documentElement, {childList: true, subtree: true}, () => {
          if (unique(this.profile.scopeSelector)) {
            this.disconnect(); this.installWatching(); if (this.settings.pollingMs) this.poll(); this.evaluate('scope-added');
          }
          else this.stopForBlocker();
        });
        return;
      }
      this.scope = scope;
      this.observe(scope, {childList: true, subtree: true, attributes: true, attributeFilter, characterData: !!(this.step.targetText || this.step.buttonText)}, records => {
        const structural=records.some(r=>r.type==='childList'&&[...r.addedNodes,...r.removedNodes].some(n=>n instanceof Element));
        if(structural)this.verificationPrepared=false;
        // Ignore clock/log subtree text churn while the cached target is stable.
        const relevant = !!this.step.targetText || !this.target?.isConnected || records.some(r => r.type === 'attributes' || r.type === 'characterData' ||
          r.target === scope || r.target.contains(this.target) || this.target.contains(r.target) ||
          this.guardNodes.some(n => n === r.target || n.contains(r.target) || r.target.contains(n)) ||
          [...r.addedNodes].some(n => n instanceof Element));
        if (relevant) this.evaluate('mutation');
        if(structural&&this.active&&this.phase==='watching')this.installVerification();
      });
      // Detect removal/replacement of scope, and CSS/disabled changes on ancestors.
      for (const root of shadowRoots(scope)) this.observe(root, {childList:true,subtree:true,attributes:true,attributeFilter,characterData:true}, records => {
        const structural=records.some(r=>r.type==='childList'&&[...r.addedNodes,...r.removedNodes].some(n=>n instanceof Element));
        if(structural)this.verificationPrepared=false;
        this.evaluate('shadow-mutation');
        if(structural&&this.active&&this.phase==='watching')this.installVerification();
      });
      for (let node = parentOf(scope); node; node = parentOf(node)) {
        this.observe(node, {childList: true, attributes: true, attributeFilter}, () => {
          if (!scope.isConnected) { this.disconnect(); this.installWatching(); if (this.settings.pollingMs) this.poll(); }
          this.evaluate('ancestor-mutation');
        });
      }
      this.bindGuards(() => this.evaluate('safety-mutation'));
      // Outside-region challenges may be inserted dynamically. Inspect only element additions,
      // never body text, and retain narrow attribute observers for known safety markers.
      const safety = [...this.profile.safetySelectors, GENERIC_BLOCKERS].join(',');
      const shadowSafety = safety.includes('>>>');
      this.observe(document.documentElement, {childList: true, subtree: true}, records => {
        if (records.some(r => [...r.addedNodes].some(n => n instanceof Element && (shadowSafety || n.matches(safety) || n.querySelector(safety))))) {
          if (!this.stopForBlocker()) {this.bindGuards(() => this.evaluate('safety-mutation'));if(this.verificationPrepared)this.installVerification();}
        }
      });
      for (const event of ['transitionend', 'animationend']) {
        scope.addEventListener(event, this.onVisualChange ||= () => this.safe(() => this.evaluate('visual-change')));
      }
      this.visualScope = scope;
      // Install completion observers while waiting. Their callbacks cannot
      // complete a watching/dispatching step; baseline stays fresh at claim.
      this.installVerification();
    }
    removeVisualListeners() {
      if (this.visualScope && this.onVisualChange) {
        this.visualScope.removeEventListener('transitionend', this.onVisualChange);
        this.visualScope.removeEventListener('animationend', this.onVisualChange);
      }
      this.visualScope = null;
    }
    poll() {
      if (this.pollTimer || !this.active) return;
      this.pollTimer = this.later(() => {
        this.pollTimer = null;
        if (this.phase === 'watching') this.evaluate('poll');
        else if (this.phase === 'verifying') this.checkVerification('poll');
        if (this.active && ['watching', 'verifying'].includes(this.phase)) this.poll();
      }, this.settings.pollingMs);
    }
    verificationState() {
      if (this.step.verify.kind === 'newContext') {this.currentVerificationNode=null;return {visible: false, text: null, attr: null};}
      const v = this.step.verify, node = unique(v.selector);
      this.currentVerificationNode=node;
      return {visible: shown(node), text: node?.textContent?.trim() ?? null, attr: node?.getAttribute(v.attribute) ?? null};
    }
    verificationMatches(state) {
      const v = this.step.verify;
      if (v.kind === 'appeared') return state.visible;
      if (v.kind === 'disappeared') return !state.visible;
      if (v.kind === 'textChanged') return state.visible && state.text !== this.baseline.text;
      if (v.kind === 'textIncludes') return state.visible && !!state.text?.includes(v.value);
      if (v.kind === 'attributeEquals') return state.visible && state.attr === v.value;
      return false;
    }
    nolTarget() {
      const binding=this.nolBinding, previous=this.boundTarget;
      if (!binding.anchor.isConnected) throw new Error('NOL 감시 영역도 교체되었습니다. 현재 탭에서 다시 가져온 뒤 시작하세요.');
      if (previous?.isConnected) {
        if (!contains(binding.anchor,previous)) throw new Error('NOL 감시 버튼이 기존 영역 밖으로 이동했습니다. 다시 가져온 뒤 시작하세요.');
        if (candidateMatches(previous,this.step,binding.anchor,previous)) { binding.waiting=false; binding.missingLogged=false; return previous; }
      }
      if (!binding.waiting) {
        binding.waiting=true;
        this.log('button-replaced', 'NOL 버튼 교체·구조 변경 감지 · 같은 감시 영역에서 새 버튼 재탐색', 'info');
        // Save this log with the rebound/wait result below, once per search.
      }
      // A connected but unrecognized button is not permission to select a neighbor.
      const nodes=previous?.isConnected ? [] : candidates({...this.step,selector:NOL_PRIMARY_SELECTOR},binding.anchor).filter(shown);
      const observed=()=>[...binding.anchor.querySelectorAll('button')].slice(0,5).map(node=>({
        text:normalize(node.textContent).slice(0,120),id:node.id,className:String(node.className).slice(0,200),disabled:!!node.disabled
      }));
      if (nodes.length>1) throw new Error(`새 NOL 버튼 후보가 ${nodes.length}개입니다. 하나를 확인할 수 없어 입력하지 않습니다. ${JSON.stringify(observed())}`);
      if (!nodes.length) {
        if (!binding.missingLogged) {
          binding.missingLogged=true;
          this.log('button-search-wait', '새 NOL 버튼 확인 대기 · 기존 감시 제한 유지 · 후보: '+JSON.stringify(observed()), 'info');
          this.persist();
        }
        return null;
      }
      this.boundTarget=nodes[0]; this.detected=null; binding.waiting=false; binding.missingLogged=false;
      this.log('button-rebound', '새 NOL 버튼 재연결 완료 · 활성 조건 확인: '+normalize(nodes[0].textContent), 'info');
      this.persist();
      return nodes[0];
    }
    evaluate(source) {
      if (!this.active || this.phase !== 'watching' || this.claimed) return;
      if (location.href !== this.initialUrl) { this.finish('interrupted', '문서 URL 변경: 안전 종료'); return; }
      if (this.stopForBlocker()) return;
      let target;
      if (this.step.nolPrimary && this.nolBinding) target=this.nolTarget();
      else {
        const currentScope = unique(this.profile.scopeSelector);
        if (currentScope !== this.scope || !this.scope?.isConnected) {
          if (!currentScope) return;
          this.disconnect(); this.installWatching(); if (this.settings.pollingMs) this.poll();
        }
        // unique() above already proved the current scope matches, within this
        // synchronous evaluation. Do not repeat a document-wide Shadow query.
        // Re-query only the configured area; reject ambiguity instead of clicking the first.
        // Captured NOL countdowns bind by structure. Other profiles keep exact text.
        const bindText = this.profile.siteAdapter === 'nol-gate' || this.step.bindButtonText;
        target = targetFor(this.step, this.scope, bindText ? this.boundTarget : null);
        if (target && bindText && target !== this.boundTarget) {
          this.boundTarget = target;
          this.log('button-bound', (this.step.nolPrimary ? 'NOL 구조로 대기 버튼 식별 완료 · 교체 시 같은 영역에서 재탐색' : '문구로 대기 버튼 식별 완료: 같은 DOM 버튼만 추적'), 'info', {buttonText: normalize(target.textContent)});
          if (this.step.nolPrimary) {
            // When the button itself was the scope, pin its current parent as the
            // rediscovery boundary. Never broaden to a different page/container.
            this.nolBinding={anchor:this.scope===target ? target.parentNode : this.scope,waiting:false};
            this.disconnect(); this.installWatching(); if (this.settings.pollingMs) this.poll();
          }
        }
      }
      this.target = target;
      const targetReady=!!target && (this.settings.clickMethod==='cdp'?activationReady(target,this.step):clickable(target,this.step));
      this.observeReadiness(target,targetReady,source);
      if (!target && this.nolBinding?.waiting) {
        this.pointerHint('새 NOL 버튼을 다시 찾는 중 · 기존 감시 제한 유지'); return;
      }
      if (this.settings.clickMethod==='cdp') {
        let point;
        try {point=this.pointerPoint();} catch(e) {if(e.waitForPointer){if(this.lastPointer)this.invalidatePointer('viewport-changed',e.message);else this.pointerHint(POINTER_HELP);return;}throw e;}
        if (!this.ensurePointerAnchor(point)) return;
        this.pointerHint('현재 마우스 위치 기록 완료 · 활성화/예약 시각 대기');
      }
      if (!targetReady) return;
      const detectedAt=this.detected.timestamp, detectedMono=this.detected.monotonicMs;
      if (Date.now() < this.gate) return;
      if (Date.now() >= this.deadline) { this.finish('timeout', '버튼 감지 시 대기 시간 초과'); return; }
      // A synchronous lock comes before dispatch; observer/poll/timer cannot duplicate this attempt.
      this.claimed = true;
      if (this.settings.testMode) {
        const attempt = this.log('test-attempt', `${this.step.name}: 테스트 클릭 예정 (이벤트 전송 없음)`, 'info',
          {actionableDetectedAt: detectedAt, actionableMonotonicMs: detectedMono, source});
        attempt.detectToAttemptMs = attempt.monotonicMs - detectedMono;
        this.run.lastAttempt = attempt;
        this.finish('tested', '테스트 완료: 현재 단계 활성화 확인. 클릭/완료 검증/후속 단계/반복은 실행하지 않았습니다.');
        return;
      }
      this.baseline = this.verificationState();
      if (this.step.verify.kind === 'disappeared' && !this.baseline.visible ||
          this.step.verify.kind !== 'textChanged' && this.step.verify.kind !== 'disappeared' && this.verificationMatches(this.baseline)) {
        this.finish('error', '완료 조건이 클릭 전에 이미 만족됩니다. 새 전환을 증명하는 조건으로 변경하세요.'); return;
      }
      this.phase = this.settings.clickMethod === 'cdp' ? 'dispatching' : 'verifying';
      this.removeVisualListeners();
      if(!this.verificationPlanValid())this.installVerification();
      const attempt = this.log('click-attempt', `${this.step.name}: ${this.settings.clickMethod === 'cdp' ? 'CDP 입력 준비 (아직 전송하지 않음)' : this.step.event + ' 한 번 실행'}`, 'info',
        {actionableDetectedAt: detectedAt, actionableMonotonicMs: detectedMono, source, eventType: this.step.event,clickMethod:this.settings.clickMethod || 'javascript'});
      attempt.detectToAttemptMs = attempt.monotonicMs - detectedMono;
      attempt.pointerReadyAt=this.pointerReadyAt??null;
      attempt.pointerReadyMonotonicMs=this.pointerReadyMonotonicMs??null;
      attempt.pointerWaitMs=Number.isFinite(this.pointerReadyMonotonicMs)?Math.max(0,this.pointerReadyMonotonicMs-detectedMono):null;
      attempt.scheduledDeltaMs = this.settings.scheduledAt ? attempt.timestamp - this.settings.scheduledAt : null;
      this.run.lastAttempt = attempt;
      if (this.settings.clickMethod === 'cdp') {
        this.dispatchCdp(attempt).catch(e => {if(this.phase!=='disconnected')this.finish('error',e.message);});
        return;
      }
      /* Legacy JavaScript input disabled in 2.2.5; retained for reference.
      // No await, storage, runtime message, scrolling or focusing in this path.
      if (this.step.event === 'pointerdown') {
        target.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, composed: true,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1}));
      } else target.click();
      this.afterDispatch();
      */
    }

    validateCdp(request) {
      if (!this.active || this.phase !== 'dispatching' || !this.pendingInput || this.pendingInput.attemptId !== request.attemptId ||
          location.href !== this.initialUrl) throw new Error('CDP 대기 중인 버튼/실행 상태가 아닙니다.');
      if (Date.now() < this.gate || Date.now() >= this.deadline) throw new Error('CDP 입력 시각이 예약 게이트/버튼 대기 시간을 벗어났습니다.');
      if (this.stopForBlocker()) throw new Error('안전 종료 표시가 나타났습니다.');
      const pending = this.pendingInput;
      // The controller may recheck geometry/pointer again after its afterPress
      // RPC. Keep that phase so an on-press DOM change cannot cause a second press.
      if (request.afterPress) pending.pressed = true;
      // Some pages complete on pointerdown and hide/disable the original button immediately.
      // The shared verifier must observe a new transition, before a canceled release can count as success.
      if (request.afterPress && this.verificationMatches(this.verificationState())) return {success:true,completedOnPress:true};
      if (!pending.pressed && this.step.nolPrimary && (!this.boundTarget?.isConnected ||
          !this.nolBinding?.anchor.isConnected || !contains(this.nolBinding.anchor,this.boundTarget) ||
          !candidateMatches(this.boundTarget,this.step,this.nolBinding.anchor,this.boundTarget) || !activationReady(this.boundTarget,this.step))) {
        throw new Error('CDP 입력 전에 NOL 감시 버튼이 변경되거나 비활성화되었습니다. 입력 없이 종료합니다.');
      }
      if (this.lastPointer?.revision!==pending.point.pointerRevision) throw pointerError('입력 직전 마우스 위치가 변경되었습니다. '+POINTER_HELP);
      return {success:true,point:this.pointerPoint()};
    }
    async dispatchCdp(attempt) {
      const point = this.pointerPoint(), attemptId = crypto.randomUUID();
      point.pointerAnchor=this.pointerAnchor?.signature;
      this.pendingInput = {attemptId,point,attempt};
      attempt.attemptId=attemptId;
      const savingAt=performance.now();
      this.run.status='verifying';this.run.message=this.step.name+': CDP 좌표 확인 및 입력 중';
      const intent={stepIndex:this.run.stepIndex,cycle:this.run.cycle,message:this.run.message,lastAttempt:attempt,lastObservation:this.run.lastObservation};
      const checkpoint=this.pendingCheckpoint;
      // Promote only a queued NOL checkpoint. Oversized histories take the
      // original durable path; an already-started write is always drained.
      if(this.step.nolPrimary && checkpoint && !checkpoint.started &&
          JSON.stringify({...intent,checkpointLogs:checkpoint.snapshot.logs}).length<=60000){
        checkpoint.promoted=true;this.pendingCheckpoint=null;intent.checkpointLogs=checkpoint.snapshot.logs;attempt.checkpointPromoted=true;
      }
      // Drain older checkpoints without adding another get/set before input.
      // The worker commits the compact intent and recovery marker together.
      await saving;
      attempt.preInputQueueMs=performance.now()-savingAt;
      if (!this.active) return;
      const requestAt=performance.now();
      const result = await this.sendCdpClick({action:'cdpClick',runId:this.run.id,attemptId,point,intent});
      attempt.cdpRoundTripMs=performance.now()-requestAt;
      if (!this.active) return;
      if (result?.waitForPointer) {
        this.claimed=false;this.pendingInput=null;this.phase='watching';this.invalidatePointer('cdp-preflight',result.error || '입력 전 위치가 변경되었습니다.');
        this.log('pointer-wait',result.error,'warning');this.persist();this.disconnect();this.installWatching();
        this.at(this.deadline,()=>{if(this.active && this.phase==='watching')this.finish('timeout','마우스 위치 확인 대기 시간 초과');});
        if(this.settings.pollingMs)this.poll();return;
      }
      if (!result?.success) {
        this.logClickTiming(attempt);
        throw new Error(result?.error || 'CDP 응답이 없습니다.');
      }
      Object.assign(attempt, {inputStartedAt:result.inputStartedAt,inputFinishedAt:result.inputFinishedAt,
        detectToInputMs:result.inputStartedAt-attempt.actionableDetectedAt,zoomFactor:result.zoomFactor,...result.timings});
      this.logClickTiming(attempt);
      this.pendingInput = null; this.phase = 'verifying';
      this.afterDispatch(result.completedOnPress ? 'CDP mousePressed 후 완료 전환 확인 · 화면 밖 mouseReleased로 눌림 정리' : 'CDP mousePressed / mouseReleased 전송 완료');
      if (this.pendingContext) this.contextOpened(this.pendingContext);
    }
    observeInputEvent(event) {
      const pending=this.pendingInput,attempt=pending?.attempt,point=pending?.point;
      if(!this.active || this.phase!=='dispatching' || !attempt || !event.isTrusted || event.button!==0 ||
          event.type==='pointerdown' && event.pointerType!=='mouse' ||
          !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) ||
          Math.abs(event.clientX-point.x)>1 || Math.abs(event.clientY-point.y)>1)return;
      const now=performance.now();
      // Only record numbers here. Log rendering/storage waits until after input.
      if(event.type==='pointerdown' && !Number.isFinite(attempt.observedPointerdownAt)) {
        attempt.observedPointerdownAt=Date.now();attempt.observedPointerdownMonotonicMs=now;
        attempt.activationToPointerdownMs=now-attempt.actionableMonotonicMs;
        const ready=Number.isFinite(attempt.pointerReadyMonotonicMs)?Math.max(attempt.actionableMonotonicMs,attempt.pointerReadyMonotonicMs):null;
        attempt.readyToPointerdownMs=ready===null?null:now-ready;
      }
      if(event.type==='click' && !Number.isFinite(attempt.observedClickAt)) {
        attempt.observedClickAt=Date.now();attempt.activationToClickMs=now-attempt.actionableMonotonicMs;
      }
    }
    logClickTiming(attempt) {
      if(!attempt || attempt.timingLogged)return;
      const observed=Number.isFinite(attempt.activationToPointerdownMs);
      const latency=observed?attempt.activationToPointerdownMs:attempt.detectToInputMs;
      if(!Number.isFinite(latency))return;
      attempt.timingLogged=true;
      const source=observed?'trusted-pointerdown':'cdp-command';
      const parts=[observed?`클릭 시간 · 활성화 감지→pointerdown ${latency.toFixed(1)}ms`:`입력 시간 · 활성화 감지→CDP 전송 약 ${latency.toFixed(1)}ms (pointerdown 미관측)`];
      if(Number.isFinite(attempt.activationToClickMs))parts.push(`click ${attempt.activationToClickMs.toFixed(1)}ms`);
      if(Number.isFinite(attempt.pointerWaitMs))parts.push(`마우스 준비 대기 ${attempt.pointerWaitMs.toFixed(1)}ms`);
      if(Number.isFinite(attempt.readyToPointerdownMs))parts.push(`좌표 준비 후 눌림 ${attempt.readyToPointerdownMs.toFixed(1)}ms`);
      const keys=['actionableDetectedAt','actionableMonotonicMs','observedPointerdownAt','observedPointerdownMonotonicMs','observedClickAt','activationToPointerdownMs','activationToClickMs',
        'pointerReadyAt','pointerReadyMonotonicMs','pointerWaitMs','readyToPointerdownMs','detectToInputMs','preInputPersistMs','preInputQueueMs','cdpRoundTripMs',
        'claimPersistMs','cdpPreflightMs','pressCommandMs','afterPressCheckMs','releaseCommandMs'];
      const detail=Object.fromEntries(keys.map(key=>[key,attempt[key]??null]));
      this.log('click-timing',parts.join(' · '),'info',{clickMethod:'cdp',clickLatencyMs:latency,inputTimingSource:source,...detail});
    }
    afterDispatch(message = '이벤트 전송 완료 (성공 여부는 완료 조건으로 확인)') {
      if (!this.active) return;
      this.status('verifying', this.step.name + ': 실제 완료 확인 중');
      this.log('event-dispatched', message, 'info', {clickMethod:this.settings.clickMethod || 'javascript'});
      const token = this.stepToken;
      this.later(() => { if (this.phase === 'verifying' && this.stepToken === token) this.finish('timeout', this.step.name + ': 완료 검증 시간 초과. 재클릭하지 않습니다.'); }, this.step.verify.timeoutMs);
      if (this.settings.pollingMs) this.poll();
      this.checkVerification('after-dispatch');
      this.flushConsole();
    }
    async sendCdpClick(request) {
      if(!this.channelReady)return chrome.runtime.sendMessage(request); // Never-bound legacy/test transport only.
      await this.channelReady;
      const port=this.documentPort;
      if(!port||!this.active||this.phase!=='dispatching')throw new Error('CDP 클릭 연결이 없습니다. 재전송하지 않습니다.');
      if(this.commandPending.size)throw new Error('중복 CDP 요청을 전송하지 않습니다.');
      return new Promise((resolve,reject)=>{
        const id=++this.commandSequence;
        const timer=setTimeout(()=>{
          this.commandPending.delete(id);const error=new Error('CDP 클릭 응답 시간 초과: 입력 재전송 없이 종료합니다.');
          this.endCdpChannel(error);this.closeCdpChannel();reject(error);
        },10000);
        this.commandPending.set(id,{resolve,reject,timer});
        try{port.postMessage({kind:'command',id,runId:this.run.id,request});}
        catch(error){this.endCdpChannel(error);this.closeCdpChannel();reject(error);}
      });
    }
    openCdpChannel() {
      if(!chrome.runtime.connect)return; // Older test/legacy transports remain supported.
      const port=chrome.runtime.connect({name:'ticket-cdp-document'});this.documentPort=port;
      this.commandPending=new Map();this.commandSequence=0;
      let resolveReady,rejectReady,ready=false;
      this.channelReady=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
      const timer=setTimeout(()=>{rejectReady(new Error('CDP 문서 연결 준비 시간 초과'));this.closeCdpChannel();},5000);
      this.channelCleanup=()=>{
        clearTimeout(timer);const error=new Error('CDP 문서 연결이 종료되었습니다.');if(!ready)rejectReady(error);
        for(const item of this.commandPending.values()){clearTimeout(item.timer);item.reject(error);}this.commandPending.clear();
      };
      port.onMessage.addListener(message=>{
        if(message?.kind==='ready'&&message.runId===this.run.id){ready=true;clearTimeout(timer);resolveReady();return;}
        if(message?.kind==='command-result'&&message.runId===this.run.id){
          const item=this.commandPending.get(message.id);if(item){this.commandPending.delete(message.id);clearTimeout(item.timer);item.resolve(message.result);}return;
        }
        if(message?.kind!=='request'||message.runId!==this.run.id||!Number.isInteger(message.id))return;
        let result;try{
          if(message.request?.runId!==this.run.id)throw new Error('CDP 문서 요청 실행 ID가 다릅니다.');
          if(message.request.action==='validateCdpTarget')result=this.validateCdp(message.request);
          else if(message.request.action==='validateCdpPointer')result=this.validatePointer(message.request);
          else throw new Error('허용되지 않은 CDP 문서 조회입니다.');
        }catch(error){result={success:false,error:error.message,waitForPointer:!!error.waitForPointer};}
        try{port.postMessage({kind:'response',id:message.id,runId:this.run.id,result});}catch{}
      });
      port.onDisconnect.addListener(()=>{
        clearTimeout(timer);if(this.documentPort===port)this.documentPort=null;
        this.channelCleanup?.();
        const error=new Error('CDP 문서 연결이 끊겼습니다. 입력 재전송 없이 종료합니다.');
        if(!ready)rejectReady(error);else this.endCdpChannel(error);
      });
      this.channelReady.catch(error=>this.endCdpChannel(error));
      port.postMessage({kind:'bind',runId:this.run.id});
    }
    endCdpChannel(error) {
      if(!this.active)return;
      // Stop authorizing input immediately. A controller-driven close may
      // precede stopEngine; preserve that durable user stop instead of racing
      // it with an interrupted snapshot. No connection or input is retried.
      this.phase='disconnected';
      chrome.storage.local.get('macroRun').then(({macroRun})=>{
        if(!this.active)return;
        const stopped=macroRun?.id===this.run.id&&macroRun.stopRequested;
        this.finish(stopped?'stopped':'interrupted',stopped?'사용자가 중지했습니다.':error.message);
      },()=>{if(this.active)this.finish('interrupted',error.message);});
    }
    closeCdpChannel() {const port=this.documentPort;this.documentPort=null;this.channelCleanup?.();this.channelCleanup=null;try{port?.disconnect();}catch{}}
    notifyEnd() {
      if (this.settings.clickMethod === 'cdp' && !this.endNotified) {
        this.endNotified = true;
        chrome.runtime.sendMessage({action:'engineEnded',runId:this.run.id}).catch(console.error).finally(()=>this.closeCdpChannel());
      }
    }

    verificationPlanValid() {
      if(!this.verificationPrepared)return false;
      if(this.step.verify.kind==='newContext')return true;
      if(this.verificationNode!==this.currentVerificationNode || this.verificationScope&&!this.verificationScope.isConnected ||
          this.currentVerificationNode&&this.verificationRoot!==this.currentVerificationNode.getRootNode())return false;
      let index=0;for(let parent=this.currentVerificationNode?.parentElement;parent;parent=parent.parentElement)
        if(this.verificationAncestors[index++]!==parent)return false;
      return index===this.verificationAncestors.length;
    }
    installVerification() {
      this.disconnectVerification();
      const observe=(root,options,callback)=>this.observe(root,options,callback,'verify');
      const external = this.step.verify.kind === 'newContext';
      const node = external ? null : unique(this.step.verify.selector);
      const scope = unique(this.profile.scopeSelector);
      this.verificationNode=node;this.verificationScope=scope;this.verificationRoot=node?.getRootNode();
      this.verificationAncestors=[];for(let parent=node?.parentElement;parent;parent=parent.parentElement)this.verificationAncestors.push(parent);
      const callback = () => this.checkVerification('mutation');
      if (scope) {
        observe(scope, {childList: true, subtree: true, attributes: true, characterData: true}, callback);
        for (const root of shadowRoots(scope)) observe(root, {childList:true,subtree:true,attributes:true,characterData:true}, callback);
      }
      if (node && !scope?.contains(node)) {
        observe(node.parentElement || node, {childList: true, subtree: true, attributes: true, characterData: true}, callback);
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          observe(parent, {childList: true, attributes: true, attributeFilter: ATTRS}, callback);
        }
      } else if (!node && !external) {
        // A not-yet-created completion marker can occur outside the action region.
        observe(document.documentElement, {childList: true, subtree: true}, () => {
          if (unique(this.step.verify.selector)) {
            this.installVerification();
          }
          this.checkVerification('completion-added');
        });
      }
      this.bindGuards(callback,'verify');
      if (external) observe(document.documentElement, {childList: true, subtree: true}, callback);
      this.verificationPrepared=true;
    }
    contextOpened(detail) {
      if (this.active && this.claimed && this.phase === 'dispatching' && this.step.verify.kind === 'newContext') { this.pendingContext = detail; return true; }
      if (!this.active || !this.claimed || this.phase !== 'verifying' || this.step.verify.kind !== 'newContext') return false;
      this.log('context-opened', '클릭 후 새 창/화면 이동 확인', 'success', detail);
      this.finish('handoff', '새 창/화면 이동을 확인했습니다. 이후 로그인·대기열·보안문자·예매는 직접 진행하세요.');
      return true;
    }
    navigation() {
      if (!this.active) return;
      if (!this.contextOpened({context: 'source-navigation'})) this.finish('interrupted', '문서/주소 이동: 자동 재클릭하지 않습니다.');
    }
    checkVerification(source) {
      if (!this.active || this.phase !== 'verifying') return;
      if (location.href !== this.initialUrl) { this.navigation(); return; }
      const complete = this.verificationMatches(this.verificationState());
      if (complete) {
        this.log('step-completed', `${this.step.name}: 완료 조건의 새 전환 확인`, 'success', {source});
        this.run.lastVerifiedAt = Date.now();
      }
      if (this.stopForBlocker()) return;
      if (!complete) return;
      this.phase = 'transition'; this.disconnect(); this.detected = null;
      this.run.stepIndex++;
      if (this.run.stepIndex < this.profile.steps.length) { this.beginStep(); return; }
      this.log('cycle-completed', `${this.run.cycle}회 전체 단계 검증 완료`, 'success');
      if (this.settings.count !== 0 && this.run.cycle >= this.settings.count) {
        this.finish('completed', `${this.run.cycle}회 실행 및 완료 검증 완료`); return;
      }
      this.phase = 'repeat-wait';
      this.status('repeat-wait', `반복 전 ${this.settings.delaySeconds}초 대기`);
      this.later(() => { this.run.cycle++; this.run.stepIndex = 0; this.beginStep(); }, this.settings.delaySeconds * 1000);
    }
    cleanup() {
      this.removeVisualListeners(); this.disconnect();
      for(const [node,type,fn,options] of this.pointerListeners || [])node.removeEventListener(type,fn,options);
      this.pointerListeners=[];this.pointerNotice?.remove();this.pointerNotice=null;
      for (const id of this.timers) clearTimeout(id);
      this.timers.clear();
    }
    finish(status, message) {
      if (!this.active) return;
      this.logClickTiming(this.run.lastAttempt);
      this.flushPointerFailures();
      const endedAt=Date.now();let diagnostic;
      try { diagnostic=this.finalDiagnostic(status,message,endedAt); }
      catch(error) { diagnostic={...this.run.lastObservation,schemaVersion:1,source:'document-fallback',liveDomAvailable:false,capturedAt:endedAt,status,message,
        observationCapturedAt:this.run.lastObservation?.capturedAt??null,diagnosticError:error.message,
        timing:{monitorStartedAt:this.run.monitorStartedAt??null,monitorEndedAt:endedAt,gateAt:this.gate??null,deadlineAt:this.deadline??null,
          monitorElapsedMs:this.run.monitorStartedAt==null?null:Math.max(0,endedAt-this.run.monitorStartedAt)}}; }
      this.run.finalDiagnostics=diagnostic;
      const button=diagnostic.button||{},pointer=diagnostic.pointer||{},timing=diagnostic.timing||{};
      this.log('run-diagnostics', `종료 진단 · 버튼: ${button.found?(button.ready?'활성':'활성 조건 미충족'):'현재 대상 없음'} · 마우스: ${pointer.state||'확인 불가'} · 감시 ${timing.monitorElapsedMs??'미시작'}ms`, 'info',
        {buttonFound:button.found,buttonConnected:button.connected,buttonReady:button.ready,buttonText:button.text,buttonDisabled:button.disabled,
          buttonClass:button.className,buttonAriaDisabled:button.ariaDisabled,pointerState:pointer.state,pointerReady:pointer.ready,pointerHasPosition:pointer.hasPosition,
          pointerX:pointer.x,pointerY:pointer.y,lastPointerX:pointer.lastKnownX,lastPointerY:pointer.lastKnownY,
          ...timing,diagnosticSource:diagnostic.source,observationCapturedAt:diagnostic.observationCapturedAt,diagnosticJson:JSON.stringify(diagnostic)});
      this.active = false; this.phase = status; this.cleanup();
      this.run.status = status; this.run.message = message; this.run.endedAt = endedAt;
      this.log('run-end', message, ['completed', 'tested'].includes(status) ? 'success' : status === 'error' ? 'error' : 'warning');
      this.flushConsole();
      this.persist().finally(() => this.notifyEnd());
    }
  }
  chrome.runtime.onMessage.addListener((request, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    try {
      if (request.action === 'validateEngine') { respond(validateDOM(request.profile)); return false; }
      if (request.action === 'validateCdpTarget') {
        if (engine?.run.id !== request.runId) throw new Error('CDP 실행 ID가 다릅니다.');
        respond(engine.validateCdp(request)); return false;
      }
      if (request.action === 'validateCdpPointer') {
        if(engine?.run.id!==request.runId)throw new Error('CDP 실행 ID가 다릅니다.');
        respond(engine.validatePointer(request));return false;
      }
      if(request.action==='invalidateCdpPointer') {
        if(engine?.run.id===request.runId)engine.invalidatePointer(request.reason || 'unknown',request.detail || '');respond({success:true});return false;
      }
      if (request.action === 'startEngine') {
        if (engine?.active) throw new Error('이 프레임에서 이미 실행 중입니다.');
        validateDOM(request.run.profile);
        /* Legacy schedule selection disabled in 2.1.4.
        if (request.run.profile.siteAdapter === 'nol-postseason' && !request.run.profile.steps[0].targetText?.trim()) {
          throw new Error('NOL 예매할 경기를 먼저 선택하세요.');
        }
        */
        engine = new Engine(request.run);
        // Initialization is off the hot path, with a durable run created by the worker.
        engine.safe(() => engine.start());
        respond({success: true}); return false;
      }
      if (request.action === 'stopEngine') {
        if (engine?.run.id === request.runId) engine.finish('stopped', '사용자가 중지했습니다.');
        respond({success: true}); return false;
      }
      if (request.action === 'engineStatus') {
        saving.finally(() => respond({running: !!engine?.active, runId: engine?.run.id, status: engine?.run.status})); return true;
      }
      if (request.action === 'contextOpened') {
        const verified = engine?.run.id === request.runId && engine.contextOpened({context: 'new-tab', tabId: request.tabId});
        respond({success: !!verified}); return false;
      }
      if (request.action === 'inspectEngine') {
        validateDOM(request.profile);
        const scope = unique(request.profile.scopeSelector);
        respond({success: true, url: location.href, scopeCount: findAll(request.profile.scopeSelector).length,
          steps: request.profile.steps.map(step => {
            const targets = scope ? candidates(step, scope) : [];
            return {name: step.name, selector: step.selector, count: targets.length,
              clickable: targets.length === 1 && clickable(targets[0], step),
              verifyCount: step.verify.selector ? document.querySelectorAll(step.verify.selector).length : null};
          })
          /* Legacy schedule scanning disabled in 2.1.4.
          , candidates: scope && request.profile.siteAdapter === 'nol-postseason' ?
            [...scope.querySelectorAll('button.grid-area_cta')].filter(b => normalize(b.textContent) === '예매하기').map(button => {
              const container = button.closest(request.profile.steps[0].containerSelector);
              const info = container?.querySelector('.grid-area_info');
              const lines = [info?.children[0]?.textContent, info?.children[1]?.children[0]?.textContent].map(normalize).filter(Boolean);
              return {label: lines.join(' · '), targetText: lines.length === 2 ? lines.join('\n') : '', disabled: button.disabled};
            }) : []
          */
        }); return false;
      }
    } catch (e) { respond({success: false, error: e.message,waitForPointer:!!e.waitForPointer}); return false; }
    return false;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !engine?.active || !changes.macroRun) return;
    const next = changes.macroRun.newValue;
    if (next?.id !== engine.run.id || next.stopRequested || !ACTIVE.includes(next.status)) {
      const same = next?.id === engine.run.id;
      if (same && next.logs) engine.run.logs = next.logs;
      engine.finish(next?.stopRequested ? next.stopReason || 'stopped' : same && !ACTIVE.includes(next.status) ? next.status : 'interrupted',
        same ? next.message || '제어 상태 변경: 안전 종료' : '제어 상태 변경: 안전 종료');
    }
  });
  addEventListener('pagehide', () => engine?.navigation());
  addEventListener('popstate', () => engine?.navigation());
  addEventListener('hashchange', () => engine?.navigation());
  for (const event of ['scroll','resize']) addEventListener(event, () => { if (engine?.active) engine.safe(() => engine.evaluate(event)); }, {capture:true,passive:true});
  addEventListener('visibilitychange', () => {
    if (engine?.active && document.hidden) engine.log('tab-hidden', '백그라운드 탭: Chrome 타이머/페이지 렌더링 지연 가능', 'warning');
  });
})();
