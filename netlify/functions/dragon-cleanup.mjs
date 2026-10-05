import { getStore } from '../../server/database.mjs';
import { createLeaderboard } from '../../server/leaderboard.mjs';

export default async () => {
  await createLeaderboard(getStore()).cleanup();
  return new Response(null, { status: 204 });
};
export const config = { schedule: '17 3 * * *' };
