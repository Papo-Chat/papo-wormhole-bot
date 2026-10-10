import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import type { Config } from '../src/config.js';

const cfg: Config = {
	papo: {
		baseUrl: 'http://localhost',
		wsUrl: 'ws://localhost/ws',
		username: 'u',
		password: 'p',
		refreshHours: 12,
		backfillOnStart: false,
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
		maxAttempts: 5,
		backoffBaseMs: 20,
		backoffMaxMs: 60
	}
};

interface EmbedSnapshot {
	description?: string;
	footer?: { text: string };
}

interface FakeDiscord {
	edits: { messageId: string; embeds?: EmbedSnapshot[] }[];
	reacts: { messageId: string; emoji: string }[];
	isSelf: (id?: string | null) => boolean;
	edit: (channelId: string, messageId: string, options: unknown) => Promise<void>;
	react: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	unreact: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	findGuildEmoji: (name: string) => { id: string; name: string; animated: boolean } | undefined;
	guildsCached: () => boolean;
	loadUnavailableEmojis: () => Promise<number>;
}

const fakeDiscord = (): FakeDiscord => {
	const edits: FakeDiscord['edits'] = [];
	const reacts: FakeDiscord['reacts'] = [];
	return {
		edits,
		reacts,
		isSelf: () => false,
		edit: async (_c, messageId, options) =>
			void edits.push({ messageId, embeds: (options as { embeds?: EmbedSnapshot[] }).embeds }),
		react: async (_c, messageId, emoji) => void reacts.push({ messageId, emoji }),
		unreact: async () => {},
		findGuildEmoji: (name) => (name === '3doge' ? { id: '777', name: '3doge', animated: false } : undefined),
		guildsCached: () => true,
		loadUnavailableEmojis: async () => 0
	};
};

const fixture = (discord: FakeDiscord) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, {
		maxAttempts: cfg.bridge.maxAttempts,
		baseMs: cfg.bridge.backoffBaseMs,
		maxMs: cfg.bridge.backoffMaxMs
	});
	const papoEdits: EmbedSnapshot[][] = [];
	const api = {
		listAllEmojis: async () => [{ id: 'e1', name: '3doge' }],
		addReaction: async () => {},
		removeReaction: async () => {},
		editMessage: async (_id: string, _content: string, embeds?: EmbedSnapshot[]) => {
			papoEdits.push(embeds ?? []);
			return {};
		}
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const map = (direction: 'papo_to_discord' | 'discord_to_papo', papoId: string, discordId: string) =>
		store.mapMessage({
			link_id: link.id,
			direction,
			papo_message_id: papoId,
			discord_message_id: discordId,
			rendered: 'oi',
			bridge_embed: { description: 'oi', footer: { text: '🕒 18:09 · Papo' } },
			footer_base: '🕒 18:09 · Papo'
		});
	const settle = async (): Promise<void> => {
		await new Promise((r) => setTimeout(r, 40));
		const until = Date.now() + 1200;
		while (Date.now() < until && (outbox.counts().in_flight > 0 || outbox.counts().pending > 0)) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	return { store, outbox, bridge, link, map, papoEdits, settle };
};

describe('resumo de reações no description (emoji custom renderiza)', () => {
	it('reação custom do Papo vira token do guild na cópia Discord', async () => {
		const discord = fakeDiscord();
		const { bridge, map, settle } = fixture(discord);
		map('papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: 'e1', unicode: null, count: 2 });
		await settle();

		const embed = discord.edits.at(-1)?.embeds?.[0];
		expect(embed?.description).toContain('oi');
		expect(embed?.description).toContain('<:3doge:777> 2');
		// footer de embed do Discord mostra o texto cru: o resumo não pode estar lá
		expect(embed?.footer?.text).toBe('🕒 18:09 · Papo');
	});

	it('reação custom do Discord vira shortcode na cópia Papo', async () => {
		const discord = fakeDiscord();
		const { bridge, map, papoEdits, settle } = fixture(discord);
		map('discord_to_papo', 'pm2', '8888');

		await bridge.onDiscordReaction('8888', '111', '3doge', '777', false, true, 3);
		await settle();

		const embed = papoEdits.at(-1)?.[0];
		expect(embed?.description).toContain('oi');
		expect(embed?.description).toContain(':3doge: 3');
		// o footer do card do Papo é texto puro (`{footerText}` no EmbedCard)
		expect(embed?.footer?.text).toBe('🕒 18:09 · Papo');
	});

	it('sem reações o description fica só com o texto', async () => {
		const discord = fakeDiscord();
		const { bridge, map, settle } = fixture(discord);
		map('papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: 'e1', unicode: null, count: 0 });
		await settle();

		const embed = discord.edits.at(-1)?.embeds?.[0];
		expect(embed?.description).toBe('oi');
	});
});
