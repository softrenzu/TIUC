-- コアループ拡張(図鑑/クエスト/定点観測ストリーク)・段階報酬(承認ボーナス/取り消し)。
-- 図鑑は reports から直接集計するため新規テーブル不要。クエストは達成済みフラグのみ
-- ここで持ち、達成判定自体は毎回サーバ側で再評価する(クライアントを信用しない)。

CREATE TABLE quest_claims (
  reporter_id TEXT    NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  quest_id    TEXT    NOT NULL,
  claimed_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (reporter_id, quest_id)
) STRICT;

-- 定点観測ストリーク: 直近の通報地点(mesh5)と連続回数のみを持つ軽量実装。
ALTER TABLE reporters ADD COLUMN streak_mesh5 TEXT;
ALTER TABLE reporters ADD COLUMN streak_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reporters ADD COLUMN streak_at INTEGER;

-- xp_events.kind に quest_bonus / confirm_bonus / revoke を追加。SQLiteはCHECKを直接
-- ALTERできないため、0006と同じ「テーブル作り直し」手順を踏襲する。
-- ストリークボーナスは独立の kind を作らず report_submit の amount に合算する
-- (revoke時に「この通報で付与した合計XP」を1回のSUMで正確に引けるようにするため)。
CREATE TABLE xp_events_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT    NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  report_id   TEXT    REFERENCES reports(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL CHECK (kind IN (
                'triage_vote', 'report_submit', 'quest_bonus', 'confirm_bonus', 'revoke')),
  amount      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
INSERT INTO xp_events_new (id, reporter_id, report_id, kind, amount, created_at)
  SELECT id, reporter_id, report_id, kind, amount, created_at FROM xp_events;
DROP TABLE xp_events;
ALTER TABLE xp_events_new RENAME TO xp_events;
CREATE INDEX idx_xp_events_reporter ON xp_events(reporter_id, created_at DESC);
