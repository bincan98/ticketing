'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateRelease}=require('../scripts/check-release.cjs');
const check=(version='2.2.20',pkg=version,display=version,tag='v'+version)=>validateRelease({version},{version:pkg},'<small>v'+display+'</small>',tag);
test('release metadata binds the tag, package and visible version',()=>{
  assert.deepEqual(check(),{version:'2.2.20',tag:'v2.2.20',zip:'ticket-click-extension-2.2.20.zip'});
});
test('a wrong tag, package or visible version cannot publish',()=>{
  assert.throws(()=>check('2.2.20','2.2.19'),/package versions/);
  assert.throws(()=>check('2.2.20','2.2.20','2.2.19'),/Popup/);
  assert.throws(()=>check('2.2.20','2.2.20','2.2.20','v2.2.21'),/tag/);
});
test('invalid versions cannot become release paths or workflow outputs',()=>{
  for(const version of ['../outside','2.2.20\nversion=9','02.2.20','2.2.65536','0.0.0','2.2.20.1.1'])assert.throws(()=>check(version),/Invalid/);
});
const {verifyArchive}=require('../scripts/package-extension.cjs'),{zipSync}=require('fflate');
test('ZIP verification rejects extra paths and missing runtime files',()=>{
  const sources={'manifest.json':Buffer.from('safe')};
  assert.throws(()=>verifyArchive(zipSync({...sources,'../secret':Buffer.from('bad')}),sources),/Unexpected ZIP entry/);
  assert.throws(()=>verifyArchive(zipSync({}),sources),/file count/);
});
test('ZIP verification rejects different source bytes before overwriting a release',()=>{
  assert.throws(()=>verifyArchive(zipSync({'manifest.json':Buffer.from('evil')}),{'manifest.json':Buffer.from('safe')}),/differs from source/);
});
