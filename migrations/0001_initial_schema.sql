-- =====================================================================
-- クビアカツヤカミキリ 通報アプリ / Cloudflare D1 初期スキーマ
--
-- 適用:  npx wrangler d1 migrations apply <DB_NAME> --remote
-- 前提:  時刻はすべて UNIX 秒 (INTEGER)
--        メッシュコードは Worker 側で算出して INSERT 時に渡す
--        STRICT テーブルを使用(型の取り違えを D1 側で弾く)
-- =====================================================================

PRAGMA foreign_keys = ON;


-- ---------------------------------------------------------------------
-- teams : 地域チーム(学校・自治会・自治体単位)
--   個人ランキングより荒れにくく継続率が高いので、チーム所属を最初から持つ
-- ---------------------------------------------------------------------
CREATE TABLE teams (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'community'
                      CHECK (kind IN ('school','community','municipality','company','other')),
  city_code   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;


-- ---------------------------------------------------------------------
-- reporters : 通報者
--   初回は匿名 UUID のみ(localStorage 保持)。メールは任意で後から紐付ける
--   ログイン必須にしないことで通報の心理的ハードルを下げる
-- ---------------------------------------------------------------------
CREATE TABLE reporters (
  id                TEXT    PRIMARY KEY,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  display_name      TEXT,
  email             TEXT    UNIQUE,
  email_verified_at INTEGER,
  team_id           TEXT    REFERENCES teams(id) ON DELETE SET NULL,

  -- 確定率から算出する信頼度。低い人ほどレビューを優先的に人が見る
  trust_score       REAL    NOT NULL DEFAULT 0.5
                            CHECK (trust_score BETWEEN 0 AND 1),

  -- 集計値は非正規化して保持(D1 では COUNT のフルスキャンを避けたい)
  points_total      INTEGER NOT NULL DEFAULT 0,
  submitted_count   INTEGER NOT NULL DEFAULT 0,
  confirmed_count   INTEGER NOT NULL DEFAULT 0,
  rejected_count    INTEGER NOT NULL DEFAULT 0,

  suspended_at      INTEGER
) STRICT;

CREATE INDEX idx_reporters_team ON reporters(team_id, points_total DESC);


-- ---------------------------------------------------------------------
-- reviewers : レビュー担当(自治体職員・専門家)
--   認証は Cloudflare Access に任せ、ここは権限と表示名だけを持つ
-- ---------------------------------------------------------------------
CREATE TABLE reviewers (
  email         TEXT    PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  org           TEXT,
  role          TEXT    NOT NULL DEFAULT 'reviewer'
                        CHECK (role IN ('reviewer','expert','admin')),
  city_code     TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at    INTEGER
) STRICT;


-- ---------------------------------------------------------------------
-- reports : 通報本体
--
--   【重要】lat / lng は一般公開 API から絶対に返さないこと。
--   公開用の集計は下部の public_mesh_stats ビューを経由する。
-- ---------------------------------------------------------------------
CREATE TABLE reports (
  id              TEXT    PRIMARY KEY,
  reporter_id     TEXT    NOT NULL REFERENCES reporters(id) ON DELETE RESTRICT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  observed_at     INTEGER,                       -- EXIF の撮影日時が取れた場合

  -- 位置情報 --------------------------------------------------------
  lat             REAL    NOT NULL CHECK (lat BETWEEN 20  AND 46),
  lng             REAL    NOT NULL CHECK (lng BETWEEN 122 AND 154),
  loc_source      TEXT    NOT NULL
                          CHECK (loc_source IN ('exif','geolocation','manual')),
  loc_accuracy_m  REAL,
  -- EXIF と Geolocation が数百m以上ずれた場合に 1。レビュー優先度を上げる
  loc_conflict    INTEGER NOT NULL DEFAULT 0 CHECK (loc_conflict IN (0,1)),

  -- JIS X 0410 地域メッシュコード(Worker 側で算出)
  mesh3           TEXT    NOT NULL,              --  8桁 / 約1km   一般公開の粒度
  mesh4           TEXT    NOT NULL,              --  9桁 / 約500m  自治体向けの粒度
  mesh5           TEXT    NOT NULL,              -- 10桁 / 約250m  重複検出用

  -- 観察内容 --------------------------------------------------------
  --   'none' = 「この木を見たが異常なし」。不在データも分布調査では同じ価値がある
  finding         TEXT    NOT NULL
                          CHECK (finding IN ('frass','adult_alive','adult_dead',
                                             'exit_hole','none')),
  tree_species    TEXT    NOT NULL DEFAULT 'unknown'
                          CHECK (tree_species IN ('sakura','ume','momo','sumomo',
                                                  'other_rosaceae','non_rosaceae',
                                                  'unknown')),
  note            TEXT,

  -- 画像 (R2 のキー) -------------------------------------------------
  --   異常なし報告でも写真を必須にする。机上でのポイント稼ぎを防ぐ最も効く仕掛け
  image_key       TEXT    NOT NULL,              -- 長辺1600px 版
  thumb_key       TEXT,                          -- 512px 版 / AI判定・一覧用
  image_bytes     INTEGER,

  -- AI 一次フィルタの結果 --------------------------------------------
  --   種の同定はさせない。「幹が写っているか」「排出物らしきものがあるか」の足切りのみ
  ai_verdict      TEXT    CHECK (ai_verdict IN ('pass','review','reject')),
  ai_score        REAL    CHECK (ai_score BETWEEN 0 AND 1),
  ai_model        TEXT,                          -- 後で精度比較するためモデル名を残す
  ai_raw          TEXT,                          -- モデルの生 JSON
  ai_at           INTEGER,

  -- 審査状態 --------------------------------------------------------
  --   queued          AI 判定待ち
  --   auto_rejected   AI が明確に無関係と判定(撮り直しを案内)
  --   pending_review  AI 低信頼。地図には出さずレビュー待ち
  --   provisional     AI 通過。地図に暫定表示中、人の確認待ち
  --   confirmed       人が被害ありと確定
  --   rejected        人が否定
  --   duplicate       既存通報と同一個体・同一樹
  status          TEXT    NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','auto_rejected','pending_review',
                                            'provisional','confirmed','rejected',
                                            'duplicate')),
  -- 小さいほど先に見る。trust_score・ai_score・新規メッシュか否かから算出
  review_priority INTEGER NOT NULL DEFAULT 100,
  duplicate_of    TEXT    REFERENCES reports(id) ON DELETE SET NULL,

  reviewed_by     TEXT    REFERENCES reviewers(email) ON DELETE SET NULL,
  reviewed_at     INTEGER,
  review_note     TEXT,

  -- 不正対策 --------------------------------------------------------
  turnstile_ok    INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_ok IN (0,1)),
  client_hash     TEXT                           -- IP+UA のソルト付きハッシュ。生値は保存しない
) STRICT;

