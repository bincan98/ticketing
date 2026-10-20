/* Read-only page analysis. All page helpers stay inside the serialized function. */
(function (root) {
  'use strict';
  function readPage() {
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const warnings = [], buttons = [], frames = [], roots = new WeakMap();
    let visited = 0, hiddenButtons = 0, shadowRoots = 0, closedShadowRoots = 0, truncated = false;
    const started = performance.now();
    const closedAccess = typeof chrome !== 'undefined' && typeof chrome.dom?.openOrClosedShadowRoot === 'function';
    function shadow(node) {
      if (roots.has(node)) return roots.get(node);
      let result = node.shadowRoot;
      if (!result && closedAccess && node instanceof HTMLElement) {
        try { result = chrome.dom.openOrClosedShadowRoot(node); }
        catch (e) { warnings.push('Shadow DOM 접근 실패: ' + node.localName + ' (' + e.message + ')'); }
      }
      roots.set(node, result || null); return result;
    }
    const parentOf = node => node.assignedSlot || node.parentElement || node.getRootNode()?.host || null;
    function visible(node) {
      if (!node.isConnected) return false;
      for (let parent = node; parent instanceof Element; parent = parentOf(parent)) {
        const style = getComputedStyle(parent);
        if (parent.hidden || style.display === 'none' || Number(style.opacity) === 0 ||
            style.contentVisibility === 'hidden') return false;
      }
      const style = getComputedStyle(node);
      if (['hidden', 'collapse'].includes(style.visibility)) return false;
      return [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    }
    function pathOf(node) {
      const parts = [];
      for (let current = node; current instanceof Element; current = current.parentElement) {
        if (current.id) { parts.unshift('#' + CSS.escape(current.id)); break; }
        const siblings = current.parentNode?.children ? [...current.parentNode.children].filter(n => n.localName === current.localName) : [current];
        parts.unshift(current.localName + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
      }
      const host = node.getRootNode()?.host;
      return (host ? pathOf(host) + ' >>> ' : '') + parts.join(' > ');
    }
    function displayedText(node) {
      if (node.localName === 'input') {
        return normalize(node.type === 'image' ? '' : node.value);
      }
      if (!shadow(node)) return normalize(node.innerText);
      // A role=button host can display its label inside a shadow root or a slot.
      const texts = [], seen = new Set(), stack = [node];
      while (stack.length && seen.size < 5000) {
        const current = stack.pop();
        if (seen.has(current)) continue; seen.add(current);
        if (current.nodeType === Node.TEXT_NODE) {
          const owner = current.parentElement;
          if (owner && visible(owner)) texts.push(current.textContent);
          continue;
        }
        if (current instanceof Element && (!visible(current) || ['script','style'].includes(current.localName))) continue;
        const assigned = current.localName === 'slot' ? current.assignedNodes({flatten: true}) : [];
        const children = assigned.length ? assigned : (shadow(current)?.childNodes || current.childNodes || []);
        stack.push(...[...children].reverse());
      }
      if (stack.length) { truncated = true; warnings.push('Shadow 버튼 글자 탐색 상한에 도달하여 일부 글자가 누락될 수 있습니다.'); }
      return normalize(texts.join(' '));
    }
    function labelOf(node) {
      const ids = normalize(node.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
      const scope = node.getRootNode();
      const labelled = normalize(ids.map(id => {
        const label = scope.getElementById?.(id) || document.getElementById(id);
        return label?.innerText || '';
      }).join(' '));
      return labelled || normalize(node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title'));
    }
    function disabledReasons(node) {
      const reasons = [];
      if (node.matches(':disabled') || node.disabled === true) reasons.push('native disabled (fieldset 포함)');
      for (let current = node; current instanceof Element; current = parentOf(current)) {
        if (normalize(current.getAttribute('aria-disabled')).toLowerCase() === 'true') reasons.push('aria-disabled=true' + (current === node ? '' : ' (조상)'));
        if (current.hasAttribute('inert')) reasons.push('inert' + (current === node ? '' : ' (조상)'));
      }
      if (getComputedStyle(node).pointerEvents === 'none') reasons.push('pointer-events:none (포인터 입력 비활성)');
      return [...new Set(reasons)];
    }
    const stack = [...document.children].reverse();
    while (stack.length) {
      if (++visited > 50000 || buttons.length >= 5000 || visited % 128 === 0 && performance.now() - started > 2000) {
        truncated = true; warnings.push('문서 탐색 상한(50,000 요소 / 5,000 버튼 / 약 2초)에 도달했습니다. 남은 요소 수는 알 수 없습니다.'); break;
      }
      const node = stack.pop();
      if (['script','style','template','noscript'].includes(node.localName)) continue;
      const isButton = node.matches('button,input[type="button" i],input[type="submit" i],input[type="reset" i],input[type="image" i],[role="button" i]');
      if (isButton) {
        if (!visible(node)) hiddenButtons++;
        else {
          const text = displayedText(node), reasons = disabledReasons(node), rect = node.getBoundingClientRect();
          buttons.push({text, accessibleLabel: labelOf(node), textSource: text ? 'displayed' : 'no-displayed-text',
            tag: node.localName, path: pathOf(node), disabled: reasons.length > 0, disabledReasons: reasons,
            inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
            shadow: node.getRootNode()?.host ? node.getRootNode().mode : ''});
        }
      }
      if (['iframe','frame'].includes(node.localName)) {
        let url = node.hasAttribute('srcdoc') ? 'about:srcdoc' : node.src || 'about:blank';
        try { if (node.contentDocument) url = node.contentDocument.URL; } catch { /* Cross-origin: worker checks access separately. */ }
        frames.push({url, path: pathOf(node), visible: visible(node)});
      }
      const nested = shadow(node);
      if (nested) { shadowRoots++; if (nested.mode === 'closed') closedShadowRoots++; }
      stack.push(...[...node.children].reverse());
      if (nested) stack.push(...[...nested.children].reverse());
    }
    if (!closedAccess) warnings.push('closed Shadow DOM 조회 API를 사용할 수 없습니다. 닫힌 루트의 존재·개수와 내부 버튼 누락 여부는 확인할 수 없습니다.');
    return {documentUrl: location.href, title: document.title, buttons, frames, warnings, truncated,
      coverage: {visited, hiddenButtons, shadowRoots, closedShadowRoots, closedShadowAccess: closedAccess}};
  }
  function formatResult(result) { return JSON.stringify(result, null, 2); }
  root.TicketAnalysis = {readPage, formatResult};
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TicketAnalysis;
})(globalThis);
