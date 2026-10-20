/* Read-only preview of actual Popup markup with simulated extension APIs. */
(() => {
  const p=TicketConfig.defaultProfile();
  const data={ticketProfiles:[p,TicketConfig.nolProfile(),TicketConfig.practicketProfile()],activeProfileId:'nol-postseason',macroLogs:[]};
  Object.defineProperty(window,'chrome',{configurable:true,value:{
    runtime:{sendMessage:async request=>{
      if(request.action==='getSettings'||request.action==='getTabContext')return {success:true,...data,run:data.macroRun,currentTab:{id:1,url:TicketConfig.NOL_URL}};
      if(request.action==='analyzeCurrentPage')return {success:true,analysis:{url:'https://example.com/current',capturedAt:Date.now(),buttons:[
        {text:'예매하기',accessibleLabel:'',disabled:false,disabledReasons:[],inViewport:true,path:'#reserve',frameId:0,frameUrl:'https://example.com/current',shadow:''},
        {text:'10/20 10:00 예매하기',accessibleLabel:'',disabled:true,disabledReasons:['native disabled'],inViewport:true,path:'#later',frameId:0,frameUrl:'https://example.com/current',shadow:''}],
        frames:[{frameId:0,url:'https://example.com/current',status:'analyzed',coverage:{shadowRoots:1,closedShadowRoots:0,hiddenButtons:2}},
          {frameId:2,url:'https://other.example/frame',status:'inaccessible',reason:'다른 origin 접근 권한 없음 (미리보기 데이터)'}],
        partial:true,warnings:[],notes:['미리보기 결과이며 실제 Chrome 확장 API는 모의 구현입니다.']}};
      if(request.action==='getStatus')return {success:true,run:data.macroRun};
      if(request.action==='setClickMethod'){data.ticketClickMethod=request.value;return {success:true};}
      if(request.action==='saveProfiles'){data.ticketProfiles=request.profiles;data.activeProfileId=request.activeProfileId;return {success:true};}
      if(request.action==='clearLogs'){data.macroLogs=[];return {success:true};}
      if(request.action==='inspectFrames')return {success:true,frames:[{frameId:0,url:TicketConfig.NOL_URL}],report:{success:true,
        scopeCount:1,steps:[{name:request.profile.steps[0].name,selector:request.profile.steps[0].selector,count:1,clickable:false,verifyCount:null}]}};
      return {success:false,error:'이 화면은 Popup 미리보기입니다. 실제 실행은 Chrome 확장에서 진행하세요.'};
    }},
    storage:{local:{get:async()=>data},onChanged:{addListener:()=>{}}},
    permissions:{contains:async()=>false,request:async()=>true},tabs:{create:async()=>({})}
  }});
})();
