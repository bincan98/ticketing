'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {zipSync,unzipSync}=require('fflate');
const {validateRelease}=require('./check-release.cjs');
const files=['manifest.json','background.js','shared.js','capture.js','analyze.js','cdp.js','content.js','popup.html','popup.js','popup.css'];
const hash=data=>createHash('sha256').update(data).digest('hex');
function verifyArchive(data,sources){
  const seen=new Set(),limit=Object.values(sources).reduce((sum,value)=>sum+value.length,0)*2+16384;
  if(data.length>limit)throw Error('Unexpected ZIP size.');
  const contents=unzipSync(data,{filter:entry=>{
    if(!Object.hasOwn(sources,entry.name)||seen.has(entry.name)||entry.originalSize!==sources[entry.name].length)throw Error('Unexpected ZIP entry: '+entry.name);
    seen.add(entry.name);return true;
  }});
  if(seen.size!==Object.keys(sources).length)throw Error('Unexpected ZIP file count.');
  for(const [name,source] of Object.entries(sources))if(!Buffer.from(contents[name]).equals(source))throw Error('Existing ZIP differs from source: '+name+'. Increase the version before releasing different code.');
}
function regularFile(target){let stat;try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return;throw error;}if(stat.isSymbolicLink()||!stat.isFile())throw Error('Output must be a regular local file: '+target);}
function main(){
  const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--tag'))throw Error('Usage: node scripts/package-extension.cjs [--tag vVERSION]');
  const root=path.resolve(__dirname,'..'),release=validateRelease(JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))),JSON.parse(fs.readFileSync(path.join(root,'package.json'))),fs.readFileSync(path.join(root,'popup.html'),'utf8'),args[1]);
  execFileSync(process.execPath,[path.join(__dirname,'build-extension.cjs')],{cwd:root,stdio:'inherit'});
  const sources=Object.fromEntries(files.map(name=>[name,fs.readFileSync(path.join(root,name))]));
  const directory=path.join(root,'dist'),target=path.join(directory,release.zip),latest=path.join(directory,'ticket-click-extension.zip'),checksums=path.join(directory,'SHA256SUMS.txt'),report=path.join(directory,'package-report.json');
  for(const file of [target,latest,checksums,report])regularFile(file);
  let archive;
  if(fs.existsSync(target)){archive=fs.readFileSync(target);verifyArchive(archive,sources);}
  else{
    archive=Buffer.from(zipSync(sources,{level:9,mtime:new Date(1980,0,1)}));verifyArchive(archive,sources);
    fs.writeFileSync(target,archive,{flag:'wx'});
  }
  fs.writeFileSync(latest,archive);
  fs.writeFileSync(checksums,hash(archive)+'  '+release.zip+'\n'+hash(archive)+'  ticket-click-extension.zip\n');
  const result={version:release.version,zip:target,latest,files:files.length,zipBytes:archive.length,sha256:hash(archive)};
  fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}
if(require.main===module){try{main();}catch(error){console.error('Packaging failed: '+error.message);process.exitCode=1;}}
module.exports={verifyArchive};
