import { createHash, randomBytes, randomUUID, randomInt } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const view = row => row ? { id: row.id, nickname: row.nickname, bestScore: row.best_score } : null;
const validId = id => { if (typeof id !== 'string' || !uuid.test(id)) throw new ApiError(400, '对局编号不正确'); };

// db supplies query(text, params) and transaction(callback); production uses one pg connection per transaction.
export function createLeaderboard(db) {
  return {
    async createGuest() {
      const token = randomBytes(32).toString('hex');
      const { rows } = await db.query(
        'INSERT INTO dragon_players (id, session_hash, nickname) VALUES ($1, $2, $3) RETURNING *',
        [randomUUID(), hash(token), `奶龙玩家 ${randomInt(1000, 10000)}`]
      );
      return { token, player: view(rows[0]) };
    },
    async authenticate(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
      const { rows } = await db.query('SELECT * FROM dragon_players WHERE session_hash = $1 AND session_expires_at > now()', [hash(token)]);
      return view(rows[0]);
    },
    async rename(playerId, value) {
      const nickname = typeof value === 'string' ? value.trim().normalize('NFC') : '';
      if (!/^[\p{L}\p{N}\p{Zs}_\-·]{1,16}$/u.test(nickname)) {
        throw new ApiError(400, '昵称需为 1–16 个字，可使用中文、字母、数字、空格、短横线和下划线');
      }
      const { rows } = await db.query('UPDATE dragon_players SET nickname = $1 WHERE id = $2 RETURNING *', [nickname, playerId]);
      if (!rows[0]) throw new ApiError(401, '游客身份已失效，请刷新页面');
      return view(rows[0]);
    },
    async startRun(playerId, requestId) {
      validId(requestId);
      const { rows } = await db.query(`
        INSERT INTO dragon_runs (id, player_id, request_id) VALUES ($1, $2, $3)
        ON CONFLICT (player_id, request_id) DO UPDATE SET request_id = EXCLUDED.request_id
        RETURNING id, started_at`, [randomUUID(), playerId, requestId]);
      return { id: rows[0].id, startedAt: new Date(rows[0].started_at).toISOString() };
    },
    async finishRun(playerId, runId, score) {
      validId(runId);
      if (!Number.isInteger(score) || score < 0 || score > 10000000 || score % 10 !== 0) {
        throw new ApiError(400, '成绩格式不正确');
      }
      return db.transaction(async tx => {
        // Lock player first so two different runs from the same player cannot overwrite a higher score.
        const player = (await tx.query('SELECT * FROM dragon_players WHERE id = $1 FOR UPDATE', [playerId])).rows[0];
        if (!player) throw new ApiError(401, '游客身份已失效，请刷新页面');
        const run = (await tx.query(`SELECT *, started_at < now() - interval '24 hours' AS expired
          FROM dragon_runs WHERE id = $1 AND player_id = $2 FOR UPDATE`, [runId, playerId])).rows[0];
        if (!run) throw new ApiError(404, '未找到本局记录');
        if (run.result) {
          if (run.score !== score) throw new ApiError(409, '本局已提交，不能修改成绩');
          return run.result;
        }
        if (run.expired) throw new ApiError(410, '本局已超过 24 小时，请重新开始游戏');
        const newRecord = player.best_score === null || score > player.best_score;
        if (newRecord) {
          await tx.query('UPDATE dragon_players SET best_score = $1, achieved_at = clock_timestamp() WHERE id = $2', [score, playerId]);
        }
        const result = { score, bestScore: newRecord ? score : player.best_score, newRecord };
        await tx.query('UPDATE dragon_runs SET score = $1, finished_at = now(), result = $2::jsonb WHERE id = $3', [score, JSON.stringify(result), runId]);
        return result;
      });
    },
    async board(playerId = null) {
      const { rows } = await db.query(`SELECT id, nickname, best_score FROM dragon_players
        WHERE best_score IS NOT NULL ORDER BY best_score DESC, achieved_at ASC, id ASC LIMIT 20`);
      let me = null;
      if (playerId) {
        const personal = (await db.query(`SELECT p.*,
          CASE WHEN p.best_score IS NULL THEN NULL ELSE 1 + (
            SELECT count(*) FROM dragon_players other WHERE other.best_score > p.best_score
              OR (other.best_score = p.best_score AND (other.achieved_at, other.id) < (p.achieved_at, p.id))
          ) END AS rank FROM dragon_players p WHERE p.id = $1`, [playerId])).rows[0];
        if (personal) me = { ...view(personal), rank: personal.rank === null ? null : Number(personal.rank) };
      }
      return { entries: rows.map((p, i) => ({ id: p.id, nickname: p.nickname, score: p.best_score, rank: i + 1 })), me, updatedAt: new Date().toISOString() };
    },
    async throttle(scope, limit, seconds) {
      const bucket = Math.floor(Date.now() / (seconds * 1000));
      const key = hash(`${scope}:${bucket}`);
      const expires = new Date((bucket + 1) * seconds * 1000).toISOString();
      const { rows } = await db.query(`INSERT INTO dragon_rate_limits (key, count, expires_at) VALUES ($1, 1, $2)
        ON CONFLICT (key) DO UPDATE SET count = dragon_rate_limits.count + 1
        WHERE dragon_rate_limits.count < $3 RETURNING count`, [key, expires, limit]);
      if (!rows.length) throw new ApiError(429, '操作太频繁，请稍后再试');
      // Bounded incremental cleanup, no raw IP addresses retained.
      await db.query('DELETE FROM dragon_rate_limits WHERE key IN (SELECT key FROM dragon_rate_limits WHERE expires_at < now() LIMIT 100)');
    },
    async cleanup() {
      // Keep recent finished runs for retry idempotency; permanent personal bests remain.
      await db.query("DELETE FROM dragon_runs WHERE id IN (SELECT id FROM dragon_runs WHERE started_at < now() - interval '30 days' LIMIT 10000)");
      await db.query('DELETE FROM dragon_rate_limits WHERE expires_at < now()');
    }
  };
}
