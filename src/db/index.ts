import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Abre o SQLite (WAL) e aplica o schema idempotente. */
export function openDb(path: string): DatabaseSync {
	if (path !== ':memory:') {
		mkdirSync(dirname(path), { recursive: true });
	}
	const db = new DatabaseSync(path);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec('PRAGMA busy_timeout = 5000;');
	const schema = SCHEMA;
	db.exec(schema);
	migrate(db, schema);
	return db;
}

/** Schema aplicado em toda abertura de banco (idempotente). */
export const SCHEMA = readFileSync(join(HERE, 'schema.sql'), 'utf8');

/** Adições de coluna idempotentes (SQLite não tem ADD COLUMN IF NOT EXISTS). */
const COLUMN_ADDITIONS: [string, string][] = [
	['message_map', 'rendered TEXT'],
	['message_map', 'bridge_embed TEXT'],
	['message_map', 'footer_base TEXT'],
	['message_map', 'link_embeds TEXT'],
	['message_map', 'reply_note TEXT'],
	['message_map', 'edit_revision TEXT'],
	['message_map', 'embed_revision TEXT'],
	['message_map', 'webhook_copy INTEGER NOT NULL DEFAULT 0'],
	['self_reactions', 'pending_echoes INTEGER NOT NULL DEFAULT 1'],
	['emoji_map', 'discord_application INTEGER NOT NULL DEFAULT 0'],
	['outbox', 'revision TEXT'],
	['outbox', 'remote_attempts INTEGER NOT NULL DEFAULT 0']
];

function addColumns(db: Db): void {
	for (const [table, column] of COLUMN_ADDITIONS) {
		try {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
		} catch (err) {
			if (!/duplicate column name/i.test((err as Error).message)) throw err;
		}
	}
}

/**
 * `dedupe_key` já foi `UNIQUE` permanente: jobs `done` continuavam ocupando a chave e
 * descartavam transições legítimas de estado (reação `1→0→1`, pin `true→false→true`).
 * A constraint inline não some com `CREATE TABLE IF NOT EXISTS`, então o table é
 * reconstruído uma vez e a unicidade passa a valer só para jobs vivos.
 */
function rebuildOutboxDedupe(db: Db): boolean {
	const indexes = rows<{ name: string; origin: string }>(db.prepare('PRAGMA index_list(outbox)').all());
	const legacy = indexes.find((i) => i.origin === 'u' && i.name !== 'ux_outbox_dedupe_active');
	if (!legacy) return false;

	const columns = rows<{ name: string }>(db.prepare('PRAGMA table_info(outbox)').all()).map((c) => c.name);
	const wanted = [
		'id',
		'link_id',
		'direction',
		'kind',
		'payload',
		'dedupe_key',
		'state',
		'attempts',
		'last_error',
		'next_retry_at',
		'claimed_at',
		'created_at',
		'done_at'
	];
	const select = wanted.map((c) => (columns.includes(c) ? c : 'NULL')).join(', ');

	db.exec('BEGIN IMMEDIATE');
	try {
		db.exec(`CREATE TABLE outbox_rebuilt (
			id              INTEGER PRIMARY KEY,
			link_id         INTEGER NOT NULL REFERENCES channel_links(id) ON DELETE CASCADE,
			direction       TEXT NOT NULL CHECK (direction IN ('to_discord','to_papo')),
			kind            TEXT NOT NULL CHECK (kind IN ('message','edit','delete','reaction','pin')),
			payload         TEXT NOT NULL,
			dedupe_key      TEXT NOT NULL,
			revision        TEXT,
			remote_attempts INTEGER NOT NULL DEFAULT 0,
			state           TEXT NOT NULL DEFAULT 'pending'
			                CHECK (state IN ('pending','in_flight','done','failed','dead')),
			attempts        INTEGER NOT NULL DEFAULT 0,
			last_error      TEXT,
			next_retry_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
			claimed_at      TEXT,
			created_at      TEXT NOT NULL DEFAULT (datetime('now')),
			done_at         TEXT
		)`);
		db.exec(`INSERT INTO outbox_rebuilt (id, link_id, direction, kind, payload, dedupe_key, state, attempts, last_error, next_retry_at, claimed_at, created_at, done_at)
		 SELECT ${select} FROM outbox`);
		db.exec('DROP TABLE outbox');
		db.exec('ALTER TABLE outbox_rebuilt RENAME TO outbox');
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	return true;
}

/**
 * `deferred_events.kind` já não aceitou `embeds`: o CHECK inline não muda com
 * `CREATE TABLE IF NOT EXISTS`, então o table é reconstruído uma vez. O conteúdo é
 * efêmero (eventos adiados são descartados por idade), por isso a reconstrução é barata.
 */
function rebuildDeferredKinds(db: Db): boolean {
	const ddl = rows<{ sql: string | null }>(
		db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deferred_events'`).all()
	)[0]?.sql;
	if (!ddl || ddl.includes("'embeds'")) return false;

	db.exec('BEGIN IMMEDIATE');
	try {
		db.exec(`CREATE TABLE deferred_events_rebuilt (
			id                INTEGER PRIMARY KEY,
			source            TEXT    NOT NULL CHECK (source IN ('papo','discord')),
			source_message_id TEXT    NOT NULL,
			kind              TEXT    NOT NULL CHECK (kind IN ('reaction','edit','delete','pin','embeds')),
			payload           TEXT    NOT NULL,
			created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
		)`);
		db.exec(
			`INSERT INTO deferred_events_rebuilt (id, source, source_message_id, kind, payload, created_at)
			 SELECT id, source, source_message_id, kind, payload, created_at FROM deferred_events`
		);
		db.exec('DROP TABLE deferred_events');
		db.exec('ALTER TABLE deferred_events_rebuilt RENAME TO deferred_events');
		db.exec('COMMIT');
	} catch (err) {
		db.exec('ROLLBACK');
		throw err;
	}
	db.exec('CREATE INDEX IF NOT EXISTS ix_deferred_msg ON deferred_events (source, source_message_id)');
	return true;
}

/** Correções de banco para bases criadas por versões anteriores. */
export function migrate(db: Db, schema: string = SCHEMA): void {
	addColumns(db);
	// o rebuild apaga os índices da tabela: recriar a partir do schema idempotente
	if (rebuildOutboxDedupe(db)) db.exec(schema);
	rebuildDeferredKinds(db);
}

export type Db = DatabaseSync;

export function nowIso(): string {
	return new Date().toISOString();
}

/** `rows` tipa o resultado de db.prepare().all() (node:sqlite retorna null-prototype objects). */
export function rows<T>(values: unknown[]): T[] {
	return values as T[];
}
