-- Juara papan XP mingguan (Top 3), dibekukan tiap Senin 00.00 WIB untuk minggu yang baru selesai.
-- Dipakai untuk push "Kamu masuk Top 3!" (sekali per juara per minggu) dan riwayat juara di profil.
CREATE TABLE IF NOT EXISTS weekly_winners (
  week_start  date        NOT NULL,
  rank        smallint    NOT NULL CHECK (rank BETWEEN 1 AND 3),
  user_id     integer     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_xp     integer     NOT NULL,
  notified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_start, rank)
);
CREATE INDEX IF NOT EXISTS weekly_winners_user_idx ON weekly_winners (user_id, week_start DESC);
