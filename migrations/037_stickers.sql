CREATE TABLE IF NOT EXISTS stickers (
  id         serial PRIMARY KEY,
  owner_id   integer REFERENCES users(id) ON DELETE CASCADE,
  image      bytea NOT NULL,
  mime       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stickers_owner_idx ON stickers (owner_id, id DESC);
