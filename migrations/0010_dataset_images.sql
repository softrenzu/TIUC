-- TIUC reference image dataset metadata.
-- Image binaries live in Cloudflare R2; D1 stores metadata and the R2 key only.

CREATE TABLE IF NOT EXISTS dataset_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path     TEXT NOT NULL UNIQUE,
  dataset_group TEXT NOT NULL,
  filename      TEXT NOT NULL,
  label_hint    TEXT NOT NULL
                CHECK (label_hint IN ('likely_problem','needs_review')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed'
                CHECK (review_status IN ('unreviewed','accepted','rejected','used')),
  lang_pair     TEXT
                CHECK (lang_pair IS NULL OR lang_pair IN ('ja-en','ja-zh','ja-ko')),
  place_kind    TEXT
                CHECK (place_kind IS NULL OR place_kind IN ('menu','sign','notice','other','unknown')),
  difficulty    TEXT
                CHECK (difficulty IS NULL OR difficulty IN ('easy','medium','hard')),
  r2_key        TEXT,
  source_repo   TEXT NOT NULL DEFAULT 't2ag3/TIUC',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

CREATE INDEX IF NOT EXISTS idx_dataset_images_queue
ON dataset_images(review_status, dataset_group, id);

CREATE INDEX IF NOT EXISTS idx_dataset_images_r2
ON dataset_images(r2_key);
