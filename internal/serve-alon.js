// Tiny zero-dependency static server for the Alon app, for LOCAL QA testing.
// Serves C:/harel/RLAPP ON RL/ALON on port 2500 (override with ALON_PORT / ALON_ROOT).
// Note: Cloudflare Pages `functions/` (server API) do NOT run here — this serves the static
// UI only. Client-side / localStorage flows work; server-backed features won't.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.env.ALON_ROOT || 'C:/harel/RLAPP ON RL/ALON');
const PORT = parseInt(process.env.ALON_PORT || '2500', 10);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  // API/function calls can't be served statically — say so clearly instead of returning HTML.
  if (p.startsWith('/api/') || p.startsWith('/functions/')) {
    res.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Cloudflare function not available in local static server' }));
  }
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) {
      if (!path.extname(p)) {
        return fs.readFile(path.join(ROOT, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('not found'); }
          else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d2); }
        });
      }
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('Alon static server: http://localhost:' + PORT + '  (root: ' + ROOT + ')');
});
