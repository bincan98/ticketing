'use strict';
(() => {
  const params=new URLSearchParams(location.search),layout=params.get('layout')||'plain',trial=params.get('trial')||'manual';
  if(['iframe','cross-frame','cross-shadow','cross-closed','nested-frame','claude-frame'].includes(layout)){
    const frame=document.createElement('iframe');frame.id='labFrame';
    const next=new URL(location.href);
    if(layout!=='iframe')next.hostname=next.hostname==='127.0.0.1'?'localhost':'127.0.0.1';
    const childLayout=layout==='nested-frame'?'cross-frame':layout==='cross-shadow'?'shadow':layout==='cross-closed'?'closed':layout==='claude-frame'?'claude-button':'plain';
    frame.src=next.origin+'/tests/input-lab.html?layout='+childLayout+'&trial='+encodeURIComponent(trial);
    document.getElementById('mount').append(frame);return;
  }
  const host=document.getElementById('mount');
  let root=host;
  if(layout==='shadow'||layout==='closed'){host.id='shadow-host';root=host.attachShadow({mode:layout==='closed'?'closed':'open'});}
  root.innerHTML='<style>button{padding:12px;margin:5px}</style><div id="scope"><button id="target" disabled>로컬 예매 버튼</button><p id="done" hidden>클릭 이후 화면 변경</p></div>';
  const target=root.querySelector('#target'),done=root.querySelector('#done');
  if(layout==='claude-button'){root.querySelector('#scope').className='screen';target.id='bookBtn';done.id='result';done.hidden=false;done.textContent='반응 대기';}
  if(layout==='scrolled'){host.style.marginTop='1200px';}
  const data={trial,layout,events:[],inputs:[],moves:[],clicks:0,activatedAt:null,changed:false};
  document.addEventListener('pointermove',event=>{if(event.pointerType==='mouse')data.moves.push({x:event.clientX,y:event.clientY,isTrusted:event.isTrusted});},{capture:true});
  for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])document.addEventListener(type,event=>{
    data.inputs.push({type:event.type,isTrusted:event.isTrusted,target:event.target.id,clientX:event.clientX,clientY:event.clientY});
  },{capture:true});
  function render(){document.getElementById('events').textContent=JSON.stringify(data,null,2);document.getElementById('state').textContent=data.changed?'화면 변경 확인 · 클릭 '+data.clicks+'회':target.disabled?'비활성 버튼 대기':'활성 버튼 대기';}
  for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])target.addEventListener(type,event=>{
    data.events.push({type:event.type,isTrusted:event.isTrusted,button:event.button,buttons:event.buttons,
      clientX:event.clientX,clientY:event.clientY,screenX:event.screenX,screenY:event.screenY,detail:event.detail,
      pointerType:event.pointerType||null,time:performance.now()});
    if(type==='mousedown'&&layout==='move-on-press')target.style.transform='translateX(120px)';
    if(type==='pointerdown'&&layout==='claude-button'){
      done.textContent='예매 반응 확인';data.changed=true;data.activationToPointerdownMs=performance.now()-data.activatedAt;
    }
    if(type==='click'){
      data.clicks++;data.changed=true;data.activationToClickMs=performance.now()-data.activatedAt;done.textContent='클릭 이후 화면 변경 '+data.clicks;done.hidden=false;
      fetch('/tests/lab-click?trial='+encodeURIComponent(trial)).catch(()=>{});
      fetch('/tests/lab-telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).catch(()=>{});
    }
    render();
  });
  window.inputLab={
    data,target,root,
    activate(){data.activatedAt=performance.now();target.disabled=false;target.classList.add('on');render();},
    reset(){data.events=[];data.clicks=0;data.changed=false;data.activatedAt=null;done.hidden=true;target.disabled=true;target.style.transform='';render();}
  };
  document.getElementById('activate').onclick=()=>window.inputLab.activate();
  document.getElementById('direct').onclick=()=>{if(target.disabled)window.inputLab.activate();target.click();};
  document.getElementById('reset').onclick=()=>window.inputLab.reset();
  render();
})();

