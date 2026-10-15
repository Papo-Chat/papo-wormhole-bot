import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { PapoWebhooks } from '../src/papo/webhooks.js';
import { PapoApiError } from '../src/papo/types.js';
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

const DISCORD_USER = 'user-1';
const AVATAR_URL = 'https://cdn.discordapp.com/avatars/user-1/hash.png';

// PNG mínimo reconhecido pelo sniffImage do fixture (magic bytes + corpo qualquer)
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('avatar-teste')]);

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

interface WebhookSend {
	webhookId: string;
	token: string;
	content?: string;
	embeds?: { title?: string; url?: string }[];
	attachments?: { name: string }[];
	replyTo?: string;
	externalMessageId?: string;
}

interface CardSend {
	content?: string | null;
	embeds?: { author?: { name?: string }; description?: string; footer?: { text?: string } }[];
}

const fixture = (opts: {
	/** POST /webhooks recusa (bot sem `manage_webhooks`): as cópias caem no cartão do bot. */
	webhookUnavailable?: boolean;
	/** primeira tentativa de envio morre com 401 (credencial revogada): nada foi entregue. */
	sendDiesOnce?: boolean;
	/** `reply_to` aponta para mensagem apagada: o backend devolve 404 e a cópia não se perde. */
	replyTargetGone?: boolean;
	/** o CDN não serve o avatar: o webhook fica só com o nome. */
	avatar?: boolean;
} = {}) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });

	const mediaFiles = new Map<string, Buffer>();
	const media = {
		save: (data: Buffer) => {
			const sha256 = createHash('sha256').update(data).digest('hex');
			if (!mediaFiles.has(sha256)) mediaFiles.set(sha256, data);
			return { sha256, ext: 'png' };
		},
		urlFor: (sha: string, base?: string) => (base ? `${base}/media/${sha}.png` : undefined),
		readFor: (sha: string) => mediaFiles.get(sha),
		extFor: () => 'png',
		sniffImage: (buf: Buffer): { ext: string; mime: string } | null =>
			buf.length >= 8 && buf.subarray(0, 8).equals(PNG_BYTES.subarray(0, 8)) ? { ext: 'png', mime: 'image/png' } : null
	};

	const created: { channelId: string; name: string }[] = [];
	const identities: { webhookId: string; displayName?: string | null; avatarBase64?: string; avatarFormat?: string }[] = [];
	const webhookSends: WebhookSend[] = [];
	const webhookEdits: { webhookId: string; messageId: string; content: string; embeds?: unknown[] }[] = [];
	const webhookDeletes: string[] = [];
	const cardSends: CardSend[] = [];
	const cardEdits: { messageId: string; content: string }[] = [];
	const cardDeletes: string[] = [];
	const discordSends: CardSend[] = [];

	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga', nickname: 'Jenga' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga', nickname: 'Jenga' })),
		// gestão (JWT + manage_webhooks)
		listWebhooks: async () =>
			store.listPapoWebhooks().map((r) => ({
				id: r.webhook_id,
				channel_id: r.channel_id,
				name: r.name,
				created_by: 'bot',
				created_at: '2026-10-09T18:00:00Z'
			})),
		createWebhook: async (channelId: string, name: string) => {
			if (opts.webhookUnavailable) throw new PapoApiError('sem manage_webhooks', 403);
			created.push({ channelId, name });
			return {
				id: `pw-${created.length}`,
				channel_id: channelId,
				name,
				created_by: 'bot',
				created_at: '2026-10-09T18:00:00Z',
				// o token existe uma única vez: na criação
				token: `token-${created.length}`
			};
		},
		updateWebhookIdentity: async (webhookId: string, input: { displayName?: string | null; avatarBase64?: string; avatarFormat?: string }) => {
			identities.push({ webhookId, ...input });
			return { id: webhookId, channel_id: 'chan-1', name: input.displayName ?? 'webhook', created_by: 'bot', created_at: '' };
		},
		// execução (Bearer do token escopado)
		sendWebhookMessage: async (input: WebhookSend) => {
			webhookSends.push(input);
			if (opts.sendDiesOnce && webhookSends.length === 1) throw new PapoApiError('webhook revogado', 401);
			if (opts.replyTargetGone && input.replyTo && webhookSends.length === 1) throw new PapoApiError('reply_to inexistente', 404);
			return {
				id: `pm-wh-${webhookSends.length}`,
				channel_id: 'chan-1',
				author_id: '',
				content: input.content ?? null,
				created_at: '2026-10-09T18:09:00Z',
				webhook_id: input.webhookId
			};
		},
		editWebhookMessage: async (webhookId: string, _token: string, messageId: string, content: string, embeds?: unknown[]) => {
			// só o webhook ativo edita as próprias mensagens: sem a linha, a credencial morreu
			if (!store.getPapoWebhookById(webhookId)) throw new PapoApiError('webhook revogado', 401);
			webhookEdits.push({ webhookId, messageId, content, ...(embeds ? { embeds } : {}) });
			return { id: messageId, channel_id: 'chan-1', author_id: '', content, created_at: '' };
		},
		deleteWebhookMessage: async (webhookId: string, _token: string, messageId: string) => {
			if (!store.getPapoWebhookById(webhookId)) throw new PapoApiError('webhook revogado', 401);
			webhookDeletes.push(messageId);
		},
		// envio pelo cartão do bot (fallback)
		sendMessage: async (input: CardSend) => {
			cardSends.push(input);
			return { id: 'pm-card', channel_id: 'chan-1', author_id: 'bot', content: null, created_at: '2026-10-09T18:09:00Z' };
		},
		editMessage: async (messageId: string, content: string) => {
			cardEdits.push({ messageId, content });
			return { id: messageId, channel_id: 'chan-1', author_id: 'bot', content, created_at: '' };
		},
		deleteMessage: async (messageId: string) => {
			cardDeletes.push(messageId);
		}
	};

	const discord = {
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		channelName: () => 'geral',
		messageLink: (channelId: string, messageId: string) => `https://discord.com/channels/999/${channelId}/${messageId}`,
		send: async (_channelId: string, options: CardSend) => {
			discordSends.push(options);
			return { id: 'd-new' };
		},
		edit: async () => {},
		delete: async () => {}
	};

	// avatar do autor Discord: o bridge baixa do CDN para fixar no webhook do Papo
	globalThis.fetch = async () =>
		new Response(opts.avatar === false ? Buffer.from('não é imagem') : PNG_BYTES, { status: 200 });

	const bridge = new Bridge(
		cfg,
		store,
		outbox,
		api as never,
		{} as never,
		discord as never,
		media as never,
		new PapoWebhooks(api as never, store, silent)
	);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const settle = () => settleQueue(outbox);

	/** Enfileira um job de envio direto (permite exercitar reações e replies sem o Discord). */
	const enqueueJob = (job: Record<string, unknown>) => {
		outbox.enqueue({
			linkId: link.id,
			direction: 'to_papo',
			kind: 'message',
			dedupeKey: `discord:${job.discordMessageId}:to_papo:0`,
			payload: { job }
		});
	};
	const baseJob = (id: string, extra: Record<string, unknown> = {}) => ({
		kind: 'message',
		linkId: link.id,
		papoChannelId: 'chan-1',
		discordChannelId: '111',
		discordMessageId: id,
		chunkIndex: 0,
		chunkTotal: 1,
		authorId: DISCORD_USER,
		authorName: 'Jenga',
		authorUsername: 'jenga',
		authorAvatarHash: 'hash',
		authorAvatarUrl: AVATAR_URL,
		content: 'olá',
		footerBase: '🕒 09/10/2026 18:09 · Discord',
		notes: [],
		sources: [],
		linkEmbeds: [],
		timestamp: '2026-10-09T18:09:00Z',
		...extra
	});
	const enqueueEdit = (job: Record<string, unknown>, footerOnly = false) => {
		outbox.enqueue({
			linkId: link.id,
			direction: 'to_papo',
			kind: 'edit',
			dedupeKey: `${footerOnly ? 'footer' : 'discord-edit'}:${job.sourceMessageId}:0`,
			payload: { job, ...(footerOnly ? { footerOnly: true } : {}) }
		});
	};
	const baseEdit = (id: string, extra: Record<string, unknown> = {}) => ({
		kind: 'edit',
		side: 'discord',
		linkId: link.id,
		sourceMessageId: id,
		targetChannelId: 'chan-1',
		chunkIndex: 0,
		chunkTotal: 1,
		text: 'olá editado',
		revision: '2026-10-09T18:10:00Z',
		...extra
	});

	return {
		store,
		outbox,
		bridge,
		link,
		enqueueJob,
		baseJob,
		enqueueEdit,
		baseEdit,
		created,
		identities,
		webhookSends,
		webhookEdits,
		webhookDeletes,
		cardSends,
		cardEdits,
		cardDeletes,
		discordSends,
		settle
	};
};

