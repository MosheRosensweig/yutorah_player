-- Public (shareable) playlists: snapshot copies, owner display name only.
CREATE TABLE IF NOT EXISTS public_playlists (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name TEXT DEFAULT '',
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  tags_json TEXT DEFAULT '[]',
  is_public INTEGER DEFAULT 1,
  saves INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT ((unixepoch() * 1000)),
  updated_at INTEGER DEFAULT ((unixepoch() * 1000))
);

CREATE TABLE IF NOT EXISTS public_playlist_items (
  playlist_id TEXT NOT NULL REFERENCES public_playlists(id) ON DELETE CASCADE,
  shiur_id TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  title TEXT DEFAULT '',
  speaker TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  duration TEXT DEFAULT '',
  PRIMARY KEY (playlist_id, position)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS playlist_saves (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL REFERENCES public_playlists(id) ON DELETE CASCADE,
  created_at INTEGER DEFAULT ((unixepoch() * 1000)),
  PRIMARY KEY (user_id, playlist_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_pub_public_updated ON public_playlists(is_public, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pub_owner ON public_playlists(owner_id);
CREATE INDEX IF NOT EXISTS idx_saves_pl ON playlist_saves(playlist_id);
