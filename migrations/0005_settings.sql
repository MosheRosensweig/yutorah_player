-- App-wide ops switches (maintenance mode etc.). Single-row KV style.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT '',
  updated_at INTEGER DEFAULT ((unixepoch() * 1000))
);
