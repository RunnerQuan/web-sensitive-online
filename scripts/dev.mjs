import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createLeaderboard } from '../server/leaderboard.mjs';
import { createHandler } from '../server/api.mjs';
import './build.mjs';

// Local, disposable PostgreSQL only. This server never connects to the Netlify database.
const db = new PGlite();
await db.exec(await readFile(new URL('../netlify/database/migrations/202610040001_dragon_leaderboard.sql', import.meta.url), 'utf8'));
const handler = createHandler(createLeaderboard(db));
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 8888);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname.startsWith('/api/dragon/')) {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const result = await handler(request, { ip: req.socket.remoteAddress });
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    const target = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!target.startsWith(resolve(root) + sep) || !(await stat(target)).isFile()) { res.writeHead(404); res.end(); return; }
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Local preview: http://localhost:${port} (temporary database; resets when stopped)`));
process.on('SIGINT', () => { server.close(async () => { await db.close(); process.exit(0); }); });
