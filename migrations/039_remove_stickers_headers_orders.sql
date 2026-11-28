UPDATE comments SET body = '[stiker dihapus]' WHERE body ~ '^\[\[stk:[0-9]+\]\]$';
UPDATE chat_messages SET body = '[stiker dihapus]' WHERE body ~ '^\[\[stk:[0-9]+\]\]$';

DROP TABLE IF EXISTS stickers;

ALTER TABLE users
  DROP COLUMN IF EXISTS header_bg,
  DROP COLUMN IF EXISTS header_v,
  DROP COLUMN IF EXISTS header_blur,
  DROP COLUMN IF EXISTS header_pos;

DO $$
BEGIN
  IF to_regclass('public.premium_orders') IS NOT NULL THEN
    DELETE FROM premium_orders WHERE status <> 'paid';
    IF NOT EXISTS (SELECT 1 FROM premium_orders) THEN
      DROP TABLE premium_orders;
    END IF;
  END IF;
END $$;