-- レビューキューの取り出し
CREATE INDEX idx_reports_queue    ON reports(status, review_priority, created_at);
-- 公開マップの集計
CREATE INDEX idx_reports_mesh3    ON reports(mesh3, status);
-- 重複検出(同一 250m メッシュ・同一発見物・直近N日)
CREATE INDEX idx_reports_dupe     ON reports(mesh5, finding, created_at);
-- 自治体向けの範囲検索
CREATE INDEX idx_reports_bbox     ON reports(lat, lng);
-- マイページ
CREATE INDEX idx_reports_reporter ON reports(reporter_id, created_at DESC);
-- AI 判定待ちの拾い上げ(部分インデックス)
CREATE INDEX idx_reports_pending  ON reports(created_at) WHERE status = 'queued';


-- ---------------------------------------------------------------------
-- point_events : ポイント台帳
--   合計値だけ持つと取り消し・再計算ができない。加点は必ず履歴で持つ
-- ---------------------------------------------------------------------
CREATE TABLE point_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT    NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  report_id   TEXT    REFERENCES reports(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL
                      CHECK (kind IN ('submit',            -- 投稿時(少額)
                                      'confirm_bonus',     -- 専門家が確定(大)
                                      'new_mesh_bonus',    -- 未調査メッシュを埋めた
                                      'negative_survey',   -- 異常なし報告
                                      'duplicate_penalty',
                                      'revoke',            -- 誤報確定による取り消し
                                      'manual')),
  points      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  note        TEXT
) STRICT;

CREATE INDEX idx_point_events_reporter ON point_events(reporter_id, created_at DESC);


-- ---------------------------------------------------------------------
-- survey_mesh : 調査対象メッシュのマスタ
--   「未調査エリアを埋めると高得点」を成立させるための土台。
--   通報は人口密集地に偏るので、空白メッシュを可視化して空間バイアスを補正する
-- ---------------------------------------------------------------------
CREATE TABLE survey_mesh (
  mesh3           TEXT    PRIMARY KEY,           -- 8桁 / 約1km
  city_code       TEXT    NOT NULL,
  city_name       TEXT    NOT NULL,
  is_target       INTEGER NOT NULL DEFAULT 1 CHECK (is_target IN (0,1)),
  host_tree_hint  INTEGER,                       -- 推定寄主木本数(あれば)
  report_count    INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  last_report_at  INTEGER
) STRICT;

CREATE INDEX idx_survey_mesh_city ON survey_mesh(city_code, is_target, last_report_at);


-- ---------------------------------------------------------------------
-- coord_access_log : 詳細座標へのアクセス監査
--   私有地の座標を扱う以上、誰がいつ見たかは残す必要がある
-- ---------------------------------------------------------------------
CREATE TABLE coord_access_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reviewer_email TEXT    NOT NULL,
  report_id      TEXT,
  mesh4          TEXT,
  action         TEXT    NOT NULL
                         CHECK (action IN ('view_detail','export_csv','map_pin')),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX idx_coord_access_log ON coord_access_log(reviewer_email, created_at DESC);


-- ---------------------------------------------------------------------
-- public_mesh_stats : 一般公開用ビュー
--   lat / lng を構造的に含まない。公開 API はこのビューだけを参照する
-- ---------------------------------------------------------------------
CREATE VIEW public_mesh_stats AS
SELECT
  mesh3,
  COUNT(*) FILTER (WHERE finding <> 'none')                        AS damage_reports,
  COUNT(*) FILTER (WHERE finding <> 'none' AND status = 'confirmed') AS confirmed_reports,
  COUNT(*) FILTER (WHERE finding =  'none')                        AS clear_surveys,
  MAX(created_at)                                                  AS last_report_at
FROM reports
WHERE status IN ('provisional','confirmed')
GROUP BY mesh3;


-- ---------------------------------------------------------------------
-- トリガ : survey_mesh の集計値を自動更新
--   Worker 側で更新し忘れると「未調査メッシュ」の表示が壊れるので DB 側で担保
-- ---------------------------------------------------------------------
CREATE TRIGGER trg_report_touch_mesh
AFTER INSERT ON reports
BEGIN
  UPDATE survey_mesh
     SET report_count   = report_count + 1,
         last_report_at = NEW.created_at
   WHERE mesh3 = NEW.mesh3;
END;

CREATE TRIGGER trg_report_confirm_mesh
AFTER UPDATE OF status ON reports
WHEN NEW.status = 'confirmed' AND OLD.status <> 'confirmed'
BEGIN
  UPDATE survey_mesh
     SET confirmed_count = confirmed_count + 1
   WHERE mesh3 = NEW.mesh3;
END;
