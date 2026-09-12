-- Luna: начальная схема БД
-- (PRAGMA journal_mode/synchronous выставляются в db.ts при открытии:
--  их нельзя менять внутри транзакции миграции)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,            -- discord user id
  username      TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL DEFAULT '',
  is_owner      INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  person_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  familiarity   REAL NOT NULL DEFAULT 0,     -- 0..1 насколько хорошо Luna знает человека
  trust         REAL NOT NULL DEFAULT 0.3,
  closeness     REAL NOT NULL DEFAULT 0,
  respect       REAL NOT NULL DEFAULT 0.3,
  affection     REAL NOT NULL DEFAULT 0,
  shared_xp     INTEGER NOT NULL DEFAULT 0,  -- значимые совместные события
  interactions  INTEGER NOT NULL DEFAULT 0,
  summary       TEXT NOT NULL DEFAULT '',    -- естественное описание отношений (обновляет фон)
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  person_id     TEXT,                        -- о ком память (NULL = о мире/Luna)
  channel_id    TEXT,
  kind          TEXT NOT NULL,               -- fact|preference|event|joke|promise|open_thread|impression|consolidated
  content       TEXT NOT NULL,               -- естественная формулировка
  objective     TEXT NOT NULL DEFAULT '[]',  -- JSON array объективных фактов
  subjective    TEXT,                        -- JSON {opinion, emotion, intensity} — впечатление Luna
  emotion       TEXT,                        -- эмоция события (НЕ текущее настроение)
  emotion_intensity REAL NOT NULL DEFAULT 0,
  importance    REAL NOT NULL DEFAULT 0.3,   -- 0..1
  confidence    REAL NOT NULL DEFAULT 0.9,   -- 0..1
  embedding     BLOB,                        -- Float32Array
  dedupe_key    TEXT,                        -- нормализованный ключ темы для dedupe
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_recalled_at INTEGER,
  recall_count  INTEGER NOT NULL DEFAULT 0,
  source_conversation_id TEXT,
  superseded_by TEXT,                        -- ссылка на объединившую память
  status        TEXT NOT NULL DEFAULT 'active'  -- active|merged|deleted
);

CREATE INDEX IF NOT EXISTS idx_memories_person   ON memories(person_id, status);
CREATE INDEX IF NOT EXISTS idx_memories_kind     ON memories(kind, status);
CREATE INDEX IF NOT EXISTS idx_memories_created  ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(status, importance);
CREATE INDEX IF NOT EXISTS idx_memories_dedupe   ON memories(person_id, dedupe_key, status);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  period_start  INTEGER NOT NULL,
  period_end    INTEGER NOT NULL,
  summary       TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_channel ON conversation_summaries(channel_id, created_at);

-- Текущее эмоциональное состояние Luna (синглтон id='current').
-- Отдельно от эмоций событий в memories — это разные сущности.
CREATE TABLE IF NOT EXISTS emotional_states (
  id            TEXT PRIMARY KEY,
  mood          REAL NOT NULL DEFAULT 0.2,      -- -1..1
  energy        REAL NOT NULL DEFAULT 0.6,      -- 0..1
  playfulness   REAL NOT NULL DEFAULT 0.6,      -- 0..1
  irritation    REAL NOT NULL DEFAULT 0,        -- 0..1
  warmth        REAL NOT NULL DEFAULT 0.5,      -- 0..1
  social_energy REAL NOT NULL DEFAULT 0.7,      -- 0..1
  updated_at    INTEGER NOT NULL                -- для ленивого decay
);

-- Настройки: scope = 'global' | 'user:<id>' | 'channel:<id>'
CREATE TABLE IF NOT EXISTS settings (
  scope         TEXT NOT NULL,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS interaction_stats (
  person_id     TEXT NOT NULL,
  day           TEXT NOT NULL,                  -- YYYY-MM-DD
  messages_in   INTEGER NOT NULL DEFAULT 0,
  messages_out  INTEGER NOT NULL DEFAULT 0,
  voice_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, day)
);

CREATE TABLE IF NOT EXISTS telemetry (
  request_id    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  user_id       TEXT,
  channel_id    TEXT,
  provider      TEXT,
  model         TEXT,
  spans         TEXT NOT NULL,                  -- JSON
  metrics       TEXT NOT NULL,                  -- JSON
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry(created_at);

-- Служебная таблица версий миграций
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  applied_at    INTEGER NOT NULL
);
