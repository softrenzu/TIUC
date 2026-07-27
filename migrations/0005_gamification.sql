-- キャラ育成ゲーム(仮称「ヨソモン」)v1。
--
-- 通報された写真の一次振り分け(トリアージ)を市民参加のミニゲームにする。
-- rule1(私有地写真はレビュアー限定)は変えない: 投票者に見せるのはサムネイルのみ、
-- 位置情報・メモ・通報者情報は一切渡さない(/img/ 側の voter_id 分岐で thumb_key のみ許可)。
-- ポイント経済も既存の point_events/points_total とは完全に分離する
-- (rule3の「投稿の正確性」に紐づく既存ポイントの意味を壊さないため)。

CREATE TABLE triage_votes (
  report_id          TEXT    NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  voter_id           TEXT    NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  trunk_visible      INTEGER NOT NULL CHECK (trunk_visible IN (0,1)),
  debris_like        INTEGER NOT NULL CHECK (debris_like IN (0,1)),
  clearly_irrelevant INTEGER NOT NULL CHECK (clearly_irrelevant IN (0,1)),
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (report_id, voter_id)
) STRICT;
CREATE INDEX idx_triage_votes_report ON triage_votes(report_id);

CREATE TABLE characters (
  reporter_id TEXT    PRIMARY KEY REFERENCES reporters(id) ON DELETE CASCADE,
  xp_total    INTEGER NOT NULL DEFAULT 0,
  level       INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE TABLE xp_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT    NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  report_id   TEXT    REFERENCES reports(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('triage_vote')),
  amount      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX idx_xp_events_reporter ON xp_events(reporter_id, created_at DESC);

-- 投票UIの最頻出読み取りパス(/img/ の voter_id 分岐)が thumb_key で reports を
-- 引くため、フルスキャンを避けるインデックスを張る。
CREATE INDEX idx_reports_thumb_key ON reports(thumb_key);
