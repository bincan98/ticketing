'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createTemporaryProfile, removeTemporaryProfile, closeTemporaryContext} = require('./temporary-profile.cjs');

test('temporary profiles are removed only after browser close completes', async () => {
  const profile = createTemporaryProfile('input');
  fs.writeFileSync(path.join(profile, 'sample.txt'), 'fixture');
  let release;
  const closing = closeTemporaryContext({close: () => new Promise(resolve => { release = resolve; })}, profile);
  assert(fs.existsSync(profile), 'a closing browser must retain its profile');
  release();
  await closing;
  assert.equal(fs.existsSync(profile), false);
});

test('a failed browser close preserves the profile', async () => {
  const profile = createTemporaryProfile('nol-tabs');
  try {
    await assert.rejects(closeTemporaryContext({close: async () => { throw Error('still running'); }}, profile), /still running/);
    assert(fs.existsSync(profile));
    await closeTemporaryContext(undefined, profile);
    assert(fs.existsSync(profile), 'a failed launch is not permission to delete');
  } finally { removeTemporaryProfile(profile); }
});

test('saved login profiles, unknown profiles and paths outside the root cannot be removed', () => {
  for (const name of ['nol-login', '../outside', 'probe']) {
    assert.throws(() => createTemporaryProfile(name), /Unsupported/);
  }
  for (const location of [__dirname, path.resolve(__dirname, '..'), path.join(__dirname, '.chrome-profiles', 'nol-login-cMKgpq'),
    path.join(__dirname, '.chrome-profiles', 'input-unowned')]) {
    assert.throws(() => removeTemporaryProfile(location), /unowned/);
  }
});

test('directory junctions inside an owned profile are preserved without traversing them', () => {
  const profile = createTemporaryProfile('input');
  const target = createTemporaryProfile('input');
  const link = path.join(profile, 'linked-directory');
  fs.writeFileSync(path.join(target, 'keep.txt'), 'must survive');
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => removeTemporaryProfile(profile), /Linked/);
    assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'must survive');
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    removeTemporaryProfile(profile);
    removeTemporaryProfile(target);
  }
});
