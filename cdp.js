/* Session-scoped chrome.debugger transport. No fallback or automatic replay. */
(function (root) {
  'use strict';
  const active = run => !!run && ['starting','scheduled','watching','verifying','repeat-wait','stopping'].includes(run.status);
  const pointerError = message => Object.assign(new Error(message),{waitForPointer:true});
  const rootSignature = local => JSON.stringify([local.documentToken,local.viewport,local.viewportKey,local.x,local.y]);
  // Runs in a CDP isolated world in the iframe OWNER's document. No clicks or page-world code.
  function ownerPoint(x, y, width, height) {
    const frame = this, win = frame.ownerDocument.defaultView;
    if (!frame.isConnected || !['IFRAME','FRAME'].includes(frame.tagName)) throw new Error('iframe 소유 요소가 교체되었습니다.');
    const parentOf = node => node.assignedSlot || node.parentElement || node.getRootNode()?.host || null;
    const visual = win.visualViewport;
    if (visual && (Math.abs(visual.scale-1)>0.001 || Math.abs(visual.offsetLeft)>0.001 || Math.abs(visual.offsetTop)>0.001)) throw new Error('부모 문서의 pinch zoom 좌표는 지원하지 않습니다.');
    for (let node = frame; node; node = parentOf(node)) {
      const style = win.getComputedStyle(node);
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          ['hidden','collapse'].includes(style.visibility) || Number(style.opacity) === 0) throw new Error('부모 iframe이 숨김 상태입니다.');
      if (style.perspective !== 'none' || style.rotate && style.rotate !== 'none') throw new Error('회전/3D iframe 좌표는 지원하지 않습니다.');
      if (style.scale && style.scale !== 'none' && style.scale.split(/\s+/).some(value => !Number.isFinite(Number(value)) || Number(value)<=0)) throw new Error('반전된 iframe 좌표는 지원하지 않습니다.');
      if (style.transform !== 'none') {
        const matrix = new win.DOMMatrixReadOnly(style.transform);
        if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a<=0 || matrix.d<=0) throw new Error('회전/기울임/반전된 iframe 좌표는 지원하지 않습니다.');
      }
    }
    const r = frame.getBoundingClientRect(), sx = r.width/frame.offsetWidth, sy = r.height/frame.offsetHeight;
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx<=0 || sy<=0 || Math.abs(frame.clientWidth-width)>1 || Math.abs(frame.clientHeight-height)>1) throw new Error('iframe의 CSS 픽셀 크기를 확인할 수 없습니다.');
    x = r.left+(frame.clientLeft+x)*sx; y = r.top+(frame.clientTop+y)*sy;
    let hit = frame.ownerDocument.elementFromPoint(x,y);
    for (let i=0; hit && i<20; i++) {
      const inner = hit.shadowRoot?.elementFromPoint(x,y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (x<0 || y<0 || x>=win.innerWidth || y>=win.innerHeight || hit!==frame) throw new Error('iframe이 부모 화면 밖이거나 다른 요소에 가려져 있습니다.');
    return {x,y,viewport:{width:win.innerWidth,height:win.innerHeight,scrollX:win.scrollX,scrollY:win.scrollY},
      geometry:[r.left,r.top,r.width,r.height,sx,sy,frame.clientLeft,frame.clientTop,win.scrollX,win.scrollY,win.innerWidth,win.innerHeight,win.devicePixelRatio,win.location.href]};
  }
  class Controller {
    constructor(api, interrupt, commitInput, sendDocument) {
      this.api = api; this.interrupt = interrupt; this.session = null;
      this.sendDocument=sendDocument || ((session,request)=>this.api.tabs.sendMessage(session.run.tabId,request,{documentId:session.run.documentId}));
      this.commitInput = commitInput || ((session,request,marker)=>this.api.storage.local.set({ticketCdpSession:marker}));
      api.debugger?.onEvent?.addListener((source,method,params) => this.frameEvent(source,method,params));
      api.debugger?.onDetach.addListener((source, reason) => {
        const session = this.session;
        if (!session) {
          this.api.storage.local.get(['ticketCdpSession','macroRun']).then(async ({ticketCdpSession:stored,macroRun}) => {
            if (!stored || stored.tabId !== source.tabId) return;
            await this.api.storage.local.set({ticketCdpSession:null});
            if (macroRun?.id === stored.runId) await this.interrupt(macroRun,'CDP 디버거 연결 해제: ' + reason + '. 자동 재연결 없이 종료합니다.');
          }).catch(console.error);
          return;
        }
        if (source.tabId !== session.run.tabId || source.sessionId || session.closing) return;
        session.canceled = true; session.detached = true;
        this.interrupt(session.run, 'CDP 디버거 연결 해제: ' + reason + '. 재연결/JavaScript 전환 없이 종료합니다.').catch(console.error);
        this.end(session.run.id).catch(console.error);
      });
    }
    matches(run) { return this.session?.run.id === run.id && !this.session.canceled; }
    cancel(runId) { if (this.session && (!runId || this.session.run.id === runId)) this.session.canceled = true; }
    releaseOwner(session, owner) {
      if(session.detached)return Promise.resolve();
      const job=this.command(session,'Runtime.releaseObject',{objectId:owner.objectId},owner.sessionId).catch(()=>{});
      session.cacheDisposals.add(job);job.then(()=>session.cacheDisposals.delete(job));
      return job;
    }
    invalidateFrames(session, clearWorlds = false) {
      session.frameRevision=(session.frameRevision||0)+1;session.mappingCache=null;
      if(clearWorlds)session.worlds.clear();
      const owners=[...session.ownerCache.values()];session.ownerCache.clear();
      for(const owner of owners)this.releaseOwner(session,owner);
    }
    async drainFrameCache(session) {
      await Promise.allSettled([...session.ownerLoads.values()]);
      await Promise.allSettled([...session.cacheDisposals]);
    }
    async frameOwner(session, frame, parent, revision) {
      if(session.canceled||session.closing||revision!==session.frameRevision)throw pointerError('iframe 문서 정보가 변경되었습니다. 마우스를 다시 이동해 주세요.');
      const key=JSON.stringify([revision,frame.id,frame.loaderId,parent.id,parent.loaderId,parent.sessionId]);
      const cached=session.ownerCache.get(key);
      if(cached)return {...cached,cacheHit:true};
      const pending=session.ownerLoads.get(key);if(pending)return pending;
      const loading=(async()=>{
        const worldKey=parent.id+':'+parent.loaderId,existing=session.worlds.get(worldKey);
        const [owner,worldResult]=await Promise.all([
          this.command(session,'DOM.getFrameOwner',{frameId:frame.id},parent.sessionId),
          existing ? Promise.resolve({executionContextId:existing}) : this.command(session,'Page.createIsolatedWorld',{frameId:parent.id,worldName:'ticket-cdp-geometry'},parent.sessionId)
        ]);
        const world=worldResult.executionContextId;
        if(revision!==session.frameRevision||session.canceled||session.closing)throw pointerError('iframe 소유 요소 조회 중 문서가 변경되었습니다.');
        session.worlds.set(worldKey,world);
        const node=await this.command(session,'DOM.resolveNode',{backendNodeId:owner.backendNodeId,executionContextId:world},parent.sessionId);
        const objectId=node.object?.objectId;if(!objectId)throw new Error('CDP iframe 소유 요소를 조회할 수 없습니다.');
        const entry={objectId,backendNodeId:owner.backendNodeId,sessionId:parent.sessionId,world};
        if(revision!==session.frameRevision||session.canceled||session.closing||this.session!==session){
          await this.releaseOwner(session,entry);throw pointerError('iframe 소유 요소 확인 중 문서가 변경되었습니다.');
        }
        if(session.ownerCache.size>=32){await this.releaseOwner(session,entry);throw new Error('iframe 소유 요소 캐시 상한을 초과했습니다.');}
        session.ownerCache.set(key,entry);return {...entry,cacheHit:false};
      })();
      session.ownerLoads.set(key,loading);
      try{return await loading;}finally{if(session.ownerLoads.get(key)===loading)session.ownerLoads.delete(key);}
    }
    frameEvent(source, method, params) {
      const session = this.session;
      if (!session?.framesEnabled || session.canceled || session.closing || source.tabId !== session.run.tabId || source.sessionId && !session.children.has(source.sessionId)) return;
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
        this.invalidateFrames(session);
        if (session.children.size>=50) {
          session.frameError='CDP iframe 세션 50개 상한을 초과했습니다.';session.canceled=true;
          this.interrupt(session.run,session.frameError).catch(console.error);return;
        }
        const child = {id:params.sessionId,parent:source.sessionId};
        session.children.set(child.id,child);
        child.ready = this.enableFrames(session,child.id);
        child.ready.catch(e => {
          session.frameError=e.message;
          if (!session.closing && !session.canceled) { session.canceled=true;this.interrupt(session.run,'CDP iframe 연결 실패: '+e.message).catch(console.error); }
        });
      } else if (method === 'Target.detachedFromTarget') {
        this.invalidateFrames(session,true);
        const removed = new Set([params.sessionId]);
        for (const child of session.children.values()) if (removed.has(child.parent)) removed.add(child.id);
        for (const id of removed) session.children.delete(id);
        for (const [key,item] of session.contexts) if (removed.has(item.sessionId)) session.contexts.delete(key);
      } else if (method === 'Runtime.executionContextCreated') {
        const context = params.context;
        if (context.origin === 'chrome-extension://'+this.api.runtime.id && context.auxData?.isDefault === false) {
          this.invalidateFrames(session);
          session.contexts.set((source.sessionId || '')+':'+context.id,{...context,sessionId:source.sessionId});
        }
      } else if (method === 'Runtime.executionContextDestroyed' || method === 'Runtime.executionContextsCleared') {
        this.invalidateFrames(session,true);
        for (const [key,item] of session.contexts) if (item.sessionId === source.sessionId &&
            (method === 'Runtime.executionContextsCleared' || item.id === params.executionContextId || item.uniqueId && item.uniqueId===params.executionContextUniqueId)) {
          session.contexts.delete(key);
        }
      } else if(['Page.frameAttached','Page.frameDetached','Page.frameNavigated','Page.navigatedWithinDocument','Page.documentOpened'].includes(method)) {
        this.invalidateFrames(session,true);
      }
    }
    async enableFrames(session, sessionId) {
      await Promise.all([this.command(session,'Runtime.enable',{},sessionId),this.command(session,'Page.enable',{},sessionId)]);
      await this.command(session,'Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false}]},sessionId);
    }
    async recover() {
      const {ticketCdpSession: stored, macroRun} = await this.api.storage.local.get(['ticketCdpSession','macroRun']);
      if (!stored) return;
      let error;
      if (stored.state === 'input-claimed') {
        try {
          // Cancel a potentially held press on our old session, without attaching or replaying a press.
          await this.command({run:{tabId:stored.tabId}}, 'Input.dispatchMouseEvent', {type:'mouseReleased',x:-1,y:-1,button:'left',buttons:0,clickCount:0,pointerType:'mouse'}, stored.inputSessionId);
        } catch { /* An already-detached/closed tab cannot receive this cleanup. */ }
      }
      try { await this.api.debugger.detach({tabId: stored.tabId}); }
      catch (e) {
        // Chrome may already have detached on reload; do not discard ownership of a live session.
        try { await this.api.debugger.sendCommand({tabId:stored.tabId}, 'Page.getLayoutMetrics', {}); error = e; }
        catch (confirmation) { if (!/not attached|No tab|No target|Target closed/i.test(confirmation.message)) error = e; }
      }
      if (!error) await this.api.storage.local.set({ticketCdpSession: null});
      if (active(macroRun) && macroRun.id === stored.runId) {
        await this.interrupt(macroRun, 'CDP 서비스 워커 재시작: 입력 재전송 없이 종료합니다.' + (error ? ' 연결 해제 확인 실패: ' + error.message : ''));
      }
    }
    async start(run) {
      if (this.session || (await this.api.storage.local.get('ticketCdpSession')).ticketCdpSession) throw new Error('이전 CDP 연결이 정리되지 않았습니다. 확장을 다시 로드하고 디버거 연결 상태를 확인하세요.');
      if (!this.api.debugger || !await this.api.permissions.contains({permissions:['debugger']})) throw new Error('debugger 권한이 없습니다. 확장 업데이트/권한 승인을 확인하세요.');
      const session = {run, canceled:false, closing:false, detached:false, claims:new Set(), mouseDown:false,
        children:new Map(),contexts:new Map(),worlds:new Map(),ownerCache:new Map(),ownerLoads:new Map(),cacheDisposals:new Set(),mappingCache:null,
        frameRevision:0,framesEnabled:run.frameId!==0};
      this.session = session;
      try {
        await this.api.storage.local.set({ticketCdpSession:{runId:run.id,tabId:run.tabId,state:'attaching'}});
        await this.api.debugger.attach({tabId:run.tabId}, '1.3');
        session.attached = true;
        if (session.framesEnabled) await this.enableFrames(session);
        await this.api.storage.local.set({ticketCdpSession:{runId:run.id,tabId:run.tabId,state:'attached'}});
        if (session.canceled) throw new Error('연결 중 실행이 중지되었습니다.');
      } catch (e) {
        if (session.attached) await this.end(run.id);
        else { this.session = null; await this.api.storage.local.set({ticketCdpSession:null}); }
        throw new Error('CDP 연결 실패: ' + e.message + '. debugger 권한, F12/다른 디버거 연결 충돌 및 Chrome 정책을 확인하세요.');
      }
    }
    async live(session) {
      // These reads are independent. The window lookup depends only on tab info.
      const tabRead = this.api.tabs.get(session.run.tabId);
      const windowRead = tabRead.then(tab => this.api.windows && Number.isInteger(tab.windowId) ? this.api.windows.get(tab.windowId) : null);
      const [{macroRun}, tab, [focused], frameList, window] = await Promise.all([
        this.api.storage.local.get('macroRun'), tabRead,
        this.api.tabs.query({active:true,currentWindow:true}),
        this.api.webNavigation.getAllFrames({tabId:session.run.tabId}), windowRead
      ]);
      // Stop/detach can arrive while reads are pending; check again afterwards.
      if (this.session !== session || session.canceled || session.closing || !active(macroRun) || macroRun.stopRequested || macroRun.id !== session.run.id) throw new Error('CDP 실행이 중지되거나 세션이 소실되었습니다.');
      if (window && !window.focused) throw pointerError('Chrome 창에 포커스를 두고 예매 버튼에 마우스를 이동해 주세요.');
      if (focused?.id !== session.run.tabId || tab.url !== session.run.topUrl) throw new Error('CDP 대상 탭이 활성 탭이 아니거나 주소가 변경되었습니다.');
      const frames = frameList || [];
      if (!frames.some(f => f.frameId === session.run.frameId && f.documentId === session.run.documentId) ||
          session.run.topDocumentId && !frames.some(f => f.frameId === 0 && f.documentId === session.run.topDocumentId)) throw new Error('CDP 대상 문서/iframe이 교체되었습니다.');
    }
    wait(promise, label, timeoutMs = 5000) {
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(new Error('응답 시간 초과: ' + label)), timeoutMs);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
      });
    }
    command(session, method, params, sessionId) { return this.wait(this.api.debugger.sendCommand({tabId:session.run.tabId,...(sessionId ? {sessionId} : {})},method,params), 'CDP ' + method); }
    async framePoint(session, local, attemptId, prepareInput, refresh = 0) {
      if (!session.framesEnabled || typeof local.documentToken !== 'string') throw new Error('CDP iframe 문서 식별 정보가 없습니다.');
      if(session.canceled||session.closing)throw new Error('CDP iframe 조회 전에 실행이 중지되었습니다.');
      const stored=session.mappingCache;
      const cacheHit=!!stored&&stored.revision===session.frameRevision&&stored.token===local.documentToken&&stored.url===local.documentUrl&&
        [...session.contexts.values()].includes(stored.context);
      let revision,frames,root,context;
      const tokenRead=context=>this.command(session,'Runtime.evaluate',{
        ...(context.uniqueId?{uniqueContextId:context.uniqueId}:{contextId:context.id}),
        expression:'globalThis.__ticketCdpDocumentToken',returnByValue:true},context.sessionId);
      if(cacheHit){
        revision=session.frameRevision;frames=stored.frames;root=stored.root;context=stored.context;
        let token;
        try{token=await tokenRead(context);}catch(error){
          this.invalidateFrames(session,true);
          if(!prepareInput&&!session.mouseDown&&!session.canceled&&!session.closing&&refresh<3)return this.framePoint(session,local,attemptId,prepareInput,refresh+1);
          throw pointerError('캐시된 iframe 문서 확인 실패: '+error.message);
        }
        if(token.exceptionDetails||token.result?.value!==local.documentToken){this.invalidateFrames(session,true);throw new Error('CDP iframe 문서 식별 정보가 변경되었습니다.');}
      }else{
      // Auto-attach is recursive; wait for each newly discovered child's setup, with a bounded tree.
      for (let i=0, count=-1; i<50 && count!==session.children.size; i++) {
        count=session.children.size;
        await this.wait(Promise.all([...session.children.values()].map(child=>child.ready)),'iframe 하위 세션 준비');
      }
      if (session.frameError) throw new Error('CDP iframe 연결 실패: '+session.frameError);
      revision=session.frameRevision||0;const children=[...session.children.values()],contexts=[...session.contexts.values()];
      frames=new Map();
      const add=(tree,sessionId)=>{
        const frame=tree.frame,old=frames.get(frame.id);
        frames.set(frame.id,{...old,...frame,parentId:frame.parentId || old?.parentId,sessionId});
        for (const child of tree.childFrames || []) add(child,sessionId);
      };
      // Frame inventories and token reads are independent. Geometry still waits
      // for all of them, and a changed context inventory invalidates the result.
      const [trees,tokens]=await Promise.all([
        Promise.all([undefined,...children.map(child=>child.id)].map(id=>this.command(session,'Page.getFrameTree',{},id))),
        Promise.all(contexts.map(tokenRead))
      ]);
      if((session.frameRevision||0)!==revision){
        if(!prepareInput && !session.mouseDown && !session.canceled && !session.closing && refresh<3)return this.framePoint(session,local,attemptId,prepareInput,refresh+1);
        throw pointerError('조회 중 iframe 문서 정보가 변경되었습니다. 마우스를 다시 이동해 주세요.');
      }
      root=trees[0];add(root.frameTree);
      children.forEach((child,index)=>add(trees[index+1].frameTree,child.id));
      const matches=contexts.filter((context,index)=>!tokens[index].exceptionDetails && tokens[index].result?.value===local.documentToken);
      if (matches.length!==1) throw new Error('CDP와 확장 프로그램의 iframe 문서를 하나로 연결할 수 없습니다.');
      context=matches[0];
      }
      if(session.frameRevision!==revision){
        if(!prepareInput&&!session.mouseDown&&!session.canceled&&!session.closing&&refresh<3)return this.framePoint(session,local,attemptId,prepareInput,refresh+1);
        throw pointerError('조회 중 iframe 문서 정보가 변경되었습니다. 마우스를 다시 이동해 주세요.');
      }
      let frame=frames.get(context.auxData.frameId);
      if (!frame || frame.url+(frame.urlFragment || '')!==local.documentUrl) throw new Error('CDP iframe URL/문서가 변경되었습니다.');
      // Input coordinates belong to the main frame of the chosen protocol session.
      // OOPIF input uses its own session; parent geometry is still checked to prevent covered/offscreen input.
      const input={x:local.x,y:local.y,sessionId:frame.sessionId};let inputRootReached=false;
      if (prepareInput && !session.mouseDown) {
        session.inputSessionId=input.sessionId;
        // Once the exact input route is known, the durable claim and read-only
        // parent geometry are independent. validate() joins this same claim
        // before its final pointer RPC; perform() drains it on every failure.
        Promise.resolve(prepareInput(input.sessionId)).catch(()=>{});
      }
      let point={...local},ownerCacheHits=0;const geometry=[],seen=new Set();
      while (frame.id!==root.frameTree.frame.id) {
        if (seen.has(frame.id) || seen.size>=16) throw new Error('iframe 부모 경로가 순환하거나 너무 깊습니다.');
        seen.add(frame.id);
        const parent=frames.get(frame.parentId);
        if (!parent) throw new Error('CDP iframe의 부모 문서를 확인할 수 없습니다.');
        let owner;
        try{owner=await this.frameOwner(session,frame,parent,revision);}catch(error){
          if(error.waitForPointer&&!prepareInput&&!session.mouseDown&&!session.canceled&&!session.closing&&refresh<3)return this.framePoint(session,local,attemptId,prepareInput,refresh+1);
          throw error;
        }
        const objectId=owner.objectId;
        if(owner.cacheHit)ownerCacheHits++;
        let result;
        try {
          result=await this.command(session,'Runtime.callFunctionOn',{objectId,functionDeclaration:ownerPoint.toString(),returnByValue:true,
            arguments:[point.x,point.y,point.viewport.width,point.viewport.height].map(value=>({value}))},parent.sessionId);
        } catch(error) {
          this.invalidateFrames(session,true);throw error;
        }
        if (result.exceptionDetails || !result.result?.value) {
          this.invalidateFrames(session,true);
          const message=result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || 'iframe 좌표 확인 실패';
          throw /마우스가 없습니다/.test(message)?pointerError('예매 버튼에 마우스를 이동해 주세요.'):new Error(message);
        }
        point=result.result.value;
        if (parent.sessionId!==input.sessionId) inputRootReached=true;
        if (!inputRootReached) { input.x=point.x;input.y=point.y; }
        geometry.push([frame.id,frame.loaderId,parent.id,parent.loaderId,owner.backendNodeId,point.geometry]);
        frame=parent;
      }
      if (frame.url+(frame.urlFragment || '')!==session.run.topUrl) throw new Error('CDP 최상위 문서가 변경되었습니다.');
      if((session.frameRevision||0)!==revision){
        if(!prepareInput && !session.mouseDown && !session.canceled && !session.closing && refresh<3)return this.framePoint(session,local,attemptId,prepareInput,refresh+1);
        throw pointerError('좌표 확인 중 iframe 문서 정보가 변경되었습니다. 마우스를 다시 이동해 주세요.');
      }
      if(session.canceled||session.closing)throw new Error('CDP iframe 좌표 확인 중 실행이 중지되었습니다.');
      session.mappingCache={revision,token:local.documentToken,url:local.documentUrl,frames,root,context};
      point.frameCacheHit=cacheHit;point.ownerCacheHits=ownerCacheHits;
      point.input=input;point.signature=JSON.stringify([local.signature,input,geometry]);
      point.parentSignature=JSON.stringify([local.documentToken,local.viewport,local.viewportKey,input,geometry]);
      return point;
    }
    senderSession(request,sender) {
      const session=this.session,run=session?.run;
      if (!run || sender.id!==this.api.runtime.id || sender.tab?.id!==run.tabId || sender.frameId!==run.frameId || sender.documentId!==run.documentId || request.runId!==run.id) throw new Error('CDP 요청 탭/프레임/문서/실행 ID가 일치하지 않습니다.');
      if (!request.point || typeof request.point.signature!=='string' || !Number.isFinite(request.point.x) || !Number.isFinite(request.point.y) || request.point.x<0 || request.point.y<0) throw new Error('CDP 좌표/요청 형식이 올바르지 않습니다.');
      return session;
    }
    async anchor(request,sender) {
      const session=this.senderSession(request,sender);
      if(session.flight || session.mouseDown)throw pointerError('입력 중에는 새 마우스 위치를 등록하지 않습니다.');
      await this.live(session);
      const mapped=request.point.space==='frame'?await this.framePoint(session,request.point,null,false):{...request.point,parentSignature:rootSignature(request.point)};
      const result=await this.wait(this.sendDocument(session,
        {action:'validateCdpPointer',runId:session.run.id,pointerRevision:request.point.pointerRevision}),'사용자 마우스 위치 확인');
      if(!result?.success || result.point?.signature!==request.point.signature)throw pointerError(result?.error || '현재 마우스 좌표가 변경되었습니다.');
      if(session.canceled || session.closing)throw new Error('CDP 실행이 중지되었습니다.');
      return {success:true,parentSignature:mapped.parentSignature};
    }
    async validate(session, request, afterPress = false, prepareInput) {
      const live=this.live(session);
      // Only the viewport query can start early. Parent geometry and the final
      // pointer check remain after the page response, so delayed replies cannot
      // approve an old iframe position.
      const earlyMetrics=afterPress && request.intent?.lastAttempt?.eventType!=='pointerdown' ? this.command(session,'Page.getLayoutMetrics',{}).then(value=>({value}),error=>({error})) : null;
      if (afterPress) {
        // Both reads are independent. The page response alone cannot authorize
        // a release: the live tab/run/document check must finish successfully.
        const [,completed]=await Promise.all([live,Promise.resolve().then(()=>this.wait(this.sendDocument(session,
          {action:'validateCdpTarget',runId:session.run.id,attemptId:request.attemptId,afterPress:true}),'눌림 이후 페이지 완료 확인'))]);
        if (!completed?.success) throw completed?.waitForPointer?pointerError(completed.error):new Error(completed?.error || '눌림 이후 대상 검증 실패');
        if(this.session!==session||session.canceled||session.closing)throw new Error('CDP 눌림 이후 실행이 중지되었습니다.');
        if (completed.completedOnPress) {
          const metrics=await earlyMetrics;if(metrics?.error)throw metrics.error;
          if(this.session!==session||session.canceled||session.closing)throw new Error('CDP 눌림 이후 실행이 중지되었습니다.');
          return {completedOnPress:true};
        }
      }
      // Read-only protocol queries can overlap the first Chrome API reads.
      // The durable write still waits for a valid live session.
      const guardedInput=prepareInput&&(async inputSessionId=>{await live;if(session.canceled||session.closing)throw new Error('입력 의도 저장 전에 중지되었습니다.');return prepareInput(inputSessionId);});
      const [,metrics,mapped]=await Promise.all([
        live,
        earlyMetrics ? earlyMetrics.then(result=>{if(result.error)throw result.error;return result.value;}) : this.command(session,'Page.getLayoutMetrics',{}),
        request.point.space==='frame' ? this.framePoint(session,request.point,request.attemptId,guardedInput) :
          (async()=>{if(guardedInput)await guardedInput(undefined);return request.point;})()
      ]);
      // The real frame route prepares before parent geometry. This also handles
      // a top-level point (and validates the final route before the last RPC).
      if(guardedInput)await guardedInput(mapped.input?.sessionId);
      const signature=mapped.parentSignature || rootSignature(request.point);
      if(request.point.pointerAnchor!==signature)throw pointerError('마우스 위치 확인 후 화면/iframe 좌표가 변경되었습니다. 예매 버튼에 마우스를 다시 이동해 주세요.');
      if (request.mappedPoint && (request.mappedPoint.signature!==mapped.signature || request.mappedPoint.x!==mapped.x || request.mappedPoint.y!==mapped.y)) throw new Error('CDP iframe 좌표/스크롤/문서가 변경되었습니다. 재클릭하지 않습니다.');
      request.mappedPoint ||= mapped;
      // Last RPC rechecks the recorded pointer after the parent geometry queries.
      const result = await this.wait(this.sendDocument(session,
        {action:'validateCdpTarget',runId:session.run.id,attemptId:request.attemptId}), '클릭 대상 문서 확인');
      if (!result?.success) throw result?.waitForPointer?pointerError(result.error):new Error(result?.error || 'CDP 클릭 직전 마우스 좌표 확인 실패');
      const point = result.point;
      if (!point || point.signature !== request.point.signature || point.x !== request.point.x || point.y !== request.point.y) throw new Error('CDP 클릭 좌표/스크롤/배율이 변경되었습니다. 재클릭하지 않습니다.');
      const viewport = metrics.cssLayoutViewport;
      if (!viewport || Math.abs(viewport.clientWidth - mapped.viewport.width) > 1 || Math.abs(viewport.clientHeight - mapped.viewport.height) > 1 ||
          Math.abs(viewport.pageX - mapped.viewport.scrollX) > 1 || Math.abs(viewport.pageY - mapped.viewport.scrollY) > 1 ||
          metrics.cssVisualViewport?.scale && Math.abs(metrics.cssVisualViewport.scale - 1) > 0.001) throw new Error('CDP와 DOM의 CSS 픽셀 좌표 체계를 확인할 수 없습니다. pinch zoom/뷰포트 변경을 확인하세요.');
      if (session.canceled || session.closing) throw new Error('CDP 입력 직전에 중지되었습니다.');
      return mapped;
    }
    click(request, sender) {
      let session;
      try {session=this.senderSession(request,sender);}catch(error){return Promise.reject(error);}
      if (session.flight || session.claims.has(request.attemptId)) return Promise.reject(new Error('중복 CDP 클릭 요청을 거부했습니다.'));
      if (typeof request.attemptId !== 'string' || request.attemptId.length > 200 || !request.point || typeof request.point.signature !== 'string' ||
          !Number.isFinite(request.point.x) || !Number.isFinite(request.point.y) || request.point.x < 0 || request.point.y < 0) return Promise.reject(new Error('CDP 좌표/요청 형식이 올바르지 않습니다.'));
      if(typeof request.point.pointerAnchor!=='string' || !request.point.pointerAnchor || !Number.isInteger(request.point.pointerRevision))return Promise.reject(new Error('사용자 마우스 위치 정보가 없습니다. 확장과 페이지를 새로고침하고 예매 버튼에 마우스를 이동해 주세요.'));
      session.claims.add(request.attemptId);
      session.flight = this.perform(session, request).finally(() => { session.flight = null; });
      return session.flight;
    }
    async perform(session, request) {
      let inputStartedAt,claim,aborted=false;
      try {
        const timings={};
        const prepareInput=inputSessionId=>{
          if(aborted)throw new Error('취소된 CDP 사전 검증의 입력 의도는 저장하지 않습니다.');
          if(claim){
            if(claim.inputSessionId!==inputSessionId)throw new Error('입력 의도 저장 이후 CDP 입력 세션이 변경되었습니다.');
            return claim.promise;
          }
          if(this.session!==session || session.canceled || session.closing)throw new Error('입력 의도 저장 전에 실행이 중지되었습니다.');
          session.inputSessionId=inputSessionId;
          const marker={runId:session.run.id,tabId:session.run.tabId,state:'input-claimed',attemptId:request.attemptId,inputSessionId};
          claim={inputSessionId};const claimAt=performance.now();
          claim.promise=Promise.resolve(this.commitInput(session,request,marker)).then(()=>{timings.claimPersistMs=performance.now()-claimAt;});
          return claim.promise;
        };
        const preflightAt=performance.now();
        const point = await this.validate(session, request, false, prepareInput);
        timings.cdpPreflightMs=performance.now()-preflightAt;
        timings.frameCacheHit=!!point.frameCacheHit;timings.ownerCacheHits=point.ownerCacheHits||0;
        const input = point.input || point;
        await prepareInput(input.sessionId);
        if(this.session!==session || session.canceled || session.closing)throw new Error('CDP 입력 직전에 실행이 중지되었습니다.');
        // A press can reach the page even when its command response fails.
        session.mouseDown = true; inputStartedAt = session.inputStartedAt = Date.now();
        const pressAt=performance.now();
        await this.command(session, 'Input.dispatchMouseEvent', {type:'mousePressed',x:input.x,y:input.y,button:'left',buttons:1,clickCount:1,pointerType:'mouse'}, input.sessionId);
        timings.pressCommandMs=performance.now()-pressAt;
        const afterPressAt=performance.now();
        const afterPress=await this.validate(session, request, true);
        timings.afterPressCheckMs=performance.now()-afterPressAt;
        const release=afterPress.completedOnPress ? {x:-1,y:-1,clickCount:0} : {x:input.x,y:input.y,clickCount:1};
        const releaseAt=performance.now();
        await this.command(session, 'Input.dispatchMouseEvent', {type:'mouseReleased',...release,button:'left',buttons:0,pointerType:'mouse'}, input.sessionId);
        timings.releaseCommandMs=performance.now()-releaseAt;
        session.mouseDown = false;
        return {success:true,inputStartedAt,inputFinishedAt:Date.now(),completedOnPress:!!afterPress.completedOnPress,zoomFactor:await this.api.tabs.getZoom(session.run.tabId),timings};
      } catch (e) {
        aborted=true;
        // Parallel reads can fail while the durable write is pending. Drain it
        // before resetting ownership or letting end() clear the session marker.
        await claim?.promise?.catch(()=>{});
        if(e.waitForPointer && !inputStartedAt && !session.canceled && !session.closing) {
          this.invalidateFrames(session,true);
          await this.api.storage.local.set({ticketCdpSession:{runId:session.run.id,tabId:session.run.tabId,state:'attached'}});
          return {success:false,waitForPointer:true,error:e.message};
        }
        session.canceled = true;
        if (session.mouseDown && !session.detached) {
          // Cancel the pressed state outside the viewport; never release on another button.
          try { await this.command(session, 'Input.dispatchMouseEvent', {type:'mouseReleased',x:-1,y:-1,button:'left',buttons:0,clickCount:0,pointerType:'mouse'}, session.inputSessionId); }
          catch { /* Detach clears ownership; never resend mousePressed. */ }
          session.mouseDown = false;
        }
        this.invalidateFrames(session,true);
        throw new Error('CDP 입력 실패: ' + e.message + '. '+(inputStartedAt ? '일부 입력이 전달되었을 수 있습니다.' : '마우스 입력을 전송하기 전에 중단했습니다.')+' 재시도/JavaScript 전환 없이 종료합니다.');
      } finally {
        // Cached owners belong to this run. Success keeps them for later steps;
        // failed/canceled work and end() drain pending creation/disposal first.
        if(session.canceled)await this.drainFrameCache(session);
      }
    }
    async end(runId) {
      const session = this.session;
      if (!session || session.run.id !== runId) return;
      if (session.endPromise) return session.endPromise;
      session.canceled = true; session.closing = true;
      session.endPromise = (async () => {
        await session.flight?.catch(() => {});
        this.invalidateFrames(session,true);await this.drainFrameCache(session);
        try {
          if (session.attached && !session.detached) {
            try { await this.api.debugger.detach({tabId:session.run.tabId}); }
            catch (e) { if (!/not attached|No tab|No target|Target closed/i.test(e.message)) throw e; }
          }
          const stored = (await this.api.storage.local.get('ticketCdpSession')).ticketCdpSession;
          if (stored?.runId === runId) await this.api.storage.local.set({ticketCdpSession:null});
        } finally { if (this.session === session) this.session = null; }
      })();
      return session.endPromise;
    }
  }
  root.TicketCDP = {Controller};
  if (typeof module !== 'undefined' && module.exports) module.exports = root.TicketCDP;
})(globalThis);

