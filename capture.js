/* One-shot, read-only DOM capture. Serialized by scripting.executeScript(). */
(function (root) {
  'use strict';
  function readButtons(profile) {
    try {
    // Keep every helper inside the injected function: no extension globals in the page.
    const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
    const parentOf = node => node.assignedSlot || node.parentElement || node.getRootNode()?.host || null;
    const shadowOf = node => node.shadowRoot || (node.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      typeof globalThis.chrome?.dom?.openOrClosedShadowRoot === 'function' ? chrome.dom.openOrClosedShadowRoot(node) : null);
    function findAll(selector, root = document) {
      const parts = selector.split('>>>').map(part=>part.trim());
      if (parts.some(part=>!part)) throw new Error('Shadow 경로는 host >>> 내부 Selector 형태여야 합니다.');
      for (const part of parts) document.querySelectorAll(part);
      let roots=[root],nodes=[];
      for (let i=0;i<parts.length;i++) {
        nodes=roots.flatMap(context=>[...context.querySelectorAll(parts[i])]);
        if(i<parts.length-1)roots=nodes.map(shadowOf).filter(Boolean);
      }
      return nodes;
    }
    function contains(parent,node) {
      for(let current=node;current;current=parentOf(current))if(current===parent)return true;
      return false;
    }
    function visible(node) {
      if (!node?.isConnected) return false;
      for (let parent = node; parent instanceof Element; parent = parentOf(parent)) {
        const style = getComputedStyle(parent);
        if (parent.hidden || parent.hasAttribute('inert') || parent.getAttribute('aria-hidden') === 'true' ||
            style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function uniqueFor(selector, node) {
      if(!selector)return false;
      const nodes = findAll(selector);
      return nodes.length === 1 && nodes[0] === node;
    }
    function observedSelector(node, configured) {
      if (uniqueFor(configured, node)) return configured;
      const root=node.getRootNode(), prefix=root.host ? observedSelector(root.host,'')+' >>> ' : '';
      if (node.id) {
        const id = prefix + '#' + CSS.escape(node.id);
        if (uniqueFor(id, node)) return id;
      }
      // Derive only from the actual element's ancestry, without guessing site classes.
      const path = [];
      for (let current = node; current instanceof Element; current = current.parentElement) {
        const siblings = current.parentElement ? [...current.parentElement.children].filter(n => n.localName === current.localName) : [current];
        path.unshift(`${current.localName}:nth-of-type(${siblings.indexOf(current) + 1})`);
        const selector = prefix + path.join(' > ');
        if (uniqueFor(selector, node)) return selector;
      }
      throw new Error('가져온 버튼을 하나로 식별할 수 없습니다. 실제 DOM을 확인하세요.');
    }
    const step = profile.steps?.[0];
    if (!step?.selector || !profile.scopeSelector) throw new Error('이 프로필의 버튼 구조가 없습니다. 먼저 NOL 티켓 등 사이트 프로필을 선택하세요.');
    for (const selector of [step.selector, profile.scopeSelector, step.containerSelector, ...(profile.safetySelectors || [])].filter(Boolean)) {
      findAll(selector); // Reject invalid selectors without touching the DOM.
    }
    for (const selector of [...(profile.safetySelectors || []), 'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"]']) {
      if (findAll(selector).some(visible)) throw new Error('안내창·접근 제한·대기열 표시를 직접 확인한 뒤 정상 예매 대기 화면에서 가져오세요.');
    }
    const scopes = findAll(profile.scopeSelector);
    const nolPrimary = node => profile.siteAdapter === 'nol-gate' && !profile.frameUrl &&
      node.matches('button._primary_2p3w6_7:has(> span._content_2p3w6_38)');
    const countdown = label => /^남은\s*시간\s+(\d{1,3}):([0-5]\d)$/.exec(label);
    const found = findAll(step.selector).filter(node => {
      if (!visible(node) || !['button', 'input', 'a'].includes(node.localName) && node.getAttribute('role') !== 'button') return false;
      if (!scopes.some(scope => contains(scope,node))) return false;
      const label = normalize(node.innerText || node.textContent || node.value);
      if (!label || label.length > 2000 || profile.siteAdapter === 'nol-gate' &&
          !label.includes('예매') && !(nolPrimary(node) && countdown(label))) return false;
      if (step.targetText) {
        const container = node.closest(step.containerSelector);
        if (!container || !step.targetText.split('\n').map(normalize).filter(Boolean).every(text => normalize(container.textContent).includes(text))) return false;
      }
      return true;
    });
    if (!found.length) throw new Error('현재 화면에서 예매 버튼을 찾지 못했습니다. 버튼이 보이는 대기 화면인지 확인하세요. 사이트 구조가 달라졌다면 DOM 확인이 필요합니다.');
    if (found.length > 20) throw new Error('버튼 후보가 너무 많습니다. 관찰 영역과 클릭 Selector를 좁혀 주세요.');
    return {documentUrl: location.href, buttons: found.map(node => {
      const selector = observedSelector(node, step.selector);
      const containingScopes = scopes.filter(scope => contains(scope,node));
      const closestScope = containingScopes.reduce((closest, scope) => closest && contains(closest,scope) ? scope : closest, containingScopes[0]);
      const scopeSelector = observedSelector(closestScope, profile.scopeSelector);
      const text = normalize(node.innerText || node.textContent || node.value);
      const context = step.containerSelector ? node.closest(step.containerSelector) : node.parentElement;
      const remaining = nolPrimary(node) && countdown(text);
      return {text, selector, scopeSelector, disabled: !!node.disabled || node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true' ||
          nolPrimary(node) && node.classList.contains('_disabled_2p3w6_34'),
        ...(nolPrimary(node) ? {nolPrimary:true, remainingSeconds:remaining ? Number(remaining[1])*60+Number(remaining[2]) : null} : {}),
        contextText: context && context !== document.body ? normalize(context.innerText || context.textContent).slice(0, 160) : text};
    })};
    } catch(error) { return {captureError:error?.message || String(error)}; }
  }
  root.TicketCapture = {readButtons};
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TicketCapture;
})(globalThis);
