-- =====================================================================
-- TIUC: Today is under construction.
-- クビアカ(害虫通報)ドメインから、街なか外国語表記キュレーションドメインへの
-- データモデル全面作り替え(CLAUDE.md「データモデル」章)。
--
-- tiuc-db はこの投入時点でまだ実データがゼロ(コピー直後にDBを新規作成した
-- ばかり)なので、ALTER による段階移行ではなく DROP + CREATE で作り直す。
-- 以後、実データが入った後にスキーマを変える場合はこの手法を使わないこと。
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 旧(クビアカ)スキーマの破棄
-- ---------------------------------------------------------------------
DROP VIEW  IF EXISTS public_mesh_stats;
DROP TRIGGER IF EXISTS trg_report_touch_mesh;
DROP TRIGGER IF EXISTS trg_report_confirm_mesh;
DROP TRIGGER IF EXISTS trg_report_delete_mesh;

DROP TABLE IF EXISTS quest_claims;
DROP TABLE IF EXISTS xp_events;
DROP TABLE IF EXISTS characters;
DROP TABLE IF EXISTS triage_votes;
DROP TABLE IF EXISTS reactions;
DROP TABLE IF EXISTS coord_access_log;
DROP TABLE IF EXISTS point_events;
DROP TABLE IF EXISTS survey_mesh;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS reviewers;
DROP TABLE IF EXISTS reporters;

-- teams はドメインに依存しない([流用]。チーム戦の仕組みはそのまま使う)ので残す。


-- ---------------------------------------------------------------------
-- users : 投稿者・キュレーター(クビアカ reporters/reviewers を統合)
--   ゲスト(匿名UUID・localStorage保持)を基本とし、Googleログインは任意の
--   端末間同期手段として追加するだけ([流用])。
--   実効レベル・重みはここには持たず levels に分離する(rule3)。
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                TEXT    PRIMARY KEY,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  display_name      TEXT,
  email             TEXT    UNIQUE,
  email_verified_at INTEGER,
  google_sub        TEXT,
  team_id           TEXT    REFERENCES teams(id) ON DELETE SET NULL,

  -- 集計値は非正規化(D1 では COUNT のフルスキャンを避けたい)
  points_total      INTEGER NOT NULL DEFAULT 0,
  post_count        INTEGER NOT NULL DEFAULT 0,  -- ①撮影投稿の件数
  judged_count      INTEGER NOT NULL DEFAULT 0,  -- ②違和感チェックの件数
  corrected_count   INTEGER NOT NULL DEFAULT 0,  -- ③修正提案の件数
  adopted_count     INTEGER NOT NULL DEFAULT 0,  -- ④店に採用された貢献の件数

  -- 定点観測ストリーク(同じ場所への再訪) [流用]
  streak_mesh5      TEXT,
  streak_count      INTEGER NOT NULL DEFAULT 0,
  streak_at         INTEGER,

  suspended_at      INTEGER
) STRICT;

CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);
CREATE INDEX idx_users_team ON users(team_id, points_total DESC);


