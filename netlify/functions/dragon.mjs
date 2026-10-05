import { getStore } from '../../server/database.mjs';
import { createLeaderboard } from '../../server/leaderboard.mjs';
import { createHandler } from '../../server/api.mjs';

export default async (request, context) => {
  // Resolve lazily so missing database provisioning produces a useful 503 instead of a startup crash.
  try { return await createHandler(createLeaderboard(getStore()))(request, context); }
  catch {
    return Response.json({ error: '排行榜尚未就绪，请稍后再试；仍可继续游戏' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
};
export const config = { path: '/api/dragon/*' };
