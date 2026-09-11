-- Series entries + kinds in public snapshots.
ALTER TABLE public_playlist_items ADD COLUMN kind TEXT DEFAULT 'shiur';
ALTER TABLE public_playlist_items ADD COLUMN items_json TEXT DEFAULT '[]';
