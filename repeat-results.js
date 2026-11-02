/* Final result formatting only. Never runs in the repeat input loop. */
(()=>{'use strict';
 const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
 const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
 const number=value=>value.toLocaleString('ko-KR',{maximumFractionDigits:6});
 function summarize(state){
   const complete=state.countsComplete===true&&!!state.result,data=complete?state.result:state.inputEvidence||null;
   const timing=data?.timing||{},at=timing.firstValidInputAt,event=data?.completionEvent||state.site?.event||(state.siteId==='claude'?'pointerdown':'click');
   const label=event==='pointerdown'?'유효 눌림(pointerdown)':'유효 클릭(click)';
   const inputs=count(data?.validInputs),clicks=count(data?.validClicks),extras=count(data?.extraValidInputs);
   function delay(kind){
     const observed=kind==='appearance'?timing.appearanceAt:timing.activationAt;
     let status,ms=null,text;
     if(!finite(at)){status=complete&&inputs===0?'no-input':'unavailable';text=status==='no-input'?'유효 입력 없음':'확인 불가 · 입력 시각 기록 없음';}
     else if(finite(observed)&&observed<=at){status='measured';ms=at-observed;text=number(ms/1000)+'초 ('+number(ms)+'ms)';}
     else if(finite(observed)){status='unavailable';text='확인 불가 · 입력보다 늦게 감지됨';}
     else if(kind==='appearance'&&timing.initiallyVisible===true){status='already-visible';text='측정 시작 시 이미 표시됨';}
     else if(kind==='activation'&&timing.initiallyEnabled===true){status='already-active';text='측정 시작 시 이미 활성화됨';}
     else{status='unavailable';text='확인 불가 · '+(kind==='appearance'?'등장':'활성화')+' 시각 미관측';}
     return {status,ms,seconds:ms==null?null:ms/1000,text};
   }
   const appearance=delay('appearance'),activation=delay('activation');
   const duplicateStatus=extras!=null&&extras>0?'observed':complete&&extras===0?'none-observed':'unconfirmed';
   const duplicateText=duplicateStatus==='observed'?'있음 · 추가 '+number(extras)+'회'+(complete?'':' 이상 (부분 기록)'):duplicateStatus==='none-observed'?'관측되지 않음 · 추가 0회':'확인 불가 · 최종 기록 불완전';
   const inputsText=inputs==null?'확인 불가':(complete?'':'최소 ')+number(inputs)+'회'+(complete?'':' (부분 기록)');
   const presses=count(complete?state.result.presses:state.observedPresses);
   const lines=[
     '버튼 등장 감지 → 첫 유효 입력: '+appearance.text,
     '버튼 활성화 감지 → 첫 유효 입력: '+activation.text,
     label+': '+inputsText,
     '중복 유효 입력: '+duplicateText,
     '전체 눌림: '+(presses==null?'확인 불가':(complete?'':'관측된 ')+number(presses)+'회')+' · 비활성 상태 포함',
     '기록 상태: '+(complete?'최종 기록 수집 완료':'부분 기록 · 페이지 이동/연결 종료 등으로 최종 확인 불가')
   ];
   if(event!=='click')lines.splice(4,0,'실제 click 이벤트: '+(clicks==null?'확인 불가':(complete?'':'최소 ')+number(clicks)+'회'));
   return {schemaVersion:1,complete,completionEvent:event,appearance,activation,validInputCount:inputs,validClickCount:clicks,duplicateStatus,additionalValidInputs:extras,lines,
     note:'페이지 DOM 감지·이벤트 관측 기준입니다. 실제 화면 표시 순간이나 서버 접수·예매 성공을 의미하지 않습니다.'};
 }
 globalThis.TicketRepeatResults={summarize};if(typeof module!=='undefined')module.exports=TicketRepeatResults;
})();
