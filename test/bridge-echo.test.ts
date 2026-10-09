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

const BOT_ID = 'bot-1';

interface FakeDiscord {
	edits: { messageId: string; embeds?: unknown }[];
	deletes: string[];
	reacts: { messageId: string; emoji: string }[];
	isSelf: (id?: string | null) => boolean;
	fetchMessage: (channelId: string, messageId: string) => Promise<unknown>;
	edit: (channelId: string, messageId: string, options: unknown) => Promise<void>;
	delete: (channelId: string, messageId: string) => Promise<void>;
	react: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	unreact: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	loadUnavailableEmojis: () => Promise<number>;
	guildsCached: () => boolean;
	findGuildEmoji: () => { id: string; name: string; animated: boolean } | undefined;
}

const fakeDiscord = (): FakeDiscord => {
	const edits: { messageId: string; embeds?: unknown }[] = [];
	const deletes: string[] = [];
	const reacts: { messageId: string; emoji: string }[] = [];
	return {
		edits,
		deletes,
		reacts,
		isSelf: (id) => id === BOT_ID,
		fetchMessage: async (_c, id) => ({ id, channelId: '111', author: { id: 'user-1' }, content: 'texto' }),
		edit: async (_c, messageId, options) => void edits.push({ messageId, embeds: (options as { embeds?: unknown }).embeds }),
		delete: async (_c, messageId) => void deletes.push(messageId),
		react: async (_c, messageId, emoji) => void reacts.push({ messageId, emoji }),
		unreact: async () => {},
		loadUnavailableEmojis: async () => 0,
		guildsCached: () => true,
		findGuildEmoji: () => undefined
	};
};

const fixture = (discord: FakeDiscord, opts: { papoEmojis?: { id: string; name: string }[] } = {}) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: cfg.bridge.maxAttempts, baseMs: cfg.bridge.backoffBaseMs, maxMs: cfg.bridge.backoffMaxMs });
	const edits: string[] = [];
	const deletes: string[] = [];
	const api = {
		listAllEmojis: async () => opts.papoEmojis ?? [],
		editMessage: async (id: string) => void edits.push(id),
		deleteMessage: async (id: string) => void deletes.push(id),
		addReaction: async () => {},
		removeReaction: async () => {}
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const settle = async (): Promise<void> => {
		const until = Date.now() + 1200;
		while (Date.now() < until) {
			if (outbox.counts().in_flight === 0 && outbox.counts().pending === 0) return;
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	return { store, outbox, bridge, link, edits, deletes, settle };
};

const discordMessage = (id: string, authorId: string, content = 'editado') => ({
	id,
	channelId: '111',
	partial: false,
	author: { id: authorId },
	content,
	createdTimestamp: Date.now(),
	editedTimestamp: Date.now(),
	attachments: [],
	embeds: []
});

const map = (store: Store, linkId: number, direction: 'papo_to_discord' | 'discord_to_papo', papoId: string, discordId: string) =>
	store.mapMessage({
		link_id: linkId,
		direction,
		papo_message_id: papoId,
		discord_message_id: discordId,
		rendered: 'oi',
		bridge_embed: { footer: { text: '🕒 · Papo' } },
		footer_base: '🕒 · Papo'
	});

describe('eco do Discord não reescreve o Papo', () => {
	it('edição de cópia Discord de mensagem do Papo não edita a mensagem original', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, edits, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		await bridge.onDiscordEdit(undefined as never, discordMessage('9999', 'user-1') as never);
		await settle();

		expect(edits).toEqual([]);
		expect(outbox.list('pending').filter((r) => r.kind === 'edit')).toEqual([]);
	});

	it('edição de mensagem que o bot criou no Papo continua propagando', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, edits, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		await bridge.onDiscordEdit(undefined as never, discordMessage('8888', 'user-1') as never);
		await settle();

		expect(edits).toEqual(['pm2']);
		expect(outbox.list('pending').filter((r) => r.kind === 'edit')).toEqual([]);
	});

	it('eco de edição do próprio embed não gera job', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		await bridge.onDiscordEdit(undefined as never, discordMessage('9999', BOT_ID) as never);
		await settle();

		expect(outbox.list('pending').filter((r) => r.kind === 'edit')).toEqual([]);
		expect(outbox.list('done').filter((r) => r.kind === 'edit')).toEqual([]);
	});

	it('deleção da cópia Discord não apaga a mensagem do Papo', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, deletes, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		await bridge.onDiscordDelete(discordMessage('9999', 'user-1') as never);
		await settle();

		expect(deletes).toEqual([]);
	});

	it('eco de deleção do próprio embed não gera job', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		await bridge.onDiscordDelete(discordMessage('9999', BOT_ID) as never);
		await settle();

		expect(outbox.list('pending').filter((r) => r.kind === 'delete')).toEqual([]);
		expect(outbox.list('done').filter((r) => r.kind === 'delete')).toEqual([]);
	});
});

