/* Shared by the standalone dragon game and the feed. No database credentials belong here. */
(() => {
  'use strict';
  const API = '/api/dragon/';
  const PENDING_KEY = 'dragon-pending-v1';

  function create({ startMount, resultMount }) {
    let player = null, sessionPromise = null, currentRun = null, epoch = 0;
    let destroyed = false, poll = null, refreshId = 0, lastBoard = null;
    const requests = new Set(), submissions = new Map();
    let pending = [];
    try {
      const stored = JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]');
      if (Array.isArray(stored)) pending = stored.filter(item => item && typeof item.id === 'string' && Number.isInteger(item.score)).slice(-10);
    } catch { /* Storage can be unavailable in private browsing. In-memory retry still works. */ }

    const intro = document.createElement('div');
    intro.className = 'dragon-entry';
    intro.innerHTML = `<span class="dragon-guest" data-dragon-guest>正在连接排行榜…</span>
      <button type="button" class="dragon-board-button" data-dragon-open>🏆 全球排行榜 <span>TOP 20</span></button>
      <button type="button" class="dragon-retry" data-dragon-pending hidden>补交上局成绩</button>`;
    startMount.append(intro);
    const result = document.createElement('div');
    result.className = 'dragon-entry dragon-result-entry';
    result.innerHTML = `<p class="dragon-result-status" data-dragon-result-status role="status">本局结束后自动提交成绩</p>
      <p class="dragon-best" data-dragon-best></p>
      <button type="button" class="dragon-retry" data-dragon-retry hidden>重试上传</button>
      <button type="button" class="dragon-board-button" data-dragon-open>🏆 查看全球排行榜 <span>TOP 20</span></button>`;
    resultMount.append(result);
    const dialog = document.createElement('dialog');
    dialog.className = 'dragon-leaderboard';
    dialog.setAttribute('aria-label', '合成大奶龙全球排行榜');
    dialog.innerHTML = `<div class="dragon-board-shell">
      <header class="dragon-board-header"><div><span class="dragon-eyebrow">合成大奶龙 · TOP 20</span><h2>全球排行榜</h2></div>
        <button type="button" class="dragon-close" data-dragon-close aria-label="关闭排行榜">×</button></header>
      <p class="dragon-rules">每人最高分上榜 · 同分先达者在前</p>
      <form class="dragon-profile" data-dragon-form>
        <label>我的游客昵称<input data-dragon-nickname maxlength="16" autocomplete="off" placeholder="正在获取昵称…" aria-label="我的游客昵称" disabled></label>
        <button type="submit" data-dragon-save disabled>保存</button>
      </form>
      <p class="dragon-form-status" data-dragon-form-status role="status">免登录；换设备或清除浏览器数据会更换身份。</p>
      <div class="dragon-my-record" data-dragon-me>玩一局，留下你的纪录</div>
      <div class="dragon-table-scroll" tabindex="0" aria-label="前二十名列表">
        <table class="dragon-table"><thead><tr><th scope="col">排名</th><th scope="col">玩家</th><th scope="col">最高分</th></tr></thead><tbody></tbody></table>
        <p class="dragon-empty" data-dragon-empty>正在加载榜单…</p>
      </div>
      <footer class="dragon-board-footer"><span data-dragon-board-status role="status">打开时更新，每 30 秒刷新</span><button type="button" data-dragon-refresh>刷新</button></footer>
    </div>`;
    document.body.append(dialog);
    const $ = selector => dialog.querySelector(selector);
    const status = result.querySelector('[data-dragon-result-status]');
    const retryButton = result.querySelector('[data-dragon-retry]');
    const pendingButton = intro.querySelector('[data-dragon-pending]');
    const nicknameInput = $('[data-dragon-nickname]');

    function persist() {
      pendingButton.hidden = pending.length === 0;
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending.slice(-10))); } catch { /* Best effort. */ }
    }
    persist();

    async function request(path, method = 'GET', body) {
      const abort = new AbortController();
      requests.add(abort);
      const timeout = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await fetch(API + path, {
          method, credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
          ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(data.error || '排行榜暂时无法连接，请稍后重试');
          error.status = response.status;
          throw error;
        }
        return data;
      } catch (error) {
        if (error.status) throw error;
        throw new Error('网络连接失败或超时，请稍后重试');
      } finally { clearTimeout(timeout); requests.delete(abort); }
    }
    function renderPlayer() {
      if (destroyed || !player) return;
      intro.querySelector('[data-dragon-guest]').textContent = `游客 · ${player.nickname}`;
      result.querySelector('[data-dragon-best]').textContent = player.bestScore === null ? '个人最高分：暂无纪录' : `个人最高分：${player.bestScore.toLocaleString()}`;
      nicknameInput.disabled = false;
      $('[data-dragon-save]').disabled = false;
      if (document.activeElement !== nicknameInput) nicknameInput.value = player.nickname;
    }
    function ensureSession() {
      if (!sessionPromise) {
        sessionPromise = request('session', 'POST', {}).then(data => {
          player = data.player; renderPlayer(); return player;
        }).catch(error => {
          sessionPromise = null;
          if (!destroyed) intro.querySelector('[data-dragon-guest]').textContent = '排行榜暂时未连接，仍可开始游戏';
          throw error;
        });
      }
      return sessionPromise;
    }
    function renderBoard(data) {
      const tbody = $('tbody');
      tbody.replaceChildren();
      for (const entry of data.entries) {
        const row = document.createElement('tr');
        if (entry.id === data.me?.id) row.className = 'dragon-is-me';
        const rank = document.createElement('td');
        rank.className = 'dragon-rank' + (entry.rank <= 3 ? ` dragon-rank-${entry.rank}` : '');
        rank.textContent = entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : String(entry.rank);
        rank.setAttribute('aria-label', `第 ${entry.rank} 名`);
        const name = document.createElement('td');
        name.textContent = entry.nickname + (entry.id === data.me?.id ? '（我）' : '');
        const score = document.createElement('td');
        score.textContent = entry.score.toLocaleString();
        row.append(rank, name, score); tbody.append(row);
      }
      $('[data-dragon-empty]').hidden = data.entries.length > 0;
      $('[data-dragon-empty]').textContent = '还没有成绩，来当第一位上榜玩家！';
      const me = data.me;
      $('[data-dragon-me]').textContent = me?.bestScore !== null && me?.bestScore !== undefined
        ? `我的最高分 ${me.bestScore.toLocaleString()} · ${me.rank <= 20 ? `全球第 ${me.rank} 名` : '暂未进入前 20'}`
        : '玩一局，留下你的纪录';
      if (me) { player = { ...player, ...me }; renderPlayer(); }
    }
    async function refresh() {
      const id = ++refreshId;
      $('[data-dragon-board-status]').textContent = '正在更新…';
      try {
        const data = await request('leaderboard');
        if (destroyed || id !== refreshId || !dialog.open) return;
        if (!Array.isArray(data.entries)) throw new Error('榜单返回异常，请稍后重试');
        lastBoard = data; renderBoard(data);
        $('[data-dragon-board-status]').textContent = `更新于 ${new Date(data.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
      } catch (error) {
        if (destroyed || id !== refreshId || !dialog.open) return;
        $('[data-dragon-board-status]').textContent = lastBoard ? '更新失败，当前显示上次榜单' : error.message;
        if (!lastBoard) { $('[data-dragon-empty]').hidden = false; $('[data-dragon-empty]').textContent = '暂时无法获取榜单，点击刷新重试'; }
      }
    }
    async function open() {
      if (destroyed) return;
      if (!dialog.open) dialog.showModal();
      clearInterval(poll);
      poll = setInterval(() => { if (dialog.open && !document.hidden) void refresh(); }, 30000);
      await ensureSession().catch(() => {});
      if (dialog.open && !destroyed) await refresh();
    }
    function close() {
      clearInterval(poll); poll = null; refreshId++;
      if (dialog.open) dialog.close();
    }
    dialog.addEventListener('close', () => { clearInterval(poll); poll = null; refreshId++; });
    $('[data-dragon-close]').addEventListener('click', close);
    $('[data-dragon-refresh]').addEventListener('click', () => void open());
    // The modal is outside the feed; also contain events for embedding pages with global gestures.
    for (const event of ['wheel', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointerup']) {
      dialog.addEventListener(event, e => e.stopPropagation(), { passive: true });
    }
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
    for (const button of [intro, result].flatMap(element => [...element.querySelectorAll('[data-dragon-open]')])) {
      button.addEventListener('click', () => void open());
    }
    $('[data-dragon-form]').addEventListener('submit', async e => {
      e.preventDefault();
      const save = $('[data-dragon-save]');
      save.disabled = true;
      try {
        await ensureSession();
        const data = await request('profile', 'PATCH', { nickname: nicknameInput.value });
        if (destroyed) return;
        player = data.player; renderPlayer();
        $('[data-dragon-form-status]').textContent = '昵称已保存';
        await refresh();
      } catch (error) { if (!destroyed) $('[data-dragon-form-status]').textContent = error.message; }
      finally { if (!destroyed) save.disabled = false; }
    });

    async function submit(item, generation) {
      if (!submissions.has(item.id)) {
        submissions.set(item.id, request(`runs/${encodeURIComponent(item.id)}/finish`, 'POST', { score: item.score }).finally(() => submissions.delete(item.id)));
      }
      try {
        const data = await submissions.get(item.id);
        pending = pending.filter(p => p.id !== item.id); persist();
        if (destroyed || epoch !== generation) return;
        status.textContent = data.newRecord ? '已上传 · 刷新个人纪录！' : '已上传 · 继续挑战最高分';
        retryButton.hidden = true;
        if (player) { player.bestScore = Math.max(player.bestScore || 0, data.bestScore); renderPlayer(); }
        // Obtain a fresh rank after committing, rather than persisting a rank that soon becomes stale.
        try {
          const board = await request('leaderboard');
          if (destroyed || epoch !== generation) return;
          if (board.me) {
            player = { ...player, ...board.me }; renderPlayer();
            result.querySelector('[data-dragon-best]').textContent += board.me.rank <= 20 ? ` · 全球第 ${board.me.rank} 名` : ' · 暂未进入前 20';
          }
          if (dialog.open) { lastBoard = board; renderBoard(board); }
        } catch { /* Score is already safely saved even if this subsequent read fails. */ }
      } catch (error) {
        const permanent = [400, 401, 404, 409, 410].includes(error.status);
        if (permanent) { pending = pending.filter(p => p.id !== item.id); persist(); }
        if (destroyed || epoch !== generation) return;
        status.textContent = `成绩未上传：${error.message}`;
        retryButton.hidden = permanent;
      }
    }
    function reset() {
      epoch++; currentRun = null; close();
      status.textContent = '本局结束后自动提交成绩';
      retryButton.hidden = true;
    }
    function begin() {
      reset();
      const requestId = crypto.randomUUID();
      currentRun = ensureSession().then(() => request('runs', 'POST', { requestId })).catch(() => null);
      return currentRun;
    }
    async function finish(score) {
      const generation = epoch, runPromise = currentRun;
      status.textContent = '正在上传成绩…';
      const run = await runPromise;
      if (destroyed) return;
      if (!run) {
        if (epoch === generation) status.textContent = '本局未联网登记，成绩仅供本次查看；联网后再开一局即可上榜';
        return;
      }
      const item = { id: run.id, score };
      if (!pending.some(p => p.id === item.id)) { pending.push(item); persist(); }
      await submit(item, generation);
    }
    async function retry({ background = false } = {}) {
      const generation = background ? -1 : epoch;
      if (!background) retryButton.hidden = true;
      pendingButton.disabled = true;
      if (!background) status.textContent = '正在重试上传…';
      try { for (const item of [...pending]) await submit(item, generation); }
      finally {
        pendingButton.disabled = false;
        if (!background && !destroyed && epoch === generation && pending.length) {
          retryButton.hidden = false;
          status.textContent = `仍有 ${pending.length} 局成绩未上传，请稍后重试`;
        }
      }
    }
    retryButton.addEventListener('click', () => void retry());
    pendingButton.addEventListener('click', () => void retry());
    ensureSession().then(() => { if (pending.length && !destroyed) return retry({ background: true }); }).catch(() => {});

    return { begin, finish, reset, open, close, retry, destroy() {
      destroyed = true; epoch++; close();
      for (const abort of requests) abort.abort();
      intro.remove(); result.remove(); dialog.remove();
    } };
  }
  window.DragonLeaderboard = { create };
})();
