/**
 * 本地预览用的极简静态服务器（零依赖）。
 *
 *   node tools/preview.mjs         → http://127.0.0.1:8080
 *   node tools/preview.mjs 4000    → 换端口
 *
 * 它只负责把 site/ 里的文件发出去，不参与线上部署。
 * 线上是 Caddy 直接托管 site/。
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', 'site');
const PORT = Number(process.argv[2] || 8080);
const API_PORT = Number(process.env.API_PORT || 3001);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, file) {
  res.writeHead(status, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  // /api/* 转给本地线索服务，这样在 8080 上也能真的提交表单
  if (pathname.startsWith('/api/')) {
    const upstream = httpRequest(
      { host: '127.0.0.1', port: API_PORT, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('线索服务没启动：另开一个终端跑 node server/server.mjs\n');
    });
    req.pipe(upstream);
    return;
  }

  // 防止路径穿越
  const target = normalize(join(ROOT, pathname));
  if (!target.startsWith(ROOT)) return send(res, 403, join(ROOT, '404.html'));

  let file = target;
  if (pathname.endsWith('/')) file = join(target, 'index.html');
  else if (existsSync(target) && statSync(target).isDirectory()) file = join(target, 'index.html');
  else if (!extname(target)) file = `${target}.html`;

  if (!existsSync(file)) return send(res, 404, join(ROOT, '404.html'));
  return send(res, 200, file);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${PORT}  (root: ${ROOT})`);
});
