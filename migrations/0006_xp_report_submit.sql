-- 通報の送信でもキャラのXPが増えるようにする(ページ主従の入れ替えに伴い、
-- 「通報」も「トリアージ投票」と並ぶ育成アクションとして扱う)。
-- SQLite は CHECK 制約を直接 ALTER できないため、テーブルを作り直す。
CREATE TABLE xp_events_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT    NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  report_id   TEXT    REFERENCES reports(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('triage_vote', 'report_submit')),
  amount      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

INSERT INTO xp_events_new (id, reporter_id, report_id, kind, amount, created_at)
  SELECT id, reporter_id, report_id, kind, amount, created_at FROM xp_events;

DROP TABLE xp_events;
ALTER TABLE xp_events_new RENAME TO xp_events;

CREATE INDEX idx_xp_events_reporter ON xp_events(reporter_id, created_at DESC);
