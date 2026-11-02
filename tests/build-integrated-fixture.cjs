'use strict';
const fs=require('fs'),path=require('path'),files=require('../scripts/runtime-files.cjs'),folder=path.join(__dirname,'.integrated-extension-under-test');
fs.mkdirSync(folder,{recursive:true});for(const file of files)fs.copyFileSync(path.join(__dirname,'..',file),path.join(folder,file));
// Test-only required origins stand in for the native Chrome permission dialog.
const m=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json')));m.host_permissions=['https://claude.ai/*','https://d708a060-a8d9-48df-b1d5-a84f53c6a06d.frame.claudeusercontent.com/*','https://tickets.interpark.com/*'];fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(m,null,2));
// Optional compatibility panel for the locally preserved pre-integration suites.
for(const file of ['repeat-panel.html','repeat-panel.js']){const from=path.join(__dirname,'repeat-manual-src',file);if(fs.existsSync(from))fs.copyFileSync(from,path.join(folder,file));}
console.log(folder);
