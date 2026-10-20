'use strict';
window.fixture = {listeners:[],storageListeners:[],data:{},clicks:0};
const F=window.fixture;
const clone=value=>JSON.parse(JSON.stringify(value));
window.chrome = {
  runtime:{id:'test-extension',onMessage:{addListener:fn=>F.listeners.push(fn)}},
  storage:{local:{get:async keys=>{
    const list=Array.isArray(keys)?keys:[keys];return Object.fromEntries(list.filter(k=>F.data[k]!==undefined).map(k=>[k,clone(F.data[k])]));
  },set:async patch=>{
    const changes={};for(const [key,value] of Object.entries(patch)){changes[key]={oldValue:F.data[key],newValue:clone(value)};F.data[key]=clone(value);}
    for(const fn of F.storageListeners)fn(changes,'local');
  }},onChanged:{addListener:fn=>F.storageListeners.push(fn)}}
};
F.send=request=>{
  let result;for(const fn of F.listeners)fn(request,{id:chrome.runtime.id},response=>result=response);return result;
};
F.sendAsync=request=>new Promise(resolve=>{for(const fn of F.listeners)fn(request,{id:chrome.runtime.id},resolve);});
F.sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
F.until=async(predicate,ms=1600)=>{const end=Date.now()+ms;while(Date.now()<end){if(predicate())return;await F.sleep(5);}throw Error('condition timeout: '+JSON.stringify(F.data.macroRun));};