-- ---------------------------------------------------------------------
-- posts : 外国語表記の投稿本体(クビアカ reports を改名・改造)
--
--   【重要】lat / lng は一般公開 API から絶対に返さないこと(rule1・[流用])。
--   【重要】原文/訳文の生テキストは、店がループに入る(採用/claim)前は
--   一般公開しない(rule1新設分)。公開マップは public_mesh_stats 経由のみ。
--   写真は1枚(原文と訳文が同じ写真に写っている)でも2枚(別写真)でもよい
--   可変投稿フロー([変更]。tgt_image_key が NULL なら1枚投稿)。
-- ---------------------------------------------------------------------
CREATE TABLE posts (
  id              TEXT    PRIMARY KEY,
  submitter_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  observed_at     INTEGER,                       -- EXIF の撮影日時が取れた場合

  -- 位置情報 --------------------------------------------------------
  lat             REAL    NOT NULL CHECK (lat BETWEEN 20  AND 46),
  lng             REAL    NOT NULL CHECK (lng BETWEEN 122 AND 154),
  loc_source      TEXT    NOT NULL
                          CHECK (loc_source IN ('exif','geolocation','manual')),
  loc_accuracy_m  REAL,
  loc_conflict    INTEGER NOT NULL DEFAULT 0 CHECK (loc_conflict IN (0,1)),

  -- JIS X 0410 地域メッシュコード(Worker 側で必ず再計算する。rule2)
  mesh3           TEXT    NOT NULL,              --  8桁 / 約1km   一般公開の粒度
  mesh4           TEXT    NOT NULL,              --  9桁 / 約500m  参考粒度
  mesh5           TEXT    NOT NULL,              -- 10桁 / 約250m  重複検出用

  -- 対象言語ペア(MVPスコープ: 日→英/中/韓)
  lang_pair       TEXT    NOT NULL CHECK (lang_pair IN ('ja-en','ja-zh','ja-ko')),
  -- 表記の種別。誰でもサブモード(quality_checks)で後から埋まる想定なので投稿時は任意
  place_kind      TEXT    NOT NULL DEFAULT 'unknown'
                          CHECK (place_kind IN ('menu','sign','notice','other','unknown')),
  -- 発見者が「これ変かも」と思った場合の任意フラグ(スキップ可。rule4系の①)
  flagged         INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)),

  -- 観察内容(原文・訳文はOCR前処理 or キュレーターの書き起こしで後から埋まる。[新規]) -
  original_text   TEXT,
  translated_text TEXT,
  situation       TEXT,                          -- 投稿者の任意メモ(状況・場所の目印など)

  -- 画像 (R2 のキー)。1枚投稿なら src のみ、2枚投稿(原文/訳文が別写真)なら両方 ---
  src_image_key   TEXT    NOT NULL,              -- 長辺1600px 版
  src_thumb_key   TEXT    NOT NULL,              -- 512px 版 / 一覧・判定用
  tgt_image_key   TEXT,                          -- 訳文が別写真の場合のみ
  tgt_thumb_key   TEXT,
  image_bytes     INTEGER,

  -- AI 一次フィルタ(OCR・自然さの一次スコア)の結果。
  -- 断定はさせない(rule4)。MVP では未実装につき常に NULL(後発機能)。
  ai_verdict      TEXT    CHECK (ai_verdict IN ('pass','review','reject')),
  ai_score        REAL    CHECK (ai_score BETWEEN 0 AND 1),
  ai_model        TEXT,
  ai_raw          TEXT,
  ai_at           INTEGER,

  -- 審査状態(CLAUDE.md「status の流れ」) ------------------------------
  --   pending_judgment  ②違和感チェック待ち
  --   needs_fix         違和感ありの票が集まった → ③修正待ち(修正案自体は corrections 側で管理)
  --   looks_ok          違和感なしの票が集まった → 不在データとして保持
  --   confirmed         修正案が確定(新たなゴールドに昇格)
  --   adopted           ④店が採用(ループが閉じる。MVPでは採用APIは未実装)
  status          TEXT    NOT NULL DEFAULT 'pending_judgment'
                          CHECK (status IN ('pending_judgment','needs_fix','looks_ok',
                                            'confirmed','adopted')),
  review_priority INTEGER NOT NULL DEFAULT 100,

  -- 不正対策 --------------------------------------------------------
  turnstile_ok    INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_ok IN (0,1)),
  client_hash     TEXT
) STRICT;

CREATE INDEX idx_posts_queue     ON posts(status, review_priority, created_at);
CREATE INDEX idx_posts_mesh3     ON posts(mesh3, status);
CREATE INDEX idx_posts_dupe      ON posts(mesh5, lang_pair, created_at);
CREATE INDEX idx_posts_bbox      ON posts(lat, lng);
CREATE INDEX idx_posts_submitter ON posts(submitter_id, created_at DESC);
CREATE INDEX idx_posts_thumb_key ON posts(src_thumb_key);


-- ---------------------------------------------------------------------
-- quality_checks : 写真品質・表記種別の入力(誰でもサブモード)
-- ---------------------------------------------------------------------
CREATE TABLE quality_checks (
  id          TEXT    PRIMARY KEY,
  post_id     TEXT    NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  is_clear    INTEGER NOT NULL CHECK (is_clear IN (0,1)),
  place_kind  TEXT    NOT NULL CHECK (place_kind IN ('menu','sign','notice','other')),
  checker_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight      REAL    NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (post_id, checker_id)
) STRICT;
CREATE INDEX idx_quality_checks_post ON quality_checks(post_id);


-- ---------------------------------------------------------------------
-- judgments : 違和感チェック(訳文言語のネイティブ専用サブモード)
--   投稿一覧の「②」。全体のスループットを決める配車弁(CLAUDE.md 4ロール章)。
-- ---------------------------------------------------------------------
CREATE TABLE judgments (
  id          TEXT    PRIMARY KEY,
  post_id     TEXT    NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  verdict     TEXT    NOT NULL CHECK (verdict IN ('natural','unnatural')),
  category    TEXT,
  judge_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_practice INTEGER NOT NULL DEFAULT 0 CHECK (is_practice IN (0,1)),
  weight      REAL    NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (post_id, judge_id)
) STRICT;
CREATE INDEX idx_judgments_post ON judgments(post_id);


