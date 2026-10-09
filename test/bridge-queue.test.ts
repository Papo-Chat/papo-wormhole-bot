import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
	papo: { baseUrl: 'http://localhost', wsUrl: 'ws://localhost/ws', username: 'u', password: 'p', refreshHours: 12, backfillOnStart: false, rateLimitRps: 0, rateBurst: 1 },
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

interface FakeDiscord {
	reacted: string[];
	unreacted: string[];
	pinned: boolean[];
	react: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	unreact: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	setPin: (channelId: string, messageId: string, pinned: boolean) => Promise<void>;
	guildsCached: () => boolean;
	findGuildEmoji: (name: string) => undefined;
	edit: () => Promise<void>;
}

const fakeDiscord = (guildsCached: boolean): FakeDiscord => {
	const reacted: string[] = [];
	const unreacted: string[] = [];
	const pinned: boolean[] = [];
	return {
		reacted,
		unreacted,
		pinned,
		guildsCached: () => guildsCached,
		findGuildEmoji: () => undefined,
		react: async (_c, _m, emoji) => void reacted.push(emoji),
		unreact: async (_c, _m, emoji) => void unreacted.push(emoji),
		setPin: async (_c, _m, isPinned) => void pinned.push(isPinned),
		edit: async () => undefined
	};
};

const fakeApi = (emojis: { id: string; name: string; format: 'PNG' }[]) => ({
	listAllEmojis: async () => emojis
});

const fixture = (discord: FakeDiscord, api = fakeApi([])) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: cfg.bridge.maxAttempts, baseMs: cfg.bridge.backoffBaseMs, maxMs: cfg.bridge.backoffMaxMs });
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	store.setChannelLinkFlag(link.id, 'bridge_pins', 1);
	const flush = (bridge as unknown as { flushDeferred: (s: 'papo' | 'discord', id: string, linkId: number) => void }).flushDeferred;
	return { store, outbox, bridge, link, flush: (s: 'papo' | 'discord', id: string) => flush.call(bridge, s, id, link.id) };
};

/** Espera o worker do link esvaziar (jobs transitórios voltam para a fila). */
const settle = async (outbox: Outbox, ms = 1200): Promise<void> => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (outbox.counts().in_flight === 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
};

const mapBridged = (store: Store, linkId: number, papoId: string, discordId: string) =>
	store.mapMessage({
		link_id: linkId,
		direction: 'papo_to_discord',
		papo_message_id: papoId,
		discord_message_id: discordId,
		rendered: 'oi',
		bridge_embed: { footer: { text: '🕒 · Papo' } },
		footer_base: '🕒 · Papo'
	});

describe('fila: eventos que chegam antes da mensagem', () => {
	it('adia a reação e a enfileira quando o mapeamento aparece', async () => {
		const discord = fakeDiscord(true);
		const { store, outbox, bridge, link, flush } = fixture(discord);

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: null, unicode: '👍', count: 2 });
		await settle(outbox);
		expect(outbox.pendingCount(link.id)).toBe(0);
		expect(discord.reacted).toEqual([]);

		mapBridged(store, link.id, 'pm1', '1111');
		flush('papo', 'pm1');
		await settle(outbox);

		expect(discord.reacted).toEqual(['👍']);
		expect(store.listReactions(link.id, 'papo', 'pm1')).toEqual([{ emoji: '👍', count: 2 }]);
		expect(outbox.list('done').some((r) => r.kind === 'reaction')).toBe(true);
	});

	it('adia o pino e o enfileira junto da mensagem', async () => {
		const discord = fakeDiscord(true);
		const { store, outbox, bridge, link, flush } = fixture(discord);

		bridge.onPapoEvent({ type: 'message_pin', message_id: 'pm2', is_pinned: true });
		await settle(outbox);
		expect(outbox.pendingCount(link.id)).toBe(0);

		mapBridged(store, link.id, 'pm2', '2222');
		flush('papo', 'pm2');
		await settle(outbox);
		expect(discord.pinned).toEqual([true]);
		expect(outbox.list('done').some((r) => r.kind === 'pin')).toBe(true);
	});
});

describe('fila: guild indisponível na hora da reação', () => {
	it('registra a contagem e devolve o job para a fila em vez de descartar', async () => {
		const discord = fakeDiscord(false); // guilds ainda sem emojis no cache
		const api = fakeApi([{ id: 'e1', name: 'papu', format: 'PNG' }]);
		const { store, outbox, bridge, link } = fixture(discord, api);
		mapBridged(store, link.id, 'pm1', '1111');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: 'e1', unicode: null, count: 1 });
		await settle(outbox);

		expect(discord.reacted).toEqual([]);
		expect(store.listReactions(link.id, 'papo', 'pm1')).toEqual([{ emoji: ':papu:', count: 1 }]);
		const reaction = outbox.list('pending').find((r) => r.kind === 'reaction');
		expect(reaction).toBeDefined();
		expect(reaction?.attempts).toBeGreaterThanOrEqual(1);
	});
});
