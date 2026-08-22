-- TIUC translation gamification layer
-- Point economy / skill levels are intentionally separate from game XP.

CREATE TABLE IF NOT EXISTS characters (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  xp_total    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE IF NOT EXISTS xp_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  xp          INTEGER NOT NULL,
  source_key  TEXT UNIQUE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  note        TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quest_claims (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id    TEXT NOT NULL,
  claimed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, quest_id)
) STRICT;

-- Existing users/events are backfilled once when the migration is applied.
INSERT OR IGNORE INTO characters (user_id)
SELECT id FROM users;

INSERT OR IGNORE INTO xp_events (user_id, kind, xp, source_key, created_at, note)
SELECT user_id,
       'activity',
       CASE kind
         WHEN 'post_submit' THEN 5
         WHEN 'judgment' THEN 2
         WHEN 'correction_propose' THEN 3
         WHEN 'correction_confirm_bonus' THEN 15
         WHEN 'vote' THEN 2
         WHEN 'adopt_bonus' THEN 30
         ELSE 0
       END,
       'point:' || id,
       created_at,
       kind
FROM point_events
WHERE kind IN ('post_submit','judgment','correction_propose','correction_confirm_bonus','vote','adopt_bonus');

UPDATE characters
SET xp_total = COALESCE((SELECT SUM(xp) FROM xp_events x WHERE x.user_id = characters.user_id), 0),
    updated_at = unixepoch();

-- Every future contribution automatically feeds the game layer.
CREATE TRIGGER IF NOT EXISTS trg_point_event_to_xp
AFTER INSERT ON point_events
WHEN NEW.kind IN ('post_submit','judgment','correction_propose','correction_confirm_bonus','vote','adopt_bonus')
BEGIN
  INSERT OR IGNORE INTO characters (user_id, created_at, updated_at)
  VALUES (NEW.user_id, NEW.created_at, NEW.created_at);

  INSERT OR IGNORE INTO xp_events (user_id, kind, xp, source_key, created_at, note)
  VALUES (
    NEW.user_id,
    'activity',
    CASE NEW.kind
      WHEN 'post_submit' THEN 5
      WHEN 'judgment' THEN 2
      WHEN 'correction_propose' THEN 3
      WHEN 'correction_confirm_bonus' THEN 15
      WHEN 'vote' THEN 2
      WHEN 'adopt_bonus' THEN 30
      ELSE 0
    END,
    'point:' || NEW.id,
    NEW.created_at,
    NEW.kind
  );

  UPDATE characters
     SET xp_total = xp_total + CASE NEW.kind
       WHEN 'post_submit' THEN 5
       WHEN 'judgment' THEN 2
       WHEN 'correction_propose' THEN 3
       WHEN 'correction_confirm_bonus' THEN 15
       WHEN 'vote' THEN 2
       WHEN 'adopt_bonus' THEN 30
       ELSE 0
     END,
         updated_at = NEW.created_at
   WHERE user_id = NEW.user_id;
END;
