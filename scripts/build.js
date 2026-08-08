// Assembles dist/ — the only files Cloudflare publishes. Everything else in the
// repo (the local Node server, node_modules, docs) stays out of the upload.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
// The app is served at "/" directly — the root redirect stub the repo carries for
// GitHub Pages is not copied, so there is no extra page load on the way in.
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.copyFileSync(path.join(root, 'assets/index.html'), path.join(dist, 'index.html'));
console.log('built dist/index.html');
