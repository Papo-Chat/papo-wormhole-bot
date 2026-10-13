import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { bridgeWebhookName } from '../src/discord/bridge.js';
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

// PNG mínimo reconhecido pelo sniffImage do fixture (magic bytes + corpo qualquer)
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('avatar-teste')]);

interface WebhookIdentity {
	userId: string;
	displayName: string;
	username: string;
	avatarSha?: string;
	avatarBuffer?: Buffer;
}

interface WebhookSend {
	content?: string;
	embeds?: { title?: string; url?: string; author?: { name?: string }; footer?: { text?: string } }[];
	files?: { name: string }[];
}

interface DiscordSend {
	embeds?: { author?: { name?: string } }[];
	replyTo?: string;
}

const fixture = (opts: {
	webhook?: boolean;
	/** webhook existe mas a criação retorna null (limite do canal, sem Manage Webhooks) */
	webhookUnavailable?: boolean;
	avatar?: boolean;
	/** primeira tentativa de envio pelo webhook falha com resultado certo (webhook morto); a segunda entrega */
	webhookFailsOnce?: boolean;
	isSelfMessage?: (m: { webhookId?: string | null }) => boolean;
} = {}) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
	const mediaFiles = new Map<string, { data: Buffer; ext: string }>();
	const media = {
		save: (data: Buffer, mime?: string | null) => {
			const sha256 = createHash('sha256').update(data).digest('hex');
			if (!mediaFiles.has(sha256)) mediaFiles.set(sha256, { data, ext: 'png' });
			return { sha256, ext: 'png' };
		},
		urlFor: (sha: string, base?: string) => (base ? `${base}/media/${sha}.png` : undefined),
		readFor: (sha: string) => mediaFiles.get(sha)?.data,
		extFor: (sha: string) => mediaFiles.get(sha)?.ext ?? 'bin',
		sniffImage: (buf: Buffer): { ext: string; mime: string } | null =>
			buf.length >= 8 && buf.subarray(0, 8).equals(PNG_BYTES.subarray(0, 8)) ? { ext: 'png', mime: 'image/png' } : null
	};
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga', nickname: 'Jenga' })),
		profilesBatch: async (ids: string[]) =>
			ids.map((id) => ({
				id,
				username: 'jenga',
				nickname: 'Jenga',
				...(opts.avatar !== false ? { avatar_blob: PNG_BYTES.toString('base64'), avatar_format: 'PNG' } : {})
			})),
		sendMessage: async () => ({
			id: 'pm-new',
			channel_id: 'chan-1',
			author_id: 'bot',
			content: null,
			created_at: new Date().toISOString()
		})
	};
	const webhookRequests: WebhookIdentity[] = [];
	const webhookSends: WebhookSend[] = [];
	const sends: DiscordSend[] = [];
	const papoSent: { replyTo?: string }[] = [];
	api.sendMessage = async () => {
		papoSent.push({});
		return { id: 'pm-new', channel_id: 'chan-1', author_id: 'bot', content: null, created_at: new Date().toISOString() };
	};
	const discord = {
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		channelName: () => 'geral',
		send: async (_channelId: string, options: DiscordSend) => {
			sends.push(options);
			return { id: 'd-new' };
		},
		...(opts.isSelfMessage ? { isSelfMessage: async (m: never) => opts.isSelfMessage!(m) } : {}),
		...(opts.webhook
			? {
					userWebhook: async (_channelId: string, identity: WebhookIdentity) => {
						webhookRequests.push(identity);
						return opts.webhookUnavailable ? null : { id: 'wh-1' };
					},
					sendAsWebhook: async (_channelId: string, _userId: string, options: WebhookSend) => {
						webhookSends.push(options);
						if (opts.webhookFailsOnce && webhookSends.length === 1) return null;
						return { id: 'w-1' };
					}
				}
			: {})
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, media as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const settle = () => settleQueue(outbox);
	/** Enfileira um job de envio direto (permite exercitar previews e reações sem passar pelo Papo). */
	const enqueueJob = (job: Record<string, unknown>) => {
		outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'message',
			dedupeKey: `papo:${job.papoMessageId}:to_discord:0`,
			payload: { job }
		});
	};
	const baseJob = (id: string, extra: Record<string, unknown> = {}) => ({
		kind: 'message',
		linkId: link.id,
		papoChannelId: 'chan-1',
		discordChannelId: '111',
		papoMessageId: id,
		chunkIndex: 0,
		chunkTotal: 1,
		description: 'olá',
		authorId: PAPO_USER,
		authorName: 'Jenga',
		timestamp: '2026-10-09T18:09:00Z',
		notes: [],
		sources: [],
		...extra
	});
	return { store, outbox, bridge, link, enqueueJob, baseJob, webhookRequests, webhookSends, sends, papoSent, settle };
};

