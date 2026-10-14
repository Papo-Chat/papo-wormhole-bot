import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { settleQueue } from './helpers/settle.js';
import type { Config } from '../src/config.js';

/**
 * Feature: thread do Discord linkada a um canal do Papo. O Papo não tem thread, então a thread
 * é tratada como canal comum — cada thread precisa do seu canal do Papo.
 */

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

const PARENT = '111';
const THREAD = '333';

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u', nickname: null })),
		sent: [] as { channelId: string; content?: string | null }[],
		sendMessage: async (input: { channelId: string }) => {
			api.sent.push({ channelId: input.channelId });
			return { id: `pm${api.sent.length}`, channel_id: input.channelId, author_id: 'bot', content: null, created_at: new Date().toISOString() };
		},
		editMessage: async () => undefined
	};
	const joined: string[] = [];
	const discord = {
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		channelName: (id: string) => (id === THREAD ? 'conversa' : 'geral'),
		messageLink: (channelId: string, messageId: string) => `https://discord.com/channels/999/${channelId}/${messageId}`,
		ensureThreadMembership: async (channelId: string) => {
			joined.push(channelId);
			return channelId === THREAD;
		},
		send: async (_channelId: string, _options: unknown) => ({ id: 'd-new' }),
		edit: async () => {},
		delete: async () => {},
		react: async () => {},
		unreact: async () => {},
		fetchMessage: async () => undefined,
		recentByAuthor: async () => []
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, { close: () => {}, connect: () => {} } as never, discord as never, {
		save: () => ({ sha256: 'x', ext: 'png' }),
		urlFor: () => undefined,
		readFor: () => undefined,
		extFor: () => 'png',
		sniffImage: () => null
	} as never);
	const parent = store.upsertChannelLink({ papo_channel_id: 'chan-parent', discord_channel_id: PARENT });
	const thread = store.upsertChannelLink({ papo_channel_id: 'chan-thread', discord_channel_id: THREAD });
	const settle = () => settleQueue(outbox);
	return { store, outbox, bridge, parent, thread, api, discord, joined, settle };
};

const discordMessage = (id: string, channelId: string) =>
	({
		id,
		channelId,
		author: { id: 'user-1', username: 'jenga', displayName: 'Jenga', displayAvatarURL: () => 'https://cdn.example.com/a.png' },
		member: { displayName: 'Jenga' },
		content: 'oi da thread',
		createdAt: new Date(),
		attachments: [],
		embeds: []
	}) as never;

describe('thread do Discord linkada a um canal do Papo', () => {
	it('mensagem da thread entra no canal do Papo linkado', async () => {
		const { bridge, api, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1', THREAD));
		await settle();

		expect(api.sent).toHaveLength(1);
		expect(api.sent[0]!.channelId).toBe('chan-thread');
	});

	it('thread sem link próprio não é bridgeada, mesmo filha de um canal linkado', async () => {
		const { bridge, api, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1', '444'));
		await settle();

		expect(api.sent).toHaveLength(0);
	});

	it('o drain garante que o bot é membro da thread linkada', async () => {
		const { bridge, joined, settle } = fixture();

		await bridge.drain();
		await settle();

		expect(joined).toContain(THREAD);
		// conferido uma vez por processo: join é chamada REST
		await bridge.drain();
		expect(joined.filter((id) => id === THREAD)).toHaveLength(1);
	});

	it('thread recém-criada que já está linkada: o bridge entra nela', async () => {
		const { bridge, joined } = fixture();

		await bridge.onDiscordThreadCreate(THREAD, PARENT, 'conversa');

		expect(joined).toEqual([THREAD]);
	});

	it('thread recém-criada sem link não recebe o bridge', async () => {
		const { bridge, joined } = fixture();

		await bridge.onDiscordThreadCreate('555', PARENT, 'outra');

		expect(joined).toEqual([]);
	});

	it('thread linkada arquivada fica registrada na auditoria', async () => {
		const { store, bridge } = fixture();

		bridge.onDiscordThreadUpdate(THREAD, PARENT, 'conversa', true);

		const audit = store.recentAudit(5).find((r) => r.event === 'thread-linkada-arquivada');
		expect(audit?.payload).toContain(THREAD);
	});

	it('thread reaberta não gera registro', async () => {
		const { store, bridge } = fixture();

		bridge.onDiscordThreadUpdate(THREAD, PARENT, 'conversa', false);

		expect(store.recentAudit(5).some((r) => r.event === 'thread-linkada-arquivada')).toBe(false);
	});
});