describe('eco do Papo não reescreve o Discord', () => {
	it('edição da cópia do bot no Papo não edita a mensagem do Discord', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		bridge.onPapoEvent({
			type: 'message_edit',
			id: 'pm2',
			channel_id: 'chan-1',
			content: 'teste',
			edited_at: '2026-10-09T18:09:00Z'
		} as never);
		await settle();

		expect(discord.edits).toEqual([]);
		expect(outbox.list('pending').filter((r) => r.kind === 'edit')).toEqual([]);
		expect(outbox.list('done').filter((r) => r.kind === 'edit')).toEqual([]);
	});

	it('embeds reescritos na cópia do Papo não são empurrados ao Discord', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		bridge.onPapoEvent({
			type: 'message_embeds_update',
			channel_id: 'chan-1',
			message_id: 'pm2',
			embeds: [{ description: 'teste', color: '#5865F2' }]
		} as never);
		await settle();

		expect(discord.edits).toEqual([]);
		expect(outbox.list('done').filter((r) => r.kind === 'edit')).toEqual([]);
	});

	it('deleção da cópia do Papo não apaga a mensagem original do Discord', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		bridge.onPapoEvent({ type: 'message_delete', id: 'pm2', channel_id: 'chan-1' } as never);
		await settle();

		expect(discord.deletes).toEqual([]);
		expect(store.findMapByPapo('pm2')[0]?.deleted).toBe(1);
		expect(outbox.list('pending').filter((r) => r.kind === 'delete')).toEqual([]);
	});
});

describe('rodapé de reação só toca a cópia criada pelo bot', () => {
	it('reação do Papo reflete no Discord e atualiza o rodapé da cópia do Papo', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, edits, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm2', emoji_id: null, unicode: '👍', count: 1 } as never);
		await settle();

		// a reação entra na mensagem do Discord (reação é permitida em mensagem de terceiros),
		// mas o rodapé dela não pode ser reescrito: é do autor Discord.
		expect(discord.reacts).toEqual([{ messageId: '8888', emoji: '👍' }]);
		expect(discord.edits).toEqual([]);
		expect(edits).toEqual(['pm2']);
	});

	it('reação do Discord atualiza o rodapé da cópia Discord e não edita o original do Papo', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, edits, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		await bridge.onDiscordReaction('9999', '111', '👍', null, false, true, 1);
		await settle();

		expect(edits).toEqual([]);
		expect(discord.edits.map((e) => e.messageId)).toEqual(['9999']);
	});

	it('emoji que o Discord recusa (10014) não derruba o job de reação', async () => {
		const discord = fakeDiscord();
		discord.findGuildEmoji = () => ({ id: '777', name: '3doge', animated: false });
		discord.react = async () => {
			throw Object.assign(new Error('Unknown Emoji'), { code: 10014, status: 400 });
		};
		const { store, outbox, bridge, link, edits, settle } = fixture(discord, { papoEmojis: [{ id: 'e1', name: '3doge' }] });
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm2', emoji_id: 'e1', unicode: null, count: 1 } as never);
		await settle();

		// o Discord recusou o emoji: o job não morre, o resumo do rodapé é o destino
		expect(outbox.list('failed').filter((r) => r.kind === 'reaction')).toEqual([]);
		expect(outbox.list('dead').filter((r) => r.kind === 'reaction')).toEqual([]);
		expect(edits).toEqual(['pm2']);
	});
});
