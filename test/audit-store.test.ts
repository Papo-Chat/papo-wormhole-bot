import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA, migrate, openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const link = store.upsertChannelLink({ papo_channel_id: 'papo-1', discord_channel_id: '111' });
	return { db, store, linkId: link.id };
};

describe('P1.2: marca de eco de uso único', () => {
	it('consumir a marca uma vez não impede a próxima reação legítima', () => {
		const { store, linkId } = fixture();
		store.markSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: 'pepega_cy' });

		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: 'pepega_cy', withinSeconds: 60 })).toBe(true);
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: 'pepega_cy', withinSeconds: 60 })).toBe(false);
	});

	it('cada aplicação soma um eco esperado', () => {
		const { store, linkId } = fixture();
		store.markSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍' });
		store.markSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍' });
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(true);
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(true);
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(false);
	});

	it('a consulta simples não consome, mas enxerga só os ecos ainda esperados', () => {
		const { store, linkId } = fixture();
		store.markSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍' });
		expect(store.isSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(true);
		expect(store.isSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(true);
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(true);
		expect(store.isSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(false);
	});

	it('marcas de destinos diferentes não se confundem', () => {
		const { store, linkId } = fixture();
		store.markSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍' });
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm3', emoji: '👍', withinSeconds: 60 })).toBe(false);
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(true);
	});

	it('marca fora da janela não é consumida', () => {
		const { db, store, linkId } = fixture();
		store.markSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍' });
		db.prepare("UPDATE self_reactions SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 day')").run();
		expect(store.consumeSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(false);
	});

	it('marcas vencidas são removidas', () => {
		const { db, store, linkId } = fixture();
		store.markSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍' });
		db.prepare("UPDATE self_reactions SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now', '-1 day')").run();
		expect(store.pruneSelfReactions(60)).toBe(1);
		expect(store.isSelfReaction({ linkId, destinationMessageId: 'pm2', emoji: '👍', withinSeconds: 60 })).toBe(false);
	});
});

describe('P1.7: reação espelhada no destino', () => {
	it('registra, consulta e remove a marca por mensagem e emoji', () => {
		const { store, linkId } = fixture();
		expect(store.hasMirrorReaction({ linkId, side: 'discord', destinationMessageId: '9999', emoji: '👍' })).toBe(false);
		store.markMirrorReaction({ linkId, side: 'discord', destinationMessageId: '9999', emoji: '👍' });
		expect(store.hasMirrorReaction({ linkId, side: 'discord', destinationMessageId: '9999', emoji: '👍' })).toBe(true);
		store.clearMirrorReaction({ linkId, side: 'discord', destinationMessageId: '9999', emoji: '👍' });
		expect(store.hasMirrorReaction({ linkId, side: 'discord', destinationMessageId: '9999', emoji: '👍' })).toBe(false);
	});

	it('lados e emojis diferentes não se confundem', () => {
		const { store, linkId } = fixture();
		store.markMirrorReaction({ linkId, side: 'discord', destinationMessageId: '9999', emoji: '👍' });
		expect(store.hasMirrorReaction({ linkId, side: 'discord', destinationMessageId: '9999', emoji: '❤️' })).toBe(false);
		expect(store.hasMirrorReaction({ linkId, side: 'papo', destinationMessageId: '9999', emoji: '👍' })).toBe(false);
	});
});

describe('P1.3: tombstone de exclusão', () => {
	it('registra e consulta o tombstone por lado', () => {
		const { store } = fixture();
		expect(store.isTombstoned('papo', 'pm9')).toBe(false);
		store.tombstoneMessage('papo', 'pm9');
		expect(store.isTombstoned('papo', 'pm9')).toBe(true);
		// o outro lado é independente
		expect(store.isTombstoned('discord', 'pm9')).toBe(false);
	});

	it('tombstone repetido não duplica', () => {
		const { db, store } = fixture();
		store.tombstoneMessage('discord', '9999');
		store.tombstoneMessage('discord', '9999');
		expect(db.prepare('SELECT COUNT(*) AS n FROM message_tombstones').get()).toEqual({ n: 1 });
	});

	it('tombstone vencido é removido', () => {
		const { db, store } = fixture();
		store.tombstoneMessage('papo', 'pm9');
		db.prepare("UPDATE message_tombstones SET deleted_at = datetime('now', '-2 days')").run();
		expect(store.pruneTombstones(3600)).toBe(1);
		expect(store.isTombstoned('papo', 'pm9')).toBe(false);
	});
});

describe('P1.6: transação reutilizável', () => {
	it('erro dentro da transação desfaz tudo o que ela escreveu', () => {
		const { store } = fixture();
		const err = new Error('enqueue falhou');
		expect(() =>
			store.withTransaction(() => {
				store.deferEvent({ source: 'papo', sourceMessageId: 'pm1', kind: 'reaction', payload: { count: 1 } });
				throw err;
			})
		).toThrow(err);
		expect(store.peekDeferredEvents('papo', 'pm1')).toEqual([]);
	});

	it('commit da transação mais externa publica o que foi escrito', () => {
		const { store } = fixture();
		store.withTransaction(() => {
			store.deferEvent({ source: 'papo', sourceMessageId: 'pm1', kind: 'reaction', payload: { count: 1 } });
			store.withTransaction(() => {
				store.deferEvent({ source: 'papo', sourceMessageId: 'pm1', kind: 'pin', payload: { is_pinned: true } });
			});
		});
		expect(store.peekDeferredEvents('papo', 'pm1').map((e) => e.kind)).toEqual(['reaction', 'pin']);
	});

	it('erro na transação mais externa desfaz as aninhadas', () => {
		const { store } = fixture();
		expect(() =>
			store.withTransaction(() => {
				store.deferEvent({ source: 'papo', sourceMessageId: 'pm1', kind: 'reaction', payload: {} });
				store.withTransaction(() => {
					store.deferEvent({ source: 'papo', sourceMessageId: 'pm1', kind: 'pin', payload: {} });
				});
				throw new Error('falhou no fim');
			})
		).toThrow('falhou no fim');
		expect(store.peekDeferredEvents('papo', 'pm1')).toEqual([]);
	});

	it('transações sequenciais continuam funcionando', () => {
		const { store } = fixture();
		store.withTransaction(() => store.deferEvent({ source: 'papo', sourceMessageId: 'pm1', kind: 'reaction', payload: {} }));
		store.withTransaction(() => store.deferEvent({ source: 'papo', sourceMessageId: 'pm2', kind: 'reaction', payload: {} }));
		expect(store.takeDeferredEvents('papo', 'pm1')).toHaveLength(1);
		expect(store.takeDeferredEvents('papo', 'pm2')).toHaveLength(1);
	});
});

describe('P1.1: migração do outbox legado', () => {
	const legacyOutbox = `
CREATE TABLE outbox (
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
)`;

	const indexOrigins = (db: DatabaseSync) =>
		db
			.prepare('PRAGMA index_list(outbox)')
			.all()
			.map((row) => ({
				name: String(row.name),
				unique: Number(row.unique),
				origin: String((row as { origin?: string }).origin ?? '')
			}));

	/** Recria a tabela como era antes: UNIQUE inline, sem as colunas novas. */
	const asLegacy = (db: DatabaseSync) => {
		db.exec('DROP TABLE outbox');
		db.exec(legacyOutbox);
	};

	it('troca o UNIQUE inline da tabela legada pelo índice único parcial', () => {
		const db = openDb(':memory:');
		const store = new Store(db);
		store.upsertChannelLink({ papo_channel_id: 'papo-1', discord_channel_id: '111' });
		asLegacy(db);
		db.exec("INSERT INTO outbox (link_id, direction, kind, dedupe_key, payload) SELECT id, 'to_discord', 'message', 'k1', '{}' FROM channel_links");
		expect(indexOrigins(db).some((i) => i.origin === 'u')).toBe(true);

		migrate(db, SCHEMA);

		const indexes = indexOrigins(db);
		expect(indexes.some((i) => i.origin === 'u')).toBe(false);
		expect(indexes.some((i) => i.name === 'ux_outbox_dedupe_active')).toBe(true);
		expect(db.prepare('SELECT remote_attempts FROM outbox').get()).toEqual({ remote_attempts: 0 });
	});

	it('preserva os jobs e seus estados ao reconstruir a tabela', () => {
		const db = openDb(':memory:');
		const store = new Store(db);
		const link = store.upsertChannelLink({ papo_channel_id: 'papo-1', discord_channel_id: '111' });
		const outbox = new Outbox(db, { maxAttempts: 4, baseMs: 1000, maxMs: 30_000 });
		const done = outbox.enqueue({ linkId: link.id, direction: 'to_discord', kind: 'message', dedupeKey: 'k-done', payload: { a: 1 } })!;
		outbox.complete(outbox.claimNext(link.id)!.id);
		const pending = outbox.enqueue({ linkId: link.id, direction: 'to_papo', kind: 'edit', dedupeKey: 'k-pending', payload: { b: 2 } })!;

		asLegacy(db);
		const insert = db.prepare(
			'INSERT INTO outbox (id, link_id, direction, kind, payload, dedupe_key, state, attempts) VALUES (?,?,?,?,?,?,?,?)'
		);
		insert.run(done, link.id, 'to_discord', 'message', '{"a":1}', 'k-done', 'done', 1);
		insert.run(pending, link.id, 'to_papo', 'edit', '{"b":2}', 'k-pending', 'pending', 0);

		migrate(db, SCHEMA);

		const rows = db.prepare('SELECT id, dedupe_key, state, payload, attempts FROM outbox ORDER BY id').all();
		expect(rows).toEqual([
			{ id: done, dedupe_key: 'k-done', state: 'done', payload: '{"a":1}', attempts: 1 },
			{ id: pending, dedupe_key: 'k-pending', state: 'pending', payload: '{"b":2}', attempts: 0 }
		]);
	});

	it('depois da migração o mesmo dedupe_key ainda coalesce enquanto estiver ativo', () => {
		const db = openDb(':memory:');
		const store = new Store(db);
		const link = store.upsertChannelLink({ papo_channel_id: 'papo-1', discord_channel_id: '111' });
		asLegacy(db);
		migrate(db, SCHEMA);

		const outbox = new Outbox(db, { maxAttempts: 4, baseMs: 1000, maxMs: 30_000 });
		outbox.enqueue({ linkId: link.id, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: { count: 1 } });
		outbox.enqueue({ linkId: link.id, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: { count: 0 } });
		expect(outbox.counts().pending).toBe(1);
		expect(JSON.parse(outbox.list('pending')[0]!.payload).count).toBe(0);
	});

	it('migração é idempotente', () => {
		const db = openDb(':memory:');
		const store = new Store(db);
		const link = store.upsertChannelLink({ papo_channel_id: 'papo-1', discord_channel_id: '111' });
		const outbox = new Outbox(db, { maxAttempts: 4, baseMs: 1000, maxMs: 30_000 });
		outbox.enqueue({ linkId: link.id, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} });
		migrate(db, SCHEMA);
		migrate(db, SCHEMA);
		expect(outbox.counts().pending).toBe(1);
		expect(indexOrigins(db).some((i) => i.name === 'ux_outbox_dedupe_active')).toBe(true);
	});
});
