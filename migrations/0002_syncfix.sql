-- Series identity, display fields, millisecond timestamps.
ALTER TABLE playlist_items ADD COLUMN cover_id TEXT DEFAULT '';
ALTER TABLE playlist_items ADD COLUMN date_display TEXT DEFAULT '';
ALTER TABLE playlist_items ADD COLUMN category TEXT DEFAULT '';
ALTER TABLE playlist_items ADD COLUMN is_article INTEGER DEFAULT 0;
ALTER TABLE listening_history ADD COLUMN date_display TEXT DEFAULT '';
ALTER TABLE listening_history ADD COLUMN category TEXT DEFAULT '';
ALTER TABLE listening_history ADD COLUMN is_article INTEGER DEFAULT 0;
