// Assembles dist/ — the only files Cloudflare publishes. Everything else in the
// repo (the local Node server, node_modules, docs) stays out of the upload.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
// The app now lives at the repo root (index.html + server.js), so there is no
// separate redirect stub to skip anymore — just copy the app shell straight in.
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(dist, 'index.html'));
console.log('built dist/index.html');
