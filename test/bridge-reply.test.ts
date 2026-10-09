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

const PAPO_USER = '68c858a1-8d68-44d1-b7a5-05d95089fb97';

interface DiscordSend {
	replyTo?: string;
	embeds?: { description?: string }[];
}

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
	const sends: DiscordSend[] = [];
	const papoSent: { replyTo?: string }[] = [];
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga', nickname: 'Jenga' })),
		sendMessage: async (input: { replyTo?: string }) => {
			papoSent.push(input);
			return { id: 'pm-new', channel_id: 'chan-1', author_id: 'bot', content: null, created_at: new Date().toISOString() };
		}
	};
	const discord = {
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		channelName: () => 'geral',
		send: async (_channelId: string, options: DiscordSend) => {
			sends.push(options);
			return { id: 'd-new' };
		}
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	store.upsertPapoUser({ id: PAPO_USER, username: 'jenga', nickname: 'Jenga' });
	const map = (papoId: string, discordId: string) =>
		store.mapMessage({
			link_id: link.id,
			direction: 'discord_to_papo',
			papo_message_id: papoId,
			discord_message_id: discordId,
			rendered: 'original',
			footer_base: '🕒 · Discord'
		});
	const settle = async (): Promise<void> => {
		// `onPapoEvent` é fire-and-forget: dá tempo do job entrar na fila antes de esvaziar.
		await new Promise((r) => setTimeout(r, 60));
		const until = Date.now() + 1200;
		while (Date.now() < until && (outbox.counts().in_flight > 0 || outbox.counts().pending > 0)) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	return { store, outbox, bridge, link, sends, papoSent, map, settle };
};

const papoMessage = (id: string, replyTo?: string) => ({
	type: 'message',
	id,
	channel_id: 'chan-1',
	author_id: PAPO_USER,
	content: 'resposta',
	created_at: '2026-10-09T18:09:00Z',
	attachments: [],
	...(replyTo ? { reply_to: replyTo } : {})
});

const discordMessage = (id: string, reference?: string) => ({
	id,
	channelId: '111',
	channel: { isThread: () => false },
	author: {
		id: 'user-1',
		username: 'jenga',
		displayName: 'Jenga',
		avatar: 'hash',
		displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-1/hash.png'
	},
	member: { displayName: 'Jenga' },
	content: 'resposta',
	createdAt: new Date(),
	attachments: [],
	embeds: [],
	...(reference ? { reference: { messageId: reference } } : {})
});

describe('reply propaga pela cópia mapeada', () => {
	it('resposta do Papo responde a cópia Discord da mensagem respondida', async () => {
		const { bridge, sends, map, settle } = fixture();
		map('pm-ref', 'd-ref');

		bridge.onPapoEvent(papoMessage('pm-1', 'pm-ref') as never);
		await settle();

		expect(sends[0]?.replyTo).toBe('d-ref');
	});

	it('resposta do Discord responde a cópia Papo da mensagem respondida', async () => {
		const { bridge, papoSent, map, settle } = fixture();
		map('p-ref', 'd-ref');

		await bridge.onDiscordMessage(discordMessage('dm-1', 'd-ref') as never);
		await settle();

		expect(papoSent[0]?.replyTo).toBe('p-ref');
	});

	it('sem cópia mapeada a mensagem vai sem reply', async () => {
		const { bridge, sends, papoSent, settle } = fixture();

		bridge.onPapoEvent(papoMessage('pm-2', 'pm-desconhecida') as never);
		await bridge.onDiscordMessage(discordMessage('dm-2', 'd-desconhecida') as never);
		await settle();

		expect(sends[0]?.replyTo).toBeUndefined();
		expect(papoSent[0]?.replyTo).toBeUndefined();
	});

	it('reply para cópia apagada não é usado', async () => {
		const { store, bridge, sends, map, settle } = fixture();
		map('pm-ref', 'd-ref');
		store.markMapDeleted('pm-ref', 'd-ref');

		bridge.onPapoEvent(papoMessage('pm-3', 'pm-ref') as never);
		await settle();

		expect(sends[0]?.replyTo).toBeUndefined();
	});
});
