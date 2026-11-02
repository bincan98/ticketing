/* Site rules shared by the repeat worker and its isolated-world observers. */
(()=>{'use strict';
 const CLAUDE_URL='https://claude.ai/artifact/TZ6E7URiDk5584MDPEEC2G';
 const FRAME='https://d708a060-a8d9-48df-b1d5-a84f53c6a06d.frame.claudeusercontent.com';
 const claude={id:'claude',name:'Claude 예매 반응 (연습)',frameOrigin:FRAME,selector:'#bookBtn',resultSelector:'#result',event:'pointerdown',maxRunMs:20000,verifyMs:1500};
 const nol={id:'nol',name:'NOL 티켓',frameOrigin:null,selector:'button._primary_2p3w6_7:has(> span._content_2p3w6_38)',resultSelector:null,event:'click',maxRunMs:120000,verifyMs:3000};
 function isNolUrl(value){try{const u=new URL(value);return !u.username&&!u.password&&u.origin==='https://tickets.interpark.com'&&/^\/gates\/ticket\/(?:\d+|P\d+)\/?$/.test(u.pathname);}catch{return false;}}
 const forUrl=value=>value===CLAUDE_URL?{...claude}:isNolUrl(value)?{...nol}:null;
 function forDocument(value){try{if(new URL(value).origin===FRAME)return {...claude};}catch{}return isNolUrl(value)?{...nol}:null;}
 const api={CLAUDE_URL,FRAME,isNolUrl,forUrl,forDocument};globalThis.TicketRepeatSites=api;
 if(typeof module!=='undefined'&&module.exports)module.exports=api;
})();
