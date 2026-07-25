-- Google ログイン(任意)。ゲスト運用はそのまま維持し、これは追加のみ。
--
-- SQLite の ALTER TABLE ADD COLUMN は UNIQUE 制約を直接付けられない
-- (「Cannot add a UNIQUE column」で失敗する)。列は制約なしで追加し、
-- 一意性は別途 UNIQUE INDEX で担保する。NULL は複数許容されるので
-- (ゲストのまま = google_sub が NULL の行が大多数)、この形で問題ない。
ALTER TABLE reporters ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_reporters_google_sub ON reporters(google_sub);
