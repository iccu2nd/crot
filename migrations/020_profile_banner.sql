-- Background profil (JPEG disimpan di DB; banner_v untuk cache-busting, sama seperti avatar).
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_v integer NOT NULL DEFAULT 0;