const discordMessage = (id: string, content = 'oi', extra: Record<string, unknown> = {}) => ({
	id,
	channelId: '111',
	channel: { isThread: () => false },
	author: {
		id: DISCORD_USER,
		username: 'jenga',
		displayName: 'Jenga',
		avatar: 'hash',
		displayAvatarURL: () => AVATAR_URL
	},
	member: { displayName: 'Jenga' },
	content,
	createdAt: new Date('2026-10-09T18:09:00Z'),
	attachments: [],
	embeds: [],
	...extra
});

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe('cópia Discord → Papo pelo webhook do bridge', () => {
	it('mensagem sai pelo webhook com o texto no content, sem cartão', async () => {
		const { store, bridge, created, webhookSends, cardSends, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1') as never);
		await settle();

		expect(cardSends).toHaveLength(0);
		expect(webhookSends).toHaveLength(1);
		const sent = webhookSends[0]!;
		// content = conteúdo do Discord; o bridge não gera cartão nem rodapé
		expect(sent.content).toBe('oi');
		expect(sent.embeds ?? []).toHaveLength(0);
		expect(sent.token).toBe('token-1');

		// webhook por usuário Discord, por canal Papo
		expect(created).toHaveLength(1);
		expect(created[0]!.channelId).toBe('chan-1');
		expect(created[0]!.name).toBe('Jenga (@jenga)');

		const map = store.findMapByDiscord('dm-1')[0];
		expect(map?.webhook_copy).toBe(1);
		expect(map?.bridge_embed).toBeNull();
		expect(map?.footer_base).toBeNull();
		// a credencial que vai editar/apagar a cópia fica registrada nela
		expect(map?.webhook_id).toBe('pw-1');
	});

	it('nick e avatar ficam fixos no webhook (não na mensagem)', async () => {
		const { bridge, identities, webhookSends, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1') as never);
		await settle();

		expect(identities).toHaveLength(1);
		expect(identities[0]?.displayName).toBe('Jenga');
		expect(identities[0]?.avatarBase64).toBe(PNG_BYTES.toString('base64'));
		expect(identities[0]?.avatarFormat).toBe('PNG');
		// a mensagem não leva override de nick/avatar
		expect(webhookSends[0]).not.toHaveProperty('username');
		expect(webhookSends[0]).not.toHaveProperty('externalAuthor');
	});

	it('identidade aplicada uma única vez: mensagens seguintes não reenviam o avatar', async () => {
		const { bridge, identities, webhookSends, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1') as never);
		await bridge.onDiscordMessage(discordMessage('dm-2', 'outra') as never);
		await settle();

		expect(webhookSends).toHaveLength(2);
		expect(identities).toHaveLength(1);
	});

	it('sem avatar disponível o webhook continua com a identidade de nome', async () => {
		const { bridge, identities, webhookSends, cardSends, settle } = fixture({ avatar: false });

		await bridge.onDiscordMessage(discordMessage('dm-1') as never);
		await settle();

		expect(webhookSends).toHaveLength(1);
		expect(cardSends).toHaveLength(0);
		expect(identities[0]?.avatarBase64).toBeUndefined();
	});

	it('envio é idempotente: a chave do job vai como external_message_id', async () => {
		const { bridge, webhookSends, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1') as never);
		await settle();

		expect(webhookSends[0]?.externalMessageId).toBe('discord:dm-1:0:0');
	});

	it('resumo de reações é anexado ao content (não há cartão)', async () => {
		const { store, bridge, link, enqueueJob, baseJob, webhookSends, settle } = fixture();
		store.setReaction({ linkId: link.id, source: 'discord', sourceMessageId: 'dm-r', emoji: '👍', count: 2 });
		enqueueJob(baseJob('dm-r'));
		await bridge.drain();
		await settle();

		expect(webhookSends[0]?.content).toBe('olá\n\n↳ 👍 2');
	});

	it('preview de link não vira embed: o link-preview é nativo do content', async () => {
		const { bridge, webhookSends, settle } = fixture();
		const message = discordMessage('dm-pv', 'veja https://example.com/post', {
			embeds: [{ type: 'rich', title: 'Post', url: 'https://example.com/post', description: 'preview do link' }]
		});

		await bridge.onDiscordMessage(message as never);
		await settle();

		expect(webhookSends).toHaveLength(1);
		// a URL vai no texto e o backend do Papo faz o preview dele — sem embed duplicado
		expect(webhookSends[0]?.content).toBe('veja https://example.com/post');
		expect(webhookSends[0]?.embeds ?? []).toHaveLength(0);
	});

	it('sem permissão de criar webhook cai no envio pelo cartão do bot', async () => {
		const { bridge, webhookSends, cardSends, settle } = fixture({ webhookUnavailable: true });

		await bridge.onDiscordMessage(discordMessage('dm-1') as never);
		await settle();

		expect(webhookSends).toHaveLength(0);
		expect(cardSends).toHaveLength(1);
		expect(cardSends[0]?.embeds?.[0]?.author?.name).toBe('Jenga');
	});

	it('credencial morta no envio re-tenta o job em vez de mandar cartão no meio da conversa', async () => {
		const { store, bridge, created, webhookSends, cardSends, settle } = fixture({ sendDiesOnce: true });

		await bridge.onDiscordMessage(discordMessage('dm-1') as never);
		await settle();

		// 401 é a credencial que morreu: nada foi entregue, o webhook é recriado
		expect(webhookSends).toHaveLength(2);
		expect(created).toHaveLength(2);
		expect(cardSends).toHaveLength(0);
		expect(store.findMapByDiscord('dm-1').length).toBe(1);
	});
});

describe('reply na cópia de webhook do Papo', () => {
	/** Cópia da mensagem respondida: é dela que sai o id de `reply_to`. */
	const mapReplied = (store: Store, link: { id: number }) =>
		store.mapMessage({
			link_id: link.id,
			direction: 'discord_to_papo',
			papo_message_id: 'pm-orig',
			discord_message_id: 'd-orig',
			chunk_index: 0,
			chunk_total: 1,
			author_label: 'Jenga'
		});

	it('reply é nativo: reply_to do Papo, sem nota no texto', async () => {
		const { store, bridge, link, webhookSends, settle } = fixture();
		mapReplied(store, link);

		await bridge.onDiscordMessage(discordMessage('dm-reply', 'resposta', { reference: { messageId: 'd-orig' } }) as never);
		await settle();

		// webhook do Papo responde mensagem (diferente do Discord): a referência não vira texto
		expect(webhookSends[0]?.replyTo).toBe('pm-orig');
		expect(webhookSends[0]?.content).toBe('resposta');
		expect(store.findMapByDiscord('dm-reply')[0]?.reply_note).toBeNull();
	});

	it('sem cópia da mensagem respondida o reply não é propagado', async () => {
		const { bridge, webhookSends, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-reply', 'resposta', { reference: { messageId: 'd-antiga' } }) as never);
		await settle();

		expect(webhookSends[0]?.replyTo).toBeUndefined();
		expect(webhookSends[0]?.content).toBe('resposta');
	});

	it('reply a mensagem apagada não perde a cópia: reenvia sem referência', async () => {
		const { store, bridge, link, webhookSends, settle } = fixture({ replyTargetGone: true });
		mapReplied(store, link);

		await bridge.onDiscordMessage(discordMessage('dm-reply', 'resposta', { reference: { messageId: 'd-orig' } }) as never);
		await settle();

		// primeira tentativa com a referência morre em 404; a cópia sai sem ela
		expect(webhookSends).toHaveLength(2);
		expect(webhookSends[0]?.replyTo).toBe('pm-orig');
		expect(webhookSends[1]?.replyTo).toBeUndefined();
		expect(webhookSends[1]?.content).toBe('resposta');
	});
});

describe('edição e exclusão da cópia de webhook do Papo', () => {
	/** Bridge de uma mensagem e retorno do id da cópia no Papo. */
	const bridgeOne = async (f: ReturnType<typeof fixture>, id = 'dm-1') => {
		await f.bridge.onDiscordMessage(discordMessage(id) as never);
		await f.settle();
		return f.store.findMapByDiscord(id)[0]!;
	};

	it('edição reescreve o content pela credencial do webhook', async () => {
		const f = fixture();
		const map = await bridgeOne(f);

		f.enqueueEdit(f.baseEdit('dm-1'));
		await f.bridge.drain();
		await f.settle();

		expect(f.webhookEdits).toHaveLength(1);
		expect(f.webhookEdits[0]?.messageId).toBe(map.papo_message_id);
		expect(f.webhookEdits[0]?.content).toBe('olá editado');
		// embeds ausentes preservam os embeds da mensagem: o edit é só de texto
		expect(f.webhookEdits[0]).not.toHaveProperty('embeds');
		// o JWT do bot não alcança mensagem de webhook: nada saiu por `/messages`
		expect(f.cardEdits).toHaveLength(0);
		expect(f.store.findMapByDiscord('dm-1')[0]?.rendered).toBe('olá editado');
	});

	it('resumo de reações reescreve o content da cópia', async () => {
		const f = fixture();
		await bridgeOne(f);
		f.store.setReaction({ linkId: f.link.id, source: 'discord', sourceMessageId: 'dm-1', emoji: '👍', count: 3 });

		f.enqueueEdit(f.baseEdit('dm-1', { text: '' }), true);
		await f.bridge.drain();
		await f.settle();

		expect(f.webhookEdits[0]?.content).toBe('oi\n\n↳ 👍 3');
		expect(f.cardEdits).toHaveLength(0);
	});

	it('preview que chega atrasado não escreve embed na cópia de webhook', async () => {
		const f = fixture();
		await bridgeOne(f);

		f.outbox.enqueue({
			linkId: f.link.id,
			direction: 'to_papo',
			kind: 'edit',
			dedupeKey: 'discord-embeds:dm-1:0',
			payload: {
				job: f.baseEdit('dm-1', { text: '' }),
				embedsOnly: true,
				papoPreviews: [{ title: 'Post', url: 'https://example.com/post' }]
			}
		});
		await f.bridge.drain();
		await f.settle();

		// o preview não é embed do bridge: quem o desenha é o crawl do próprio `content`
		expect(f.webhookEdits).toHaveLength(0);
		expect(f.cardEdits).toHaveLength(0);
	});

	it('exclusão apaga pela credencial do webhook', async () => {
		const f = fixture();
		const map = await bridgeOne(f);

		f.outbox.enqueue({
			linkId: f.link.id,
			direction: 'to_papo',
			kind: 'delete',
			dedupeKey: 'discord-delete:dm-1',
			payload: { job: { kind: 'delete', side: 'discord', linkId: f.link.id, sourceMessageId: 'dm-1' } }
		});
		await f.bridge.drain();
		await f.settle();

		expect(f.webhookDeletes).toEqual([map.papo_message_id]);
		expect(f.cardDeletes).toHaveLength(0);
	});

	it('credencial perdida não queima as tentativas do job', async () => {
		const f = fixture();
		await bridgeOne(f);
		// webhook revogado por fora: a linha se foi, e a cópia fica fora do alcance do bridge
		f.store.deletePapoWebhook('pw-1');

		f.enqueueEdit(f.baseEdit('dm-1'));
		await f.bridge.drain();
		await f.settle();

		expect(f.webhookEdits).toHaveLength(0);
		expect(f.cardEdits).toHaveLength(0);
		// não é falha permanente: re-tentar não traria a cópia de volta
		expect(f.outbox.counts().dead).toBe(0);
	});
});

describe('eco de mensagem de webhook no Papo', () => {
	it('cópia criada pelo webhook do bridge é ignorada (anti-loop)', async () => {
		const { store, bridge, outbox, discordSends, settle } = fixture();
		store.upsertPapoWebhook({
			webhook_id: 'pw-1',
			channel_id: 'chan-1',
			discord_user_id: DISCORD_USER,
			name: 'Jenga (@jenga)',
			token: 'token-1'
		});

		bridge.onPapoEvent({
			type: 'message',
			id: 'pm-echo',
			channel_id: 'chan-1',
			author_id: '',
			content: 'oi',
			created_at: '2026-10-09T18:09:00Z',
			webhook_id: 'pw-1'
		} as never);
		await settle();

		expect(outbox.counts().pending).toBe(0);
		expect(discordSends).toHaveLength(0);
	});

	it('webhook de terceiro no canal continua sendo ponteado, com a autoria que ele declara', async () => {
		const { bridge, discordSends, settle } = fixture();

		bridge.onPapoEvent({
			type: 'message',
			id: 'pm-outro',
			channel_id: 'chan-1',
			author_id: '',
			content: 'aviso',
			created_at: '2026-10-09T18:09:00Z',
			webhook_id: 'pw-de-outro',
			external_author: { source: 'alertas', id: 'a1', name: 'Alertas' }
		} as never);
		await settle();

		expect(discordSends).toHaveLength(1);
		// webhook não é usuário do Papo: não tem perfil para resolver, a identidade é a declarada
		expect(discordSends[0]?.embeds?.[0]?.author?.name).toBe('Alertas');
	});
});

