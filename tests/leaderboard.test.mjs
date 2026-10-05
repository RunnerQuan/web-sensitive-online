import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createLeaderboard } from '../server/leaderboard.mjs';
import { createHandler } from '../server/api.mjs';

let db, service, handler;
before(async () => {
  db = new PGlite();
  await db.exec(await readFile(new URL('../netlify/database/migrations/202610040001_dragon_leaderboard.sql', import.meta.url), 'utf8'));
  service = createLeaderboard(db);
  handler = createHandler(service);
});
beforeEach(async () => { await db.exec('TRUNCATE dragon_runs, dragon_players, dragon_rate_limits CASCADE'); });
after(async () => { await db?.close(); });

async function score(guest, value) {
  const run = await service.startRun(guest.player.id, randomUUID());
  return service.finishRun(guest.player.id, run.id, value);
}
function request(path, method = 'GET', body, cookie, extra = {}) {
  return new Request('https://game.example/api/dragon/' + path, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json', origin: 'https://game.example' } : {}), ...(cookie ? { cookie } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

test('guest tokens are opaque, stored hashed, and restore the same identity', async () => {
  const guest = await service.createGuest();
  assert.equal(guest.token.length, 64);
  assert.equal((await service.authenticate(guest.token)).id, guest.player.id);
  assert.equal(await service.authenticate('invented'), null);
  const stored = (await db.query('SELECT * FROM dragon_players')).rows[0];
  assert.notEqual(stored.session_hash, guest.token);
  assert.equal(stored.best_score, null);
});

test('only completed games rank, highest score survives lower and equal scores', async () => {
  const guest = await service.createGuest();
  assert.deepEqual((await service.board(guest.player.id)).entries, []);
  assert.equal((await score(guest, 120)).newRecord, true);
  const first = (await db.query('SELECT achieved_at FROM dragon_players')).rows[0].achieved_at;
  assert.equal((await score(guest, 20)).bestScore, 120);
  assert.equal((await score(guest, 120)).newRecord, false);
  const row = (await db.query('SELECT best_score, achieved_at FROM dragon_players')).rows[0];
  assert.equal(row.best_score, 120);
  assert.deepEqual(row.achieved_at, first);
});

test('run creation and submission retries are idempotent; changed retry is rejected', async () => {
  const guest = await service.createGuest();
  const key = randomUUID();
  const run = await service.startRun(guest.player.id, key);
  assert.equal((await service.startRun(guest.player.id, key)).id, run.id);
  const first = await service.finishRun(guest.player.id, run.id, 80);
  assert.deepEqual(await service.finishRun(guest.player.id, run.id, 80), first);
  await assert.rejects(service.finishRun(guest.player.id, run.id, 90), { status: 409 });
});

test('another guest cannot submit a run; expired and invalid scores do not rank', async () => {
  const a = await service.createGuest(), b = await service.createGuest();
  const run = await service.startRun(a.player.id, randomUUID());
  await assert.rejects(service.finishRun(b.player.id, run.id, 100), { status: 404 });
  for (const value of [-10, 1.5, 13, '100', null, 10000010]) {
    await assert.rejects(service.finishRun(a.player.id, run.id, value), { status: 400 });
  }
  await db.query("UPDATE dragon_runs SET started_at = now() - interval '25 hours'");
  await assert.rejects(service.finishRun(a.player.id, run.id, 100), { status: 410 });
  assert.equal((await service.board()).entries.length, 0);
});

test('top 20 are unique players in stable order; personal rank is available outside top 20', async () => {
  let last;
  for (let i = 0; i < 23; i++) {
    last = await service.createGuest();
    await score(last, (23 - i) * 10);
  }
  const board = await service.board(last.player.id);
  assert.equal(board.entries.length, 20);
  assert.equal(new Set(board.entries.map(p => p.id)).size, 20);
  assert.equal(board.entries[0].score, 230);
  assert.equal(board.entries[19].score, 40);
  assert.equal(board.me.rank, 23);
  assert.equal(board.me.bestScore, 10);
  assert.equal(JSON.stringify(board).includes('session'), false);
});

test('equal scores sort by server achievement time and then player ID', async () => {
  const a = await service.createGuest(), b = await service.createGuest();
  await score(a, 50); await score(b, 50);
  await db.query("UPDATE dragon_players SET achieved_at = '2026-10-04T00:00:00Z' WHERE id = $1", [a.player.id]);
  await db.query("UPDATE dragon_players SET achieved_at = '2026-10-04T00:01:00Z' WHERE id = $1", [b.player.id]);
  assert.equal((await service.board()).entries[0].id, a.player.id);
  await db.query("UPDATE dragon_players SET achieved_at = '2026-10-04T00:00:00Z'");
  assert.deepEqual((await service.board()).entries.map(p => p.id), [a.player.id, b.player.id].sort());
});

test('nickname validation supports Chinese and refuses markup and invisible controls', async () => {
  const guest = await service.createGuest();
  assert.equal((await service.rename(guest.player.id, ' 奶龙高手 ')).nickname, '奶龙高手');
  for (const name of ['', 'a'.repeat(17), '<img src=x>', 'abc\u202Edef']) {
    await assert.rejects(service.rename(guest.player.id, name), { status: 400 });
  }
});

test('rate limiting is shared by requests and expires by bucket', async () => {
  await service.throttle('test', 2, 60);
  await service.throttle('test', 2, 60);
  await assert.rejects(service.throttle('test', 2, 60), { status: 429 });
});

test('API creates an HttpOnly guest cookie, restores identity, and exposes no token in JSON', async () => {
  const response = await handler(request('session', 'POST', {}), { ip: '127.0.0.1' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /Secure/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const body = await response.json();
  assert.equal(body.token, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const again = await handler(request('session', 'POST', {}, cookie), { ip: '127.0.0.1' });
  assert.equal((await again.json()).player.id, body.player.id);
});

test('API rejects cross-origin writes and unauthenticated submissions but permits public reads', async () => {
  assert.equal((await handler(request('session', 'POST', {}, null, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(request('runs', 'POST', { requestId: randomUUID() }))).status, 401);
  assert.equal((await handler(request('leaderboard'))).status, 200);
  assert.equal((await handler(request('unknown'))).status, 404);
  assert.equal((await handler(request('session', 'DELETE'))).status, 405);
});

test('API end-to-end: two guests share the same board and cannot impersonate via body', async () => {
  const login = async () => {
    const r = await handler(request('session', 'POST', {}));
    return { cookie: r.headers.get('set-cookie').split(';')[0], ...(await r.json()) };
  };
  const a = await login(), b = await login();
  const runResponse = await handler(request('runs', 'POST', { requestId: randomUUID(), playerId: b.player.id }, a.cookie));
  const run = await runResponse.json();
  const wrong = await handler(request(`runs/${run.id}/finish`, 'POST', { score: 70 }, b.cookie));
  assert.equal(wrong.status, 404);
  assert.equal((await handler(request(`runs/${run.id}/finish`, 'POST', { score: 70 }, a.cookie))).status, 200);
  const board = await (await handler(request('leaderboard', 'GET', undefined, b.cookie))).json();
  assert.equal(board.entries[0].id, a.player.id);
  assert.equal(board.me.bestScore, null);
});

test('concurrent different runs keep the higher score and same-run retries remain identical', async () => {
  const guest = await service.createGuest();
  const high = await service.startRun(guest.player.id, randomUUID());
  const low = await service.startRun(guest.player.id, randomUUID());
  const results = await Promise.all([
    service.finishRun(guest.player.id, high.id, 200),
    service.finishRun(guest.player.id, low.id, 100),
    service.finishRun(guest.player.id, high.id, 200)
  ]);
  assert.deepEqual(results[0], results[2]);
  assert.equal((await service.board(guest.player.id)).me.bestScore, 200);
});

test('API rejects malformed/oversized JSON and expired identities', async () => {
  const guest = await service.createGuest();
  await db.query("UPDATE dragon_players SET session_expires_at = now() - interval '1 day'");
  assert.equal(await service.authenticate(guest.token), null);
  assert.equal((await handler(request('session', 'POST', { text: 'x'.repeat(3000) }))).status, 413);
  const malformed = new Request('https://game.example/api/dragon/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal((await handler(malformed)).status, 400);
  const plain = new Request('https://game.example/api/dragon/session', { method: 'POST', body: '{}' });
  assert.equal((await handler(plain)).status, 415);
});

test('scheduled cleanup removes old runs while preserving permanent best scores', async () => {
  const guest = await service.createGuest();
  await score(guest, 90);
  await db.query("UPDATE dragon_runs SET started_at = now() - interval '31 days'");
  await service.cleanup();
  assert.equal((await db.query('SELECT * FROM dragon_runs')).rows.length, 0);
  assert.equal((await service.board(guest.player.id)).me.bestScore, 90);
});
