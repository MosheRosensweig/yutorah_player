-- YUTorah player: users, history, playlists/queue, progress (via history rows).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created_at INTEGER DEFAULT ((unixepoch() * 1000)),
  last_seen_at INTEGER DEFAULT ((unixepoch() * 1000))
);

CREATE TABLE IF NOT EXISTS listening_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shiur_id TEXT NOT NULL,
  title TEXT DEFAULT '',
  speaker TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  duration TEXT DEFAULT '',
  date_iso TEXT DEFAULT '',
  progress_seconds REAL DEFAULT 0,
  duration_seconds REAL DEFAULT 0,
  completed INTEGER DEFAULT 0,
  last_listened_at INTEGER DEFAULT ((unixepoch() * 1000)),
  listen_count INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, shiur_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS playlist_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  playlist TEXT NOT NULL,
  shiur_id TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  title TEXT DEFAULT '',
  speaker TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  duration TEXT DEFAULT '',
  series_title TEXT DEFAULT '',
  kind TEXT DEFAULT 'shiur',
  added_at INTEGER DEFAULT ((unixepoch() * 1000)),
  PRIMARY KEY (user_id, playlist, shiur_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_hist_user_time ON listening_history(user_id, last_listened_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_user_playlist ON playlist_items(user_id, playlist, position);
