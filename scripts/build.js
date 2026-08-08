// Assembles dist/ — the only files Cloudflare publishes. Everything else in the
// repo (the local Node server, node_modules, docs) stays out of the upload.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const FILES = ['index.html', 'assets/index.html'];

fs.rmSync(dist, { recursive: true, force: true });
for (const rel of FILES) {
  const dest = path.join(dist, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, rel), dest);
}
console.log('built dist/ with ' + FILES.length + ' files');