-- ---------------------------------------------------------------------
-- corrections : 正誤・修正・解説(バイリンガル専用サブモード)
-- ---------------------------------------------------------------------
CREATE TABLE corrections (
  id          TEXT    PRIMARY KEY,
  post_id     TEXT    NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  -- 'fix' = 修正訳を提案 / 'no_issue' = 「問題なし」の裁定(CLAUDE.md③の2択)
  verdict     TEXT    NOT NULL DEFAULT 'fix' CHECK (verdict IN ('fix','no_issue')),
  fixed_text  TEXT,                          -- verdict='fix' の場合のみ必須(アプリ側で担保)
  explanation TEXT,
  curator_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_practice INTEGER NOT NULL DEFAULT 0 CHECK (is_practice IN (0,1)),
  status      TEXT    NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','confirmed','rejected')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX idx_corrections_post ON corrections(post_id, status);


-- ---------------------------------------------------------------------
-- votes : 修正案への評価(合意が正解を作る。CLAUDE.md 骨背骨8)
-- ---------------------------------------------------------------------
CREATE TABLE votes (
  id             TEXT    PRIMARY KEY,
  correction_id  TEXT    NOT NULL REFERENCES corrections(id) ON DELETE CASCADE,
  voter_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agree          INTEGER NOT NULL CHECK (agree IN (0,1)),
  weight         REAL    NOT NULL DEFAULT 1.0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (correction_id, voter_id)
) STRICT;
CREATE INDEX idx_votes_correction ON votes(correction_id);


-- ---------------------------------------------------------------------
-- levels : ユーザー×言語ペア×サブモード ごとの実効レベル(rule3・骨背骨6-7)
--   降格・昇格・ヒステリシスはこのテーブルで管理する(MVPでは JS 側で単純計算)。
-- ---------------------------------------------------------------------
CREATE TABLE levels (
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lang_pair         TEXT    NOT NULL CHECK (lang_pair IN ('ja-en','ja-zh','ja-ko')),
  submode           TEXT    NOT NULL CHECK (submode IN ('quality','judgment','correction')),
  declared_level    INTEGER NOT NULL DEFAULT 1,   -- 自己申告(初期配車のみに使う)
  effective_weight  REAL    NOT NULL DEFAULT 0.5, -- 内部の細かい重み
  display_rank      TEXT    NOT NULL DEFAULT 'L0' CHECK (display_rank IN ('L0','L1','L2','L3')),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, lang_pair, submode)
) STRICT;
CREATE INDEX idx_levels_user ON levels(user_id);


-- ---------------------------------------------------------------------
-- gold_items : 道場用の既知正解(骨背骨6・9)。
--   MVPではスキーマのみ用意し、出題ロジック(道場UI)は後発機能として次回以降に回す。
-- ---------------------------------------------------------------------
CREATE TABLE gold_items (
  id              TEXT    PRIMARY KEY,
  task            TEXT    NOT NULL,
  correct_answer  TEXT    NOT NULL,
  lang_pair       TEXT    NOT NULL CHECK (lang_pair IN ('ja-en','ja-zh','ja-ko')),
  submode         TEXT    NOT NULL CHECK (submode IN ('quality','judgment','correction')),
  difficulty      TEXT    NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  source          TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','promoted')),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX idx_gold_items_lookup ON gold_items(lang_pair, submode, difficulty);


-- ---------------------------------------------------------------------
-- point_events : ポイント台帳([流用]。合計値だけだと取り消し・再計算ができない)
-- ---------------------------------------------------------------------
CREATE TABLE point_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     TEXT    REFERENCES posts(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL
                      CHECK (kind IN ('post_submit',           -- ①投稿時(少額)
                                      'judgment',              -- ②違和感チェック
                                      'correction_propose',    -- ③修正案の提出
                                      'correction_confirm_bonus', -- 修正案が確定(大)
                                      'vote',                  -- 修正案への投票
                                      'adopt_bonus',           -- ④店に採用(最大)
                                      'revoke',                -- 誤り確定による取り消し
                                      'manual')),
  points      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  note        TEXT
) STRICT;
CREATE INDEX idx_point_events_user ON point_events(user_id, created_at DESC);


-- ---------------------------------------------------------------------
-- coord_access_log : 詳細座標・原本画像へのアクセス監査 [流用]
--   MVPでは書き込み口を用意するのみ(呼び出しは後続の管理者機能で行う)。
-- ---------------------------------------------------------------------
CREATE TABLE coord_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  curator_id  TEXT    NOT NULL,
  post_id     TEXT,
  mesh4       TEXT,
  action      TEXT    NOT NULL CHECK (action IN ('view_detail','export_csv','map_pin')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE INDEX idx_coord_access_log ON coord_access_log(curator_id, created_at DESC);


-- ---------------------------------------------------------------------
-- public_mesh_stats : 一般公開用ビュー
--   lat/lng・原文/訳文の生テキストを構造的に含まない(rule1)。
--   公開 API はこのビューだけを参照する。
-- ---------------------------------------------------------------------
CREATE VIEW public_mesh_stats AS
SELECT
  mesh3,
  COUNT(*)                                             AS post_count,
  COUNT(*) FILTER (WHERE status = 'needs_fix')         AS needs_fix_count,
  COUNT(*) FILTER (WHERE status = 'confirmed')         AS confirmed_count,
  COUNT(*) FILTER (WHERE status = 'adopted')           AS adopted_count,
  MAX(created_at)                                      AS last_post_at
FROM posts
GROUP BY mesh3;
