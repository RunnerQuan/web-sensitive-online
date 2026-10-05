import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../assets/dragon-leaderboard.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const player = { id: 'p1', nickname: '奶龙玩家 1234', bestScore: null };
function setup(fetcher, storedPending = []) {
  const dom = new JSDOM('<div id="intro"></div><div id="result"></div>', { url: 'https://game.example', runScripts: 'outside-only' });
  dom.window.fetch = fetcher;
  dom.window.sessionStorage.setItem('dragon-pending-v1', JSON.stringify(storedPending));
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  dom.window.eval(source);
  const controller = dom.window.DragonLeaderboard.create({ startMount: dom.window.document.querySelector('#intro'), resultMount: dom.window.document.querySelector('#result') });
  return { dom, controller, document: dom.window.document, close() { controller.destroy(); dom.window.close(); } };
}
const response = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status }));
function standard(url) {
  if (url.endsWith('/session')) return response({ player });
  if (url.endsWith('/runs')) return response({ id: 'run-1', startedAt: new Date().toISOString() });
  if (url.endsWith('/finish')) return response({ score: 50, bestScore: 50, newRecord: true });
  return response({ entries: [], me: { ...player, rank: null }, updatedAt: new Date().toISOString() });
}

test('dialog renders shared top 20 as text, highlights self, and contains wheel events', async () => {
  const ui = setup(url => url.endsWith('/leaderboard') ? response({ entries: [{ id: 'p1', nickname: '<img src=x onerror=alert(1)>', score: 50, rank: 1 }], me: { ...player, bestScore: 50, rank: 1 }, updatedAt: new Date().toISOString() }) : standard(url));
  try {
    await ui.controller.open();
    assert.equal(ui.document.querySelector('dialog').open, true);
    assert.match(ui.document.querySelector('tbody').textContent, /<img/);
    assert.equal(ui.document.querySelector('tbody img'), null);
    assert.ok(ui.document.querySelector('tr.dragon-is-me'));
    let bubbled = false;
    ui.document.body.addEventListener('wheel', () => { bubbled = true; });
    ui.document.querySelector('tbody').dispatchEvent(new ui.dom.window.Event('wheel', { bubbles: true }));
    assert.equal(bubbled, false);
  } finally { ui.close(); }
});

test('finish waits for run creation; failed upload is retained and retry uses the same run', async () => {
  let finishAttempts = 0, resolveRun;
  const posted = [];
  const ui = setup((url, options) => {
    if (url.endsWith('/runs')) return new Promise(resolve => { resolveRun = resolve; });
    if (url.endsWith('/finish')) {
      finishAttempts++; posted.push([url, JSON.parse(options.body).score]);
      if (finishAttempts === 1) return response({ error: '网络暂时不可用' }, 503);
    }
    return standard(url);
  });
  try {
    ui.controller.begin();
    const finish = ui.controller.finish(50);
    await tick();
    assert.equal(finishAttempts, 0);
    resolveRun(new Response(JSON.stringify({ id: 'run-1', startedAt: new Date().toISOString() })));
    await finish;
    assert.match(ui.document.querySelector('[data-dragon-result-status]').textContent, /未上传|失败/);
    assert.ok(ui.dom.window.sessionStorage.getItem('dragon-pending-v1').includes('run-1'));
    await ui.controller.retry();
    assert.deepEqual(posted, [['/api/dragon/runs/run-1/finish', 50], ['/api/dragon/runs/run-1/finish', 50]]);
    assert.match(ui.document.querySelector('[data-dragon-result-status]').textContent, /已上传/);
    assert.equal(ui.dom.window.sessionStorage.getItem('dragon-pending-v1'), '[]');
  } finally { ui.close(); }
});

test('a run that could not register remains playable but is explicitly unranked', async () => {
  let submitted = false;
  const ui = setup(url => {
    if (url.endsWith('/runs')) return response({ error: '服务不可用' }, 503);
    if (url.endsWith('/finish')) submitted = true;
    return standard(url);
  });
  try {
    ui.controller.begin();
    await ui.controller.finish(50);
    assert.equal(submitted, false);
    assert.match(ui.document.querySelector('[data-dragon-result-status]').textContent, /未登记|未联网/);
  } finally { ui.close(); }
});

test('late upload responses cannot overwrite the next game status', async () => {
  let resolveFinish;
  const ui = setup(url => url.endsWith('/finish') ? new Promise(resolve => { resolveFinish = resolve; }) : standard(url));
  try {
    ui.controller.begin();
    const first = ui.controller.finish(50);
    await tick();
    ui.controller.reset();
    resolveFinish(new Response(JSON.stringify({ score: 50, bestScore: 50, newRecord: true })));
    await first;
    assert.equal(ui.document.querySelector('[data-dragon-result-status]').textContent, '本局结束后自动提交成绩');
  } finally { ui.close(); }
});

test('nickname form saves without using HTML and reset closes the dialog', async () => {
  let saved;
  const ui = setup((url, options) => {
    if (url.endsWith('/profile')) { saved = JSON.parse(options.body).nickname; return response({ player: { ...player, nickname: saved } }); }
    return standard(url);
  });
  try {
    await ui.controller.open();
    const input = ui.document.querySelector('[data-dragon-nickname]');
    input.value = '奶龙高手';
    ui.document.querySelector('[data-dragon-form]').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    assert.equal(saved, '奶龙高手');
    ui.controller.reset();
    assert.equal(ui.document.querySelector('dialog').open, false);
  } finally { ui.close(); }
});

test('background recovery of an old score cannot replace the current game result', async () => {
  let resolveOld;
  const ui = setup(url => {
    if (url.includes('/runs/old-run/finish')) return new Promise(resolve => { resolveOld = resolve; });
    return standard(url);
  }, [{ id: 'old-run', score: 10 }]);
  try {
    ui.controller.begin();
    await ui.controller.finish(50);
    const currentStatus = ui.document.querySelector('[data-dragon-result-status]').textContent;
    resolveOld(new Response(JSON.stringify({ score: 10, bestScore: 10, newRecord: false })));
    await tick();
    assert.equal(ui.document.querySelector('[data-dragon-result-status]').textContent, currentStatus);
  } finally { ui.close(); }
});
