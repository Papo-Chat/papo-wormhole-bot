import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import type { Config } from '../src/config.js';
import type { PapoMessage } from '../src/papo/types.js';

const cfg: Config = {
	papo: {
		baseUrl: 'http://localhost',
		wsUrl: 'ws://localhost/ws',
		username: 'u',
		password: 'p',
		refreshHours: 12,
		backfillOnStart: true,
		rateLimitRps: 0,
		rateBurst: 1
	},
	discord: { token: 'token', maxFileBytes: 20_000_000, maxMessagesPer5s: 5 },
	bridge: {
		dataDir: ':memory:',
		dbPath: ':memory:',
		mediaPort: 0,
		timezone: 'UTC',
		emojiAutoImport: false,
		propagateMentions: false,
		maxAttempts: 10,
		backoffBaseMs: 50,
		backoffMaxMs: 100
	}
};

const msg = (id: string, created_at: string): PapoMessage => ({
	id,
	channel_id: 'chan-1',
	author_id: 'u1',
	content: `histórico ${id}`,
	created_at
});

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();

const fixture = (history: PapoMessage[]) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 3, baseMs: 50, maxMs: 100 });
	const calls: { since: string | undefined }[] = [];
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: `user-${id}` })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: `user-${id}`, nickname: null })),
		listAllMessages: async (_channelId: string, since?: string) => {
			calls.push({ since });
			return history.filter((m) => !since || m.created_at > since);
		},
		sendMessage: async () => msg('cópia', new Date().toISOString())
	};
	const discord = { guildsCached: () => true, findGuildEmoji: () => undefined, send: async () => ({ id: 'd1' }) };
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const backfill = async () => {
		await (bridge as unknown as { backfill: () => Promise<void> }).backfill.call(bridge);
		// o worker do link é assíncrono: espera os jobs consumidos antes de conferir
		const until = Date.now() + 800;
		while (Date.now() < until && (outbox.counts().in_flight > 0 || outbox.counts().pending > 0)) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	return { db, store, outbox, calls, backfill };
};

describe('backfill não reenvia histórico do canal', () => {
	it('o cursor nasce no instante do link e é o único `since` usado', async () => {
		const { store, outbox, calls, backfill } = fixture([msg('m1', hoursAgo(24))]);
		const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
		const cursor = store.getPapoCursor(link.id);

		expect(cursor).toBeDefined();
		await backfill();

		expect(calls.length).toBe(1);
		expect(calls[0]!.since).toBe(cursor);
		expect(outbox.counts().pending).toBe(0);
	});

	it('link sem cursor (criado antes desta regra) é semeado, não despejado', async () => {
		const { db, store, outbox, calls, backfill } = fixture([msg('m1', hoursAgo(24))]);
		const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
		db.prepare('DELETE FROM meta WHERE key = ?').run(`papo_cursor:${link.id}`);
		expect(store.getPapoCursor(link.id)).toBeUndefined();

		await backfill();

		expect(calls[0]!.since).toBe(store.getPapoCursor(link.id));
		expect(outbox.counts().pending).toBe(0);
	});

	it('recupera só o que chegou depois do cursor', async () => {
		const missed = msg('m2', new Date(Date.now() + 1000).toISOString());
		const { store, outbox, backfill } = fixture([missed]);
		const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });

		await backfill();

		expect(outbox.list('done').filter((r) => r.kind === 'message').length).toBe(1);
		expect(store.getPapoCursor(link.id)).toBe(missed.created_at);
	});
});
