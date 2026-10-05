import { ApiError } from './leaderboard.mjs';

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
async function readBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, '请使用 JSON 请求');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, '请求内容不能为空');
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2048) { await reader.cancel(); throw new ApiError(413, '请求内容过长'); }
    chunks.push(value);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, '请求内容不正确'); }
}

export function createHandler(service) {
  return async (request, context = {}) => {
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/dragon\/?/, '');
      const finish = /^runs\/([a-f0-9-]+)\/finish$/i.exec(path);
      const method = { session: 'POST', profile: 'PATCH', runs: 'POST', leaderboard: 'GET' }[path] || (finish ? 'POST' : null);
      if (!method) throw new ApiError(404, '接口不存在');
      if (request.method !== method) return json({ error: '请求方式不正确' }, 405, { allow: method });
      let body;
      if (method !== 'GET') {
        const origin = request.headers.get('origin');
        if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, '不允许跨站提交');
        body = await readBody(request);
      }
      // Trust only Netlify's context.ip, never a browser-supplied forwarding header.
      if (context.ip) await service.throttle(`ip:${context.ip}`, 180, 60);
      const secure = url.protocol === 'https:';
      const cookieName = secure ? '__Host-dragon_guest' : 'dragon_guest';
      const token = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const player = await service.authenticate(token);
      if (path === 'leaderboard') return json(await service.board(player?.id));
      if (path === 'session') {
        if (player) return json({ player });
        if (context.ip) await service.throttle(`guest:${context.ip}`, 20, 3600);
        const guest = await service.createGuest();
        return json({ player: guest.player }, 200, { 'set-cookie': `${cookieName}=${guest.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}` });
      }
      if (!player) throw new ApiError(401, '游客身份已失效，请刷新页面后重新开始');
      await service.throttle(`player:${player.id}`, 120, 60);
      if (path === 'profile') return json({ player: await service.rename(player.id, body.nickname) });
      if (path === 'runs') {
        await service.throttle(`runs:${player.id}`, 120, 3600);
        return json(await service.startRun(player.id, body.requestId));
      }
      return json(await service.finishRun(player.id, finish[1], body.score));
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status, error.status === 429 ? { 'retry-after': '60' } : {});
      // Never include SQL, connection strings or session material in client responses/logs.
      console.error('Dragon leaderboard unavailable', { code: /^[A-Z0-9_]{1,20}$/.test(error.code || '') ? error.code : 'INTERNAL' });
      return json({ error: '排行榜暂时不可用，请稍后重试；仍可继续游戏' }, 503);
    }
  };
}
