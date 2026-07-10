CREATE TABLE IF NOT EXISTS member_codes (
  code TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unused',
  device_id TEXT,
  started_at TEXT,
  expires_at TEXT,
  stopped_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_code TEXT,
  rating INTEGER,
  improve TEXT,
  wanted_feature TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('hotel','spot','food')),
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  score INTEGER NOT NULL DEFAULT 80,
  label TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  point TEXT NOT NULL DEFAULT '',
  reservation TEXT NOT NULL DEFAULT '',
  maps_query TEXT NOT NULL DEFAULT '',
  review_query TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS consult_slots (
  month TEXT PRIMARY KEY,
  used_count INTEGER NOT NULL DEFAULT 0,
  limit_count INTEGER NOT NULL DEFAULT 10,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO member_codes(code) VALUES
('001'),('002'),('003'),('004'),('005'),
('006'),('007'),('008'),('009'),('010');
