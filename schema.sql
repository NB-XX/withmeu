CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  kr TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT NOT NULL DEFAULT '2026-01-01 00:00:00.000',
  last_fetched TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  message_id INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  content TEXT,
  type TEXT,
  created_at TEXT,
  is_delete TEXT,
  deleted_at TEXT,
  message_reply_id INTEGER,
  reply_content TEXT,
  nickname TEXT,
  profile_image TEXT,
  PRIMARY KEY (profile_id, message_id)
);

CREATE TABLE IF NOT EXISTS translations (
  message_id INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  translation TEXT,
  fan_translation TEXT,
  PRIMARY KEY (profile_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_msg_profile_created ON messages(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trans_profile ON translations(profile_id);

CREATE TABLE IF NOT EXISTS tokens (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
