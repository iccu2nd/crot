DELETE FROM series WHERE provider = 'komiku';
DELETE FROM providers WHERE key = 'komiku';
DELETE FROM genres g WHERE NOT EXISTS (SELECT 1 FROM series_genres sg WHERE sg.genre_id = g.id);
