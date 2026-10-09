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
	const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
	db.exec(schema);
	migrate(db);
	return db;
}

/** Adições de coluna idempotentes (SQLite não tem ADD COLUMN IF NOT EXISTS). */
function migrate(db: DatabaseSync): void {
	const additions: [string, string][] = [
		['message_map', 'rendered TEXT'],
		['message_map', 'bridge_embed TEXT'],
		['message_map', 'footer_base TEXT']
	];
	for (const [table, column] of additions) {
		try {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
		} catch (err) {
			if (!/duplicate column name/i.test((err as Error).message)) throw err;
		}
	}
}

export type Db = DatabaseSync;

export function nowIso(): string {
	return new Date().toISOString();
}

/** `rows` tipa o resultado de db.prepare().all() (node:sqlite retorna null-prototype objects). */
export function rows<T>(values: unknown[]): T[] {
	return values as T[];
}
