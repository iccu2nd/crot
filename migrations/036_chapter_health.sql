CREATE TABLE IF NOT EXISTS chapter_health (
  provider        text NOT NULL,
  ref             text NOT NULL,
  series_provider text NOT NULL,
  series_ref      text NOT NULL,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, ref)
);
CREATE INDEX IF NOT EXISTS chapter_health_series_idx ON chapter_health (series_provider, series_ref);
