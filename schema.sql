-- Dùng được với npx wrangler d1 execute ... --file=./schema.sql
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  host_token TEXT NOT NULL,
  quiz_json TEXT NOT NULL,
  title TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'lobby',
  question_index INTEGER NOT NULL DEFAULT -1,
  question_started_at INTEGER NOT NULL DEFAULT 0,
  deadline INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  player_token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  FOREIGN KEY (room_code) REFERENCES rooms(code)
);
CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_code, score DESC);
CREATE TABLE IF NOT EXISTS player_presence (
  player_id TEXT PRIMARY KEY REFERENCES players(id),
  last_seen INTEGER NOT NULL,
  kicked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS answers (
  room_code TEXT NOT NULL,
  player_id TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  choice INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  points INTEGER NOT NULL,
  answered_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, player_id, question_index)
);
CREATE INDEX IF NOT EXISTS idx_answers_room_question ON answers(room_code, question_index);

CREATE TABLE IF NOT EXISTS accounts (
  username TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  verifier TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL REFERENCES accounts(username),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_expiry ON account_sessions(expires_at);
CREATE TABLE IF NOT EXISTS room_owners (
  room_code TEXT PRIMARY KEY REFERENCES rooms(code),
  username TEXT NOT NULL REFERENCES accounts(username)
);
CREATE INDEX IF NOT EXISTS idx_room_owners_username ON room_owners(username);
