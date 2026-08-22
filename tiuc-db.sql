PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_initial_schema.sql','2026-08-22 01:22:09');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_map_columns.sql','2026-08-22 01:22:09');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0003_google_auth.sql','2026-08-22 01:22:09');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(4,'0004_report_delete_trigger.sql','2026-08-22 01:22:09');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(5,'0005_gamification.sql','2026-08-22 01:22:10');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(6,'0006_xp_report_submit.sql','2026-08-22 01:22:10');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(7,'0007_quests_streaks.sql','2026-08-22 01:22:10');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(8,'0008_translation_domain.sql','2026-08-22 01:22:10');
CREATE TABLE teams (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'community'
                      CHECK (kind IN ('school','community','municipality','company','other')),
  city_code   TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE users (
  id                TEXT    PRIMARY KEY,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  display_name      TEXT,
  email             TEXT    UNIQUE,
  email_verified_at INTEGER,
  google_sub        TEXT,
  team_id           TEXT    REFERENCES teams(id) ON DELETE SET NULL,

  
  points_total      INTEGER NOT NULL DEFAULT 0,
  post_count        INTEGER NOT NULL DEFAULT 0,  
  judged_count      INTEGER NOT NULL DEFAULT 0,  
  corrected_count   INTEGER NOT NULL DEFAULT 0,  
  adopted_count     INTEGER NOT NULL DEFAULT 0,  

  
  streak_mesh5      TEXT,
  streak_count      INTEGER NOT NULL DEFAULT 0,
  streak_at         INTEGER,

  suspended_at      INTEGER
) STRICT;
INSERT INTO "users" ("id","created_at","display_name","email","email_verified_at","google_sub","team_id","points_total","post_count","judged_count","corrected_count","adopted_count","streak_mesh5","streak_count","streak_at","suspended_at") VALUES('cac8375b-8d34-44a1-8246-be2bdc9bcf3b',1787367086,NULL,NULL,NULL,NULL,NULL,2,1,0,0,0,NULL,0,NULL,NULL);
INSERT INTO "users" ("id","created_at","display_name","email","email_verified_at","google_sub","team_id","points_total","post_count","judged_count","corrected_count","adopted_count","streak_mesh5","streak_count","streak_at","suspended_at") VALUES('04e7286a-0f04-4d8d-ac5f-0dd0f8e9438c',1787379367,NULL,NULL,NULL,NULL,NULL,3,1,1,0,0,NULL,0,NULL,NULL);
CREATE TABLE posts (
  id              TEXT    PRIMARY KEY,
  submitter_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  observed_at     INTEGER,                       

  
  lat             REAL    NOT NULL CHECK (lat BETWEEN 20  AND 46),
  lng             REAL    NOT NULL CHECK (lng BETWEEN 122 AND 154),
  loc_source      TEXT    NOT NULL
                          CHECK (loc_source IN ('exif','geolocation','manual')),
  loc_accuracy_m  REAL,
  loc_conflict    INTEGER NOT NULL DEFAULT 0 CHECK (loc_conflict IN (0,1)),

  
  mesh3           TEXT    NOT NULL,              
  mesh4           TEXT    NOT NULL,              
  mesh5           TEXT    NOT NULL,              

  
  lang_pair       TEXT    NOT NULL CHECK (lang_pair IN ('ja-en','ja-zh','ja-ko')),
  
  place_kind      TEXT    NOT NULL DEFAULT 'unknown'
                          CHECK (place_kind IN ('menu','sign','notice','other','unknown')),
  
  flagged         INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)),

  
  original_text   TEXT,
  translated_text TEXT,
  situation       TEXT,                          

  
  src_image_key   TEXT    NOT NULL,              
  src_thumb_key   TEXT    NOT NULL,              
  tgt_image_key   TEXT,                          
  tgt_thumb_key   TEXT,
  image_bytes     INTEGER,

  
  
  ai_verdict      TEXT    CHECK (ai_verdict IN ('pass','review','reject')),
  ai_score        REAL    CHECK (ai_score BETWEEN 0 AND 1),
  ai_model        TEXT,
  ai_raw          TEXT,
  ai_at           INTEGER,

  
  
  
  
  
  
  status          TEXT    NOT NULL DEFAULT 'pending_judgment'
                          CHECK (status IN ('pending_judgment','needs_fix','looks_ok',
                                            'confirmed','adopted')),
  review_priority INTEGER NOT NULL DEFAULT 100,

  
  turnstile_ok    INTEGER NOT NULL DEFAULT 0 CHECK (turnstile_ok IN (0,1)),
  client_hash     TEXT
) STRICT;
INSERT INTO "posts" ("id","submitter_id","created_at","observed_at","lat","lng","loc_source","loc_accuracy_m","loc_conflict","mesh3","mesh4","mesh5","lang_pair","place_kind","flagged","original_text","translated_text","situation","src_image_key","src_thumb_key","tgt_image_key","tgt_thumb_key","image_bytes","ai_verdict","ai_score","ai_model","ai_raw","ai_at","status","review_priority","turnstile_ok","client_hash") VALUES('79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0','cac8375b-8d34-44a1-8246-be2bdc9bcf3b',1787367086,NULL,35.68453888888889,139.7421,'exif',38.060001373291016,0,'53394529','533945291','5339452912','ja-en','menu',1,NULL,NULL,NULL,'p/2026/08/79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0/src-full.jpg','p/2026/08/79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0/src-thumb.jpg','p/2026/08/79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0/tgt-full.jpg','p/2026/08/79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0/tgt-thumb.jpg',108282,NULL,NULL,NULL,NULL,NULL,'pending_judgment',80,0,'fa243deb5e447d1e69b9c3bc7df12cac');
INSERT INTO "posts" ("id","submitter_id","created_at","observed_at","lat","lng","loc_source","loc_accuracy_m","loc_conflict","mesh3","mesh4","mesh5","lang_pair","place_kind","flagged","original_text","translated_text","situation","src_image_key","src_thumb_key","tgt_image_key","tgt_thumb_key","image_bytes","ai_verdict","ai_score","ai_model","ai_raw","ai_at","status","review_priority","turnstile_ok","client_hash") VALUES('911105ae-4c18-4306-a1ed-c168093871f6','04e7286a-0f04-4d8d-ac5f-0dd0f8e9438c',1787379367,NULL,35.70170053582558,139.7498926053833,'manual',NULL,0,'53394549','533945492','5339454922','ja-en','menu',1,NULL,NULL,'Menu bakery','p/2026/08/911105ae-4c18-4306-a1ed-c168093871f6/src-full.jpg','p/2026/08/911105ae-4c18-4306-a1ed-c168093871f6/src-thumb.jpg',NULL,NULL,292724,NULL,NULL,NULL,NULL,NULL,'pending_judgment',80,0,'6a50219252ced8f7756951d017c9dfde');
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
INSERT INTO "judgments" ("id","post_id","verdict","category","judge_id","is_practice","weight","created_at") VALUES('dc01a16a-e830-44e9-ac36-e885f11dae7e','79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0','natural',NULL,'04e7286a-0f04-4d8d-ac5f-0dd0f8e9438c',0,1,1787379384);
CREATE TABLE corrections (
  id          TEXT    PRIMARY KEY,
  post_id     TEXT    NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  
  verdict     TEXT    NOT NULL DEFAULT 'fix' CHECK (verdict IN ('fix','no_issue')),
  fixed_text  TEXT,                          
  explanation TEXT,
  curator_id  TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_practice INTEGER NOT NULL DEFAULT 0 CHECK (is_practice IN (0,1)),
  status      TEXT    NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','confirmed','rejected')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
CREATE TABLE votes (
  id             TEXT    PRIMARY KEY,
  correction_id  TEXT    NOT NULL REFERENCES corrections(id) ON DELETE CASCADE,
  voter_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agree          INTEGER NOT NULL CHECK (agree IN (0,1)),
  weight         REAL    NOT NULL DEFAULT 1.0,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (correction_id, voter_id)
) STRICT;
CREATE TABLE levels (
  user_id           TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lang_pair         TEXT    NOT NULL CHECK (lang_pair IN ('ja-en','ja-zh','ja-ko')),
  submode           TEXT    NOT NULL CHECK (submode IN ('quality','judgment','correction')),
  declared_level    INTEGER NOT NULL DEFAULT 1,   
  effective_weight  REAL    NOT NULL DEFAULT 0.5, 
  display_rank      TEXT    NOT NULL DEFAULT 'L0' CHECK (display_rank IN ('L0','L1','L2','L3')),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, lang_pair, submode)
) STRICT;
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
CREATE TABLE point_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     TEXT    REFERENCES posts(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL
                      CHECK (kind IN ('post_submit',           
                                      'judgment',              
                                      'correction_propose',    
                                      'correction_confirm_bonus', 
                                      'vote',                  
                                      'adopt_bonus',           
                                      'revoke',                
                                      'manual')),
  points      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  note        TEXT
) STRICT;
INSERT INTO "point_events" ("id","user_id","post_id","kind","points","created_at","note") VALUES(1,'cac8375b-8d34-44a1-8246-be2bdc9bcf3b','79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0','post_submit',2,1787367086,NULL);
INSERT INTO "point_events" ("id","user_id","post_id","kind","points","created_at","note") VALUES(2,'04e7286a-0f04-4d8d-ac5f-0dd0f8e9438c','911105ae-4c18-4306-a1ed-c168093871f6','post_submit',2,1787379367,NULL);
INSERT INTO "point_events" ("id","user_id","post_id","kind","points","created_at","note") VALUES(3,'04e7286a-0f04-4d8d-ac5f-0dd0f8e9438c','79e85d23-79c5-4d2a-a3ab-0eda28e4c3c0','judgment',1,1787379384,NULL);
CREATE TABLE coord_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  curator_id  TEXT    NOT NULL,
  post_id     TEXT,
  mesh4       TEXT,
  action      TEXT    NOT NULL CHECK (action IN ('view_detail','export_csv','map_pin')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',8);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('point_events',3);
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);
CREATE INDEX idx_users_team ON users(team_id, points_total DESC);
CREATE INDEX idx_posts_queue     ON posts(status, review_priority, created_at);
CREATE INDEX idx_posts_mesh3     ON posts(mesh3, status);
CREATE INDEX idx_posts_dupe      ON posts(mesh5, lang_pair, created_at);
CREATE INDEX idx_posts_bbox      ON posts(lat, lng);
CREATE INDEX idx_posts_submitter ON posts(submitter_id, created_at DESC);
CREATE INDEX idx_posts_thumb_key ON posts(src_thumb_key);
CREATE INDEX idx_quality_checks_post ON quality_checks(post_id);
CREATE INDEX idx_judgments_post ON judgments(post_id);
CREATE INDEX idx_corrections_post ON corrections(post_id, status);
CREATE INDEX idx_votes_correction ON votes(correction_id);
CREATE INDEX idx_levels_user ON levels(user_id);
CREATE INDEX idx_gold_items_lookup ON gold_items(lang_pair, submode, difficulty);
CREATE INDEX idx_point_events_user ON point_events(user_id, created_at DESC);
CREATE INDEX idx_coord_access_log ON coord_access_log(curator_id, created_at DESC);
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