const papoMessage = (id: string) => ({
	type: 'message',
	id,
	channel_id: 'chan-1',
	author_id: PAPO_USER,
	content: 'olá',
	created_at: '2026-10-09T18:09:00Z',
	attachments: []
});

const discordMessage = (id: string, webhookId?: string) => ({
	id,
	channelId: '111',
	channel: { isThread: () => false },
	author: {
		// mensagem de webhook tem author = webhook (não o bot nem o autor do Papo)
		id: webhookId ?? 'user-1',
		username: 'algum',
		displayName: 'Algum',
		displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/x/y.png'
	},
	...(webhookId ? { webhookId } : {}),
	member: { displayName: 'Algum' },
	content: 'oi',
	createdAt: new Date(),
	attachments: [],
	embeds: []
});

describe('nome do webhook por usuário', () => {
	it('apelido diferente do username compõe `nickname (@username)`', () => {
		expect(bridgeWebhookName('Jenga', 'jenga')).toBe('Jenga (@jenga)');
	});

	it('sem apelido usa só o username', () => {
		expect(bridgeWebhookName('jenga', 'jenga')).toBe('jenga');
	});

	it('capitalização própria do apelido compõe o nome', () => {
		expect(bridgeWebhookName('JENGA', 'jenga')).toBe('JENGA (@jenga)');
	});

	it('limita a 80 caracteres (limite de nome de webhook)', () => {
		expect(bridgeWebhookName('x'.repeat(100), 'jenga').length).toBeLessThanOrEqual(80);
	});
});

