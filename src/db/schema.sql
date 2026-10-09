-- Papo Wormhole — schema SQLite (WAL)
-- IDs do Papo são UUID (text); IDs do Discord são snowflake (text).

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users_papo (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  nickname   TEXT,
  avatar_sha TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users_discord (
  id           TEXT PRIMARY KEY,
  username     TEXT,
  display_name TEXT,
  avatar_hash  TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_links (
  papo_user_id    TEXT NOT NULL REFERENCES users_papo(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES users_discord(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (papo_user_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS server_links (
  papo_server_id   TEXT PRIMARY KEY,
  discord_guild_id TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channel_links (
  id                 INTEGER PRIMARY KEY,
  papo_channel_id    TEXT NOT NULL UNIQUE,
  discord_channel_id TEXT NOT NULL,
  mode               TEXT NOT NULL DEFAULT 'both'
                     CHECK (mode IN ('both','to_discord','to_papo')),
  identity           TEXT NOT NULL DEFAULT 'embed'
                     CHECK (identity IN ('embed','webhook')),
  paused             INTEGER NOT NULL DEFAULT 0,
  bridge_attachments INTEGER NOT NULL DEFAULT 1,
  bridge_embeds      INTEGER NOT NULL DEFAULT 1,
  bridge_reactions   INTEGER NOT NULL DEFAULT 1,
  bridge_edits       INTEGER NOT NULL DEFAULT 1,
  bridge_deletes     INTEGER NOT NULL DEFAULT 1,
  bridge_pins        INTEGER NOT NULL DEFAULT 0,
  propagate_mentions INTEGER NOT NULL DEFAULT 0,
  color              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_channel_links_discord ON channel_links (discord_channel_id);

CREATE TABLE IF NOT EXISTS message_map (
  id                 INTEGER PRIMARY KEY,
  link_id            INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('papo_to_discord','discord_to_papo')),
  papo_message_id    TEXT,
  discord_message_id TEXT,
  chunk_index        INTEGER NOT NULL DEFAULT 0,
  chunk_total        INTEGER NOT NULL DEFAULT 1,
  content_sha        TEXT,
  -- snapshot do que foi enviado no destino: permite re-renderir o embed (ex.: resumo de reações)
  rendered           TEXT,
  bridge_embed       TEXT,
  footer_base        TEXT,
  deleted            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_map_papo
  ON message_map (papo_message_id, chunk_index) WHERE papo_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_map_discord
  ON message_map (discord_message_id, chunk_index) WHERE discord_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_map_link ON message_map (link_id, created_at);

-- Contagem de reações da mensagem de origem, no formato exibível do destino.
-- `emoji` é unicode (👍) ou o nome do custom (:nome:) — embed footer não renderiza emoji custom.
CREATE TABLE IF NOT EXISTS reaction_counts (
  link_id           INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  source            TEXT    NOT NULL CHECK (source IN ('papo','discord')),
  source_message_id TEXT    NOT NULL,
  emoji             TEXT    NOT NULL,
  count             INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (link_id, source, source_message_id, emoji)
);
CREATE INDEX IF NOT EXISTS ix_reactions_msg ON reaction_counts (link_id, source, source_message_id);

-- Eventos que chegaram antes da mensagem de origem estar bridgeada (reação/pino de
-- mensagem ainda na fila). Ficam aqui e são enfileirados quando o `message_map` aparece.
CREATE TABLE IF NOT EXISTS deferred_events (
  id                INTEGER PRIMARY KEY,
  source            TEXT    NOT NULL CHECK (source IN ('papo','discord')),
  source_message_id TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('reaction','edit','delete','pin')),
  payload           TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_deferred_msg ON deferred_events (source, source_message_id);

-- Reações que o próprio bridge aplicou no Papo. Serve para reconhecer o eco do
-- `react_update` que a nossa reação dispara (o evento do Papo não traz quem reagiu).
-- `emoji` é a identidade no Papo: `e:<emoji_id>` (custom) ou `u:<unicode>`.
CREATE TABLE IF NOT EXISTS self_reactions (
  link_id                INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  destination_message_id TEXT    NOT NULL,
  emoji                  TEXT    NOT NULL,
  applied_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (link_id, destination_message_id, emoji)
);

CREATE TABLE IF NOT EXISTS emoji_map (
  name             TEXT PRIMARY KEY,
  papo_emoji_id    TEXT,
  discord_emoji_id TEXT,
  discord_emoji_name TEXT,
  discord_animated INTEGER NOT NULL DEFAULT 0,
  image_sha        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_emoji_papo ON emoji_map (papo_emoji_id);
CREATE INDEX IF NOT EXISTS ix_emoji_discord ON emoji_map (discord_emoji_id);

CREATE TABLE IF NOT EXISTS media_cache (
  sha256     TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  mime       TEXT,
  size_bytes INTEGER,
  source     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS presence_cache (
  platform   TEXT NOT NULL CHECK (platform IN ('papo','discord')),
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, user_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id            INTEGER PRIMARY KEY,
  link_id       INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL CHECK (direction IN ('to_discord','to_papo')),
  kind          TEXT NOT NULL CHECK (kind IN ('message','edit','delete','reaction','pin')),
  payload       TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL UNIQUE,
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','in_flight','done','failed','dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  claimed_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  done_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_outbox_due ON outbox (link_id, state, next_retry_at, id);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  level   TEXT NOT NULL,
  event   TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log (ts DESC);
