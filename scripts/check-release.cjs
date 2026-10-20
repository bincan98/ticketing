'use strict';
const fs=require('node:fs'),path=require('node:path');
function validateRelease(manifest,pkg,popup,tag) {
  const version=manifest.version;
  if(typeof version!=='string'||!/^\d+(?:\.\d+){0,3}$/.test(version)||version.split('.').some(part=>String(Number(part))!==part||Number(part)>65535)||version.split('.').every(part=>Number(part)===0))throw Error('Invalid Chrome extension version.');
  if(pkg.version!==version)throw Error('Manifest and package versions differ.');
  const display=popup.match(/<small>\s*v([\d.]+)\s*<\/small>/);
  if(display?.[1]!==version)throw Error('Popup display version differs from manifest.');
  if(tag!==undefined&&tag!=='v'+version)throw Error('Release tag must equal v'+version+'.');
  return {version,tag:'v'+version,zip:'ticket-click-extension-'+version+'.zip'};
}
function main(){
  const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--tag'))throw Error('Usage: node scripts/check-release.cjs [--tag vVERSION]');
  const root=path.resolve(__dirname,'..');
  const result=validateRelease(JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))),JSON.parse(fs.readFileSync(path.join(root,'package.json'))),fs.readFileSync(path.join(root,'popup.html'),'utf8'),args[1]);
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'version='+result.version+'\ntag='+result.tag+'\nzip='+result.zip+'\n');
  console.log(JSON.stringify(result,null,2));
}
if(require.main===module){try{main();}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={validateRelease};
