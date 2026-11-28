-- Global Chat: simpan juga id pengirim pesan yang dibalas, supaya app bisa menandai "balasan untuk kamu" (tanda @) dengan pasti
-- tanpa menebak dari nama. Tanpa FK: pesan asli bisa sudah dipangkas, kutipan tetap tampil.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_user_id integer;
-- Isi ulang balasan lama yang pesan aslinya masih ada.
UPDATE chat_messages m SET reply_user_id = q.user_id
  FROM chat_messages q
 WHERE m.reply_to IS NOT NULL AND m.reply_user_id IS NULL AND q.id = m.reply_to;
