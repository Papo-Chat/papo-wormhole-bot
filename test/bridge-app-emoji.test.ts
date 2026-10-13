import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { settleQueue } from './helpers/settle.js';
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
/** PNG 1×1 válido: a imagem que o bridge sobe como emoji da aplicação. */
const TINY_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
).toString('base64');

interface EmojiLike {
	id: string;
	animated?: boolean;
}

interface Sent {
	embeds?: { description?: string }[];
}

const fixture = (
	opts: {
		/** emojis do guild por nome */
		guildEmojis?: Record<string, EmojiLike>;
		/** emojis que a aplicação já tem (cache carregado na conexão) */
		appEmojis?: Record<string, EmojiLike>;
		/** teto simulado de emojis da aplicação */
		appEmojiCount?: number;
		/** o que `GET /emojis` do Papo devolveria */
		papoEmojis?: { id: string; name: string; format?: 'PNG' | 'GIF'; image_blob?: string }[];
		/** true quando o Discord recusa a criação (limite do app, imagem rejeitada) */
		createFails?: boolean;
	} = {}
) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
	const sends: Sent[] = [];
	const edits: { messageId: string; embeds?: { description?: string }[] }[] = [];
	const reacts: { messageId: string; emoji: string }[] = [];
	/** tentativas de criação, com os bytes que subiram */
	const createAttempts: { name: string; bytes: number }[] = [];
	const application = new Map(Object.entries(opts.appEmojis ?? {}));

	const api = {
		listAllEmojis: async () => opts.papoEmojis ?? [],
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga', nickname: 'Jenga' })),
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga', nickname: 'Jenga' }))
	};
	const discord = {
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: (name: string) => {
			const e = (opts.guildEmojis ?? {})[name];
			return e ? { id: e.id, name, animated: Boolean(e.animated) } : undefined;
		},
		findApplicationEmoji: (name: string) => {
			const e = application.get(name);
			return e ? { id: e.id, name, animated: Boolean(e.animated) } : undefined;
		},
		applicationEmojiCount: () => opts.appEmojiCount ?? application.size,
		loadApplicationEmojis: async () => application.size,
		createApplicationEmoji: async (name: string, image: Buffer) => {
			createAttempts.push({ name, bytes: image.length });
			if (opts.createFails) return undefined;
			const created = { id: `app-${name}`, name, animated: false };
			application.set(name, created);
			return created;
		},
		send: async (_channelId: string, options: Sent) => {
			sends.push(options);
			return { id: 'd1' };
		},
		edit: async (_channelId: string, messageId: string, options: { embeds?: { description?: string }[] }) =>
			void edits.push({ messageId, embeds: options.embeds }),
		react: async (_channelId: string, messageId: string, emoji: string) => void reacts.push({ messageId, emoji })
	};

	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const map = (papoId: string, discordId: string) =>
		store.mapMessage({
			link_id: link.id,
			direction: 'papo_to_discord',
			papo_message_id: papoId,
			discord_message_id: discordId,
			rendered: 'oi',
			bridge_embed: { description: 'oi', footer: { text: '🕒 18:09 · Papo' } },
			footer_base: '🕒 18:09 · Papo'
		});
	const settle = async (): Promise<void> => {
		await settleQueue(outbox);
	};
	return { store, bridge, link, map, sends, edits, reacts, createAttempts, settle };
};

const papoMessage = (id: string, content: string) => ({
	type: 'message',
	id,
	channel_id: 'chan-1',
	author_id: PAPO_USER,
	content,
	created_at: '2026-10-09T18:09:00Z',
	attachments: []
});

const descriptionOf = (embeds?: { description?: string }[]): string => embeds?.[0]?.description ?? '';

