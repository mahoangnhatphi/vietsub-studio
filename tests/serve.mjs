// Static test host at a project subpath, deliberately without COOP/COEP.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('web-dist');
const prefix = '/chinese-translate/';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.ttf': 'font/ttf' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end(); return; }
  const file = path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
}).listen(4178, '127.0.0.1');
