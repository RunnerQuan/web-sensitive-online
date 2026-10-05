CREATE TABLE dragon_players (
  id uuid PRIMARY KEY,
  session_hash text NOT NULL UNIQUE,
  session_expires_at timestamptz NOT NULL DEFAULT (now() + interval '365 days'),
  nickname text NOT NULL CHECK (char_length(nickname) BETWEEN 1 AND 16),
  best_score integer CHECK (best_score BETWEEN 0 AND 10000000 AND best_score % 10 = 0),
  achieved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((best_score IS NULL) = (achieved_at IS NULL))
);

CREATE INDEX dragon_players_ranking ON dragon_players (best_score DESC, achieved_at ASC, id ASC)
  WHERE best_score IS NOT NULL;

CREATE TABLE dragon_runs (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES dragon_players(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  rules_version text NOT NULL DEFAULT 'dragon-v1',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  score integer CHECK (score BETWEEN 0 AND 10000000 AND score % 10 = 0),
  result jsonb,
  UNIQUE (player_id, request_id),
  CHECK ((finished_at IS NULL) = (result IS NULL)),
  CHECK ((score IS NULL) = (result IS NULL))
);
CREATE INDEX dragon_runs_player_time ON dragon_runs (player_id, started_at DESC);
CREATE INDEX dragon_runs_cleanup ON dragon_runs (started_at);

CREATE TABLE dragon_rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX dragon_rate_limits_expiry ON dragon_rate_limits (expires_at);