describe('envio via webhook do bridge', () => {
	it('mensagem sai pelo webhook com o conteúdo do Papo no content, sem cartão', async () => {
		const { store, bridge, webhookRequests, webhookSends, sends, settle } = fixture({ webhook: true });

		bridge.onPapoEvent(papoMessage('pm-1') as never);
		await settle();

		expect(sends).toHaveLength(0);
		expect(webhookRequests).toHaveLength(1);
		const identity = webhookRequests[0]!;
		expect(identity.userId).toBe(PAPO_USER);
		expect(identity.displayName).toBe('Jenga');
		expect(identity.username).toBe('jenga');
		expect(identity.avatarSha).toBeTruthy();
		expect(identity.avatarBuffer?.length).toBeGreaterThan(0);

		expect(webhookSends).toHaveLength(1);
		const sent = webhookSends[0]!;
		// content = conteúdo do Papo; o bridge não gera cartão nem rodapé
		expect(sent.content).toBe('olá');
		expect(sent.embeds ?? []).toHaveLength(0);
		// a identidade está no webhook: a mensagem não leva override de nick/avatar
		expect(sent).not.toHaveProperty('username');
		expect(sent).not.toHaveProperty('avatarUrl');
		// a cópia fica mapeada e marcada como cópia de webhook
		const map = store.findMapByDiscord('w-1')[0];
		expect(map?.webhook_copy).toBe(1);
		expect(map?.bridge_embed).toBeNull();
	});

	it('resumo de reações é anexado ao content (não há cartão)', async () => {
		const { store, bridge, link, enqueueJob, baseJob, webhookSends, settle } = fixture({ webhook: true });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm-r', emoji: '👍', count: 2 });
		enqueueJob(baseJob('pm-r'));
		await bridge.drain();
		await settle();

		expect(webhookSends).toHaveLength(1);
		expect(webhookSends[0]?.content).toBe('olá\n\n↳ 👍 2');
	});

	it('embeds que vêm do Papo são replicados como embeds da mensagem', async () => {
		const { bridge, link, enqueueJob, baseJob, webhookSends, settle } = fixture({ webhook: true });
		enqueueJob(
			baseJob('pm-pv', {
				linkEmbeds: [{ title: 'Post', url: 'https://example.com/post', description: 'preview do link' }]
			})
		);
		await bridge.drain();
		await settle();

		expect(webhookSends).toHaveLength(1);
		const sent = webhookSends[0]!;
		expect(sent.content).toBe('olá');
		expect(sent.embeds).toHaveLength(1);
		// o preview chega como veio do Papo: sem autor/rodapé de cartão sobre ele
		expect(sent.embeds?.[0]?.title).toBe('Post');
		expect(sent.embeds?.[0]?.url).toBe('https://example.com/post');
		expect(sent.embeds?.[0]?.footer).toBeUndefined();
		expect(sent.embeds?.[0]?.author).toBeUndefined();
	});

	it('sem avatar o webhook ainda agrupa o usuário (identidade só de nome)', async () => {
		const { bridge, webhookRequests, webhookSends, sends, settle } = fixture({ webhook: true, avatar: false });

		bridge.onPapoEvent(papoMessage('pm-2') as never);
		await settle();

		expect(webhookRequests).toHaveLength(1);
		expect(webhookRequests[0]?.avatarSha).toBeUndefined();
		expect(webhookRequests[0]?.avatarBuffer).toBeUndefined();
		expect(webhookSends).toHaveLength(1);
		expect(sends).toHaveLength(0);
	});

	it('sem webhook disponível (limite do canal) cai no envio normal do bot', async () => {
		const { bridge, webhookSends, sends, settle } = fixture({ webhook: true, webhookUnavailable: true });

		bridge.onPapoEvent(papoMessage('pm-3') as never);
		await settle();

		expect(webhookSends).toHaveLength(0);
		expect(sends).toHaveLength(1);
		expect(sends[0]?.embeds?.[0]?.author?.name).toBe('Jenga');
	});

	it('sem suporte a webhook no DiscordBridge cai no envio normal do bot', async () => {
		const { bridge, webhookSends, sends, settle } = fixture({ webhook: false });

		bridge.onPapoEvent(papoMessage('pm-4') as never);
		await settle();

		expect(webhookSends).toHaveLength(0);
		expect(sends).toHaveLength(1);
	});

	it('webhook morto no envio re-tenta o job em vez de mandar cartão no meio da conversa', async () => {
		const { store, bridge, webhookSends, sends, settle } = fixture({ webhook: true, webhookFailsOnce: true });

		bridge.onPapoEvent(papoMessage('pm-5') as never);
		await settle();

		// primeira tentativa falha com certeza de não-entrega; a retomada entrega pelo webhook
		expect(webhookSends).toHaveLength(2);
		expect(sends).toHaveLength(0);
		expect(store.findMapByDiscord('w-1').length).toBe(1);
	});
});

describe('eco de mensagem de webhook', () => {
	it('mensagem do webhook do bridge é ignorada (anti-loop)', async () => {
		const { bridge, outbox, papoSent, settle } = fixture({
			isSelfMessage: (m) => m.webhookId === 'wh-bridge'
		});

		await bridge.onDiscordMessage(discordMessage('dm-echo', 'wh-bridge') as never);
		await settle();

		// nada foi recriado no Papo a partir do próprio eco
		expect(papoSent).toHaveLength(0);
		expect(outbox.counts().pending).toBe(0);
	});

	it('mensagem de outro webhook do canal não é tratada como eco', async () => {
		const { bridge, outbox, papoSent, settle } = fixture({
			isSelfMessage: (m) => m.webhookId === 'wh-bridge'
		});

		await bridge.onDiscordMessage(discordMessage('dm-outro', 'wh-de-outro') as never);
		await settle();

		expect(papoSent).toHaveLength(1);
		expect(outbox.counts().pending).toBe(0);
	});
});
