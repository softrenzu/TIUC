ALTER TABLE reports ADD COLUMN land_type TEXT;
ALTER TABLE reports ADD COLUMN response_status TEXT;
ALTER TABLE reports ADD COLUMN response_note TEXT;
ALTER TABLE reports ADD COLUMN response_updated_at INTEGER;

CREATE INDEX idx_reports_public_pin ON reports(lat, lng)
  WHERE land_type = 'public' AND status = 'confirmed';

CREATE TABLE reactions (
  report_id   TEXT    NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  reporter_id TEXT    NOT NULL REFERENCES reporters(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('seen_too','thanks')),
  lat         REAL,
  lng         REAL,
  mesh5       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (report_id, reporter_id, kind)
) STRICT;

CREATE INDEX idx_reactions_report ON reactions(report_id, kind);
