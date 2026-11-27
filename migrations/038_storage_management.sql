CREATE TABLE IF NOT EXISTS storage_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL,
  level      text,
  db_bytes   bigint,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS storage_events_kind_idx ON storage_events (kind, id DESC);

DROP INDEX IF EXISTS series_norm_title_idx;

ALTER TABLE stickers ADD COLUMN IF NOT EXISTS content_hash bytea;
UPDATE stickers SET content_hash = sha256(image) WHERE content_hash IS NULL;
CREATE INDEX IF NOT EXISTS stickers_hash_idx ON stickers (content_hash);

ALTER TABLE series SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05, autovacuum_vacuum_threshold = 50);
ALTER TABLE chapters SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05, autovacuum_vacuum_threshold = 100);
ALTER TABLE series_views SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05, autovacuum_vacuum_threshold = 50);
ALTER TABLE series_genres SET (autovacuum_vacuum_scale_factor = 0.1, autovacuum_analyze_scale_factor = 0.1);
ALTER TABLE chapter_health SET (autovacuum_vacuum_scale_factor = 0.1, autovacuum_vacuum_threshold = 20);
ALTER TABLE chat_messages SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 25);
ALTER TABLE push_log SET (autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 25);