describe('emoji custom sem equivalente no guild: emoji da aplicação', () => {
	it('usa o emoji da aplicação quando o guild não tem o nome', async () => {
		const { bridge, sends, createAttempts, settle } = fixture({
			appEmojis: { pepega: { id: '900' } },
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :pepega:') as never);
		await settle();

		expect(descriptionOf(sends[0]?.embeds)).toBe('oi <:pepega:900>');
		expect(createAttempts).toHaveLength(0);
	});

	it('o emoji do guild tem prioridade sobre o da aplicação', async () => {
		const { bridge, sends, settle } = fixture({
			guildEmojis: { pepega: { id: '777' } },
			appEmojis: { pepega: { id: '900' } },
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :pepega:') as never);
		await settle();

		expect(descriptionOf(sends[0]?.embeds)).toBe('oi <:pepega:777>');
	});

	it('sem equivalente em lugar nenhum: cria o emoji da aplicação e já usa na primeira mensagem', async () => {
		const { bridge, store, sends, createAttempts, settle } = fixture({
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :pepega:') as never);
		await settle();

		expect(createAttempts).toHaveLength(1);
		expect(createAttempts[0]!.name).toBe('pepega');
		// sobem os bytes decodificados da imagem, não o base64
		expect(createAttempts[0]!.bytes).toBe(Buffer.from(TINY_PNG, 'base64').length);
		expect(descriptionOf(sends[0]?.embeds)).toBe('oi <:pepega:app-pepega>');

		const row = store.getEmojiByName('pepega');
		expect(row?.discord_emoji_id).toBe('app-pepega');
		expect(row?.discord_application).toBe(1);
	});

	it('criação deduplicada: duas mensagens com o mesmo emoji novo criam um só', async () => {
		const { bridge, sends, createAttempts, settle } = fixture({
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :pepega:') as never);
		bridge.onPapoEvent(papoMessage('pm2', ':pepega: de novo') as never);
		await settle();

		expect(createAttempts).toHaveLength(1);
		expect(descriptionOf(sends[0]?.embeds)).toBe('oi <:pepega:app-pepega>');
		expect(descriptionOf(sends[1]?.embeds)).toBe('<:pepega:app-pepega> de novo');
	});

	it('sem a imagem do emoji no Papo não cria: o texto segue com :nome:', async () => {
		const { bridge, sends, createAttempts, settle } = fixture({
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG' }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :pepega:') as never);
		await settle();

		expect(createAttempts).toHaveLength(0);
		expect(descriptionOf(sends[0]?.embeds)).toBe('oi :pepega:');
	});

	it('nome que o Discord não aceita (1 caractere) não é criado', async () => {
		const { bridge, sends, createAttempts, settle } = fixture({
			papoEmojis: [{ id: 'e1', name: 'x', format: 'PNG', image_blob: TINY_PNG }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :x:') as never);
		await settle();

		expect(createAttempts).toHaveLength(0);
		expect(descriptionOf(sends[0]?.embeds)).toBe('oi :x:');
	});

	it('nome não criável não congela a criação dos outros emojis', async () => {
		const { bridge, sends, createAttempts, settle } = fixture({
			papoEmojis: [
				{ id: 'e1', name: 'x', format: 'PNG', image_blob: TINY_PNG },
				{ id: 'e2', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }
			]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :x: e :pepega:') as never);
		await settle();

		expect(createAttempts.map((c) => c.name)).toEqual(['pepega']);
		expect(descriptionOf(sends[0]?.embeds)).toBe('oi :x: e <:pepega:app-pepega>');
	});

	it('aplicação no teto de emojis não é insistida: o texto segue com :nome:', async () => {
		const { bridge, sends, createAttempts, settle } = fixture({
			appEmojiCount: 2000,
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :pepega:') as never);
		await settle();

		expect(createAttempts).toHaveLength(0);
		expect(descriptionOf(sends[0]?.embeds)).toBe('oi :pepega:');
	});

	it('criação recusada não derruba a ponte e não é insistida na mensagem seguinte', async () => {
		const { bridge, sends, createAttempts, settle } = fixture({
			createFails: true,
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }]
		});

		bridge.onPapoEvent(papoMessage('pm1', 'oi :pepega:') as never);
		await settle();
		bridge.onPapoEvent(papoMessage('pm2', 'outra :pepega:') as never);
		await settle();

		expect(createAttempts).toHaveLength(1);
		expect(descriptionOf(sends[0]?.embeds)).toBe('oi :pepega:');
		expect(descriptionOf(sends[1]?.embeds)).toBe('outra :pepega:');
	});

	it('resumo de reações no Discord também usa o emoji da aplicação', async () => {
		const { bridge, map, edits, settle } = fixture({
			appEmojis: { pepega: { id: '900' } },
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG' }]
		});
		map('pm1', '9999');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: 'e1', unicode: null, count: 2 } as never);
		await settle();

		expect(edits.at(-1)?.embeds?.[0]?.description).toContain('<:pepega:900> 2');
	});

	it('reação do Papo sem equivalente no guild reage com o emoji da aplicação', async () => {
		const { bridge, map, reacts, createAttempts, settle } = fixture({
			papoEmojis: [{ id: 'e1', name: 'pepega', format: 'PNG', image_blob: TINY_PNG }]
		});
		map('pm1', '9999');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: 'e1', unicode: null, count: 1 } as never);
		await settle();

		expect(createAttempts).toHaveLength(1);
		expect(reacts).toEqual([{ messageId: '9999', emoji: '<:pepega:app-pepega>' }]);
	});
});
