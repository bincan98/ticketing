'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'ticket-click-extension');
// Explicit runtime allowlist: never copy tests, profiles, logs, or backups.
const files = ['manifest.json', 'background.js', 'shared.js', 'capture.js',
  'analyze.js', 'cdp.js', 'content.js', 'popup.html', 'popup.js', 'popup.css'];
const hash = data => createHash('sha256').update(data).digest('hex');

function build() {
  const sources = new Map(files.map(file => [file, fs.readFileSync(path.join(root, file))]));
  const manifest = JSON.parse(sources.get('manifest.json').toString('utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw Error('Manifest and package versions differ.');
  for (const file of [manifest.background?.service_worker, manifest.action?.default_popup]) {
    if (!sources.has(file)) throw Error('Missing runtime entry point: ' + file);
  }
  for (const directory of [path.dirname(output), output]) {
    if (!fs.existsSync(directory)) continue;
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Output must be a real directory: ' + directory);
  }
  if (fs.existsSync(output)) {
    for (const entry of fs.readdirSync(output, {withFileTypes: true})) {
      if (!files.includes(entry.name) || !entry.isFile()) {
        throw Error('Unmanaged output entry; preserve it and review manually: ' + entry.name);
      }
    }
  }
  fs.mkdirSync(output, {recursive: true});
  let bytes = 0;
  for (const [file, data] of sources) {
    const target = path.join(output, file);
    fs.writeFileSync(target, data);
    if (hash(fs.readFileSync(target)) !== hash(data)) throw Error('Copy verification failed: ' + file);
    bytes += data.length;
  }
  console.log(JSON.stringify({version: manifest.version, output, files: files.length, bytes,
    verified: 'SHA-256 matches development source'}, null, 2));
}

try { build(); }
catch (error) { console.error('Build failed: ' + error.message); process.exitCode = 1; }
