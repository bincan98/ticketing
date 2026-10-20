'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '.chrome-profiles');
const prefixes = new Set(['input', 'nol-countdown', 'nol-tabs', 'nol-read', 'claude']);
const owned = new Set();

function checkRoot() {
  if (fs.realpathSync(__dirname) !== path.dirname(root)) throw Error('Linked test directory is not supported.');
  fs.mkdirSync(root, {recursive: true});
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== root) {
    throw Error('Temporary profile root must be a real directory.');
  }
}

function createTemporaryProfile(prefix) {
  if (!prefixes.has(prefix)) throw Error('Unsupported temporary profile prefix: ' + prefix);
  checkRoot();
  const profile = fs.mkdtempSync(path.join(root, prefix + '-'));
  owned.add(profile);
  return profile;
}

function removeTemporaryProfile(profile) {
  const resolved = path.resolve(profile);
  // Only this process's newly created, direct-child profiles may be removed.
  if (!owned.has(resolved) || path.dirname(resolved) !== root) {
    throw Error('Refusing to remove an unowned temporary profile.');
  }
  checkRoot();
  function checkTree(directory) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Linked profile entries are preserved.');
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) throw Error('Linked profile entries are preserved.');
      if (entry.isDirectory()) checkTree(path.join(directory, entry.name));
    }
  }
  checkTree(resolved);
  if (fs.realpathSync(resolved) !== resolved) throw Error('Profile path changed; preserving it.');
  fs.rmSync(resolved, {recursive: true, force: false, maxRetries: 6, retryDelay: 100});
  owned.delete(resolved);
}

async function closeTemporaryContext(context, profile) {
  // A failed launch or failed close may still have a browser using this path.
  if (!context) return;
  await context.close();
  try { removeTemporaryProfile(profile); }
  catch (error) { console.warn('Temporary profile preserved: ' + error.message); }
}

module.exports = {createTemporaryProfile, removeTemporaryProfile, closeTemporaryContext};
