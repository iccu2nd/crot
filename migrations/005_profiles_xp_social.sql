ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS xp integer NOT NULL DEFAULT 0 CHECK (xp >= 0);
UPDATE users SET display_name = username WHERE display_name = '';
ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id bigint REFERENCES comments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments(parent_id, id ASC);
CREATE TABLE IF NOT EXISTS user_xp_events (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, event_key)
);
CREATE TABLE IF NOT EXISTS comment_reactions (
  comment_id bigint NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('like','dislike')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(comment_id, user_id)
);
