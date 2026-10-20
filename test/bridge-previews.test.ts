import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { settleQueue } from './helpers/settle.js';
import { createHash } from 'node:crypto';
import type { Config } from '../src/config.js';
import type { PapoEmbedInput } from '../src/papo/types.js';

/**
 * Feature: o primeiro link-preview (ou o GIF do picker do Papo) acompanha a mensagem
 * bridgeada como embed **extra**, atrás do cartão da ponte, nos dois sentidos.
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
		mediaBaseUrl: 'http://media.local:8080',
		timezone: 'UTC',
		emojiAutoImport: false,
		propagateMentions: false,
		maxAttempts: 5,
		backoffBaseMs: 20,
		backoffMaxMs: 60
	}
};

interface EmbedLike {
	title?: string;
	description?: string;
	url?: string;
	author?: { name?: string; icon_url?: string };
	footer?: { text?: string };
	thumbnail?: { url?: string };
	image?: { url?: string };
	video?: { url?: string; mime_type?: string };
	site_name?: string;
}

interface DiscordSend {
	channelId: string;
	embeds: EmbedLike[];
	files: string[];
}

interface PapoSend {
	channelId: string;
	content?: string;
	embeds?: PapoEmbedInput[];
	attachments?: { name: string }[];
}

const fixture = (opts: {
	embedImageDelayMs?: number;
	mediaBaseUrl?: string | null;
	maxFileBytes?: number;
	bridgeEdits?: boolean;
	avatar?: boolean;
	papoWebhookMode?: boolean;
} = {}) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: cfg.bridge.maxAttempts, baseMs: 20, maxMs: 60 });
	const config: Config = {
		...cfg,
		...(opts.maxFileBytes ? { discord: { ...cfg.discord, maxFileBytes: opts.maxFileBytes } } : {}),
		...(opts.mediaBaseUrl === undefined ? {} : { bridge: { ...cfg.bridge, mediaBaseUrl: opts.mediaBaseUrl ?? undefined } })
	};

	const mediaFiles = new Map<string, { data: Buffer; ext: string }>();
	const EXT_BY_MIME: Record<string, string> = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/webp': 'webp',
		'image/gif': 'gif',
		'video/mp4': 'mp4',
		'video/webm': 'webm'
	};
	const media = {
		save: (data: Buffer, mime?: string | null) => {
			const sha256 = createHash('sha256').update(data).digest('hex');
			const ext = EXT_BY_MIME[mime ?? ''] ?? 'bin';
			if (!mediaFiles.has(sha256)) mediaFiles.set(sha256, { data, ext });
			return { sha256, ext };
		},
		urlFor: (sha: string, base?: string) => (base ? `${base}/media/${sha}.${mediaFiles.get(sha)?.ext ?? 'bin'}` : undefined),
		readFor: (sha: string) => mediaFiles.get(sha)?.data,
		extFor: (sha: string) => mediaFiles.get(sha)?.ext ?? 'bin',
		// espelha o sniffing real do MediaStore: o identity usa para o avatar do Papo
		sniffImage: (buf: Buffer): { ext: string; mime: string } | null => {
			if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
				return { ext: 'png', mime: 'image/png' };
			if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
			if (buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return { ext: 'gif', mime: 'image/gif' };
			if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP')
				return { ext: 'webp', mime: 'image/webp' };
			return null;
		}
	};

	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u' })),
		profilesBatch: async (ids: string[]) =>
			ids.map((id) => ({
				id,
				username: 'u',
				nickname: null,
				...(opts.avatar
					? {
							// magic de PNG: o identity cheira o formato antes de salvar o avatar
							avatar_blob: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('avatar-bytes')]).toString(
								'base64'
							),
							avatar_format: 'png'
						}
					: {})
			})),
		whoami: async () => ({ id: 'bot', username: 'bot' }),
		ensureSession: async () => true,
		getEmbed: async (id: string) => {
			if (opts.embedImageDelayMs) await new Promise((r) => setTimeout(r, opts.embedImageDelayMs));
			return { id, image_data: Buffer.from(`imagem-do-embed-${id}`).toString('base64') };
		},
		sent: [] as PapoSend[],
		sendMessage: async (input: PapoSend) => {
			api.sent.push(input);
			return { id: `pm${api.sent.length}`, channel_id: input.channelId, author_id: 'bot', content: null, created_at: new Date().toISOString() };
		},
		edits: [] as { id: string; content: string; embeds: EmbedLike[] }[],
		editMessage: async (id: string, content: string, embeds: EmbedLike[]) => void api.edits.push({ id, content, embeds }),
		listMessages: async () => ({ messages: [] })
	};

	const discord = {
		selfId: 'bot-1',
		sends: [] as DiscordSend[],
		edits: [] as { messageId: string; embeds: EmbedLike[]; files: string[] }[],
		send: async (channelId: string, options: { embeds?: EmbedLike[]; files?: { name: string }[] }) => {
			discord.sends.push({ channelId, embeds: options.embeds ?? [], files: (options.files ?? []).map((f) => f.name) });
			return { id: `d${discord.sends.length}` };
		},
		edit: async (channelId: string, messageId: string, options: { embeds?: EmbedLike[]; files?: { name: string }[] }) => {
			void channelId;
			discord.edits.push({ messageId, embeds: options.embeds ?? [], files: (options.files ?? []).map((f) => f.name) });
		},
		recentByAuthor: async () => [],
		isSelf: (id?: string | null) => id === 'bot-1',
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		loadUnavailableEmojis: async () => 0,
		channelName: () => 'geral',
		roleName: () => undefined,
		react: async () => {},
		unreact: async () => {},
		delete: async () => {},
		fetchMessage: async () => undefined,
		/** Preenchido por teste: o bridge renova a assinatura vencida antes de desistir. */
		refreshMediaUrl: undefined as ((url: string) => Promise<string | undefined>) | undefined,
		destroy: async () => {}
	};

	const webhookSends: { content?: string; embeds?: PapoEmbedInput[] }[] = [];
	const webhookEdits: { id: string; content: string; embeds?: PapoEmbedInput[] }[] = [];
	const papoWebhooks = opts.papoWebhookMode ? {
		userWebhook: async () => ({ webhookId: 'papo-hook', token: 'webhook-token' }),
		send: async (_ref: unknown, channelId: string, input: { content?: string; embeds?: PapoEmbedInput[] }) => {
			webhookSends.push(input);
			return { id: `wh${webhookSends.length}`, channel_id: channelId, author_id: 'webhook-author', content: input.content ?? null, created_at: new Date().toISOString() };
		},
		refFor: () => ({ webhookId: 'papo-hook', token: 'webhook-token' }),
		edit: async (_ref: unknown, id: string, content: string, embeds?: PapoEmbedInput[]) => {
			webhookEdits.push({ id, content, embeds });
			return true;
		},
		owns: (webhookId?: string | null) => webhookId === 'papo-hook'
	} : undefined;
	const bridge = new Bridge(config, store, outbox, api as never, { close: () => {}, connect: () => {} } as never, discord as never, media as never, papoWebhooks as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	if (opts.bridgeEdits === false) store.setChannelLinkFlag(link.id, 'bridge_edits', 0);
	const settle = (quietMs = 700) => settleQueue(outbox, quietMs, 6000);
	return { store, outbox, bridge, link, api, discord, webhookSends, webhookEdits, settle };
};

const papoMessage = (id: string, content = 'olá', extra: Record<string, unknown> = {}) =>
	({
		type: 'message',
		id,
		channel_id: 'chan-1',
		author_id: 'papo-user-1',
		content,
		created_at: new Date().toISOString(),
		attachments: [],
		...extra
	}) as never;

const discordMessage = (id: string, content: string, extra: Record<string, unknown> = {}) => {
	const { authorBot = false, ...messageExtra } = extra;
	return ({
		id,
		channelId: '111',
		channel: { isThread: () => false },
		author: { id: 'user-1', username: 'jenga', displayName: 'Jenga', displayAvatarURL: () => 'https://cdn.example.com/a.png', bot: authorBot !== false },
		member: { displayName: 'Jenga' },
		content,
		createdAt: new Date(),
		attachments: [],
		embeds: [],
		...messageExtra
	}) as never;
};

const linkPreview = (title: string, url = 'https://example.com/artigo') => ({
	id: `e-${title}`,
	source_type: 'link',
	site_name: 'Example',
	url,
	title,
	description: `resumo de ${title}`,
	thumbnail: { width: 120, height: 80, mime_type: 'image/webp' }
});

const richPreview = (title: string, url = `https://example.com/${title}`) => ({
	type: 'rich',
	url,
	title,
	description: `resumo de ${title}`,
	thumbnail: { url: `${url}/thumb.png` }
});

/** GIF de Twitter no Discord (espelho vxTwitter/fixvx): conversor avif carregando o mp4 no query. */
const vxTwitterGif = () => ({
	type: 'rich',
	url: 'https://vxtwitter.com/hardestgifs/status/2108436160964136985',
	description: 'https://t.co/rGCV8x7bXD',
	author: { name: 'Hardest GIFs 🔥 (@hardestgifs)', icon_url: 'https://pbs.twimg.com/profile_images/1640140330/breakdance_normal.gif' },
	image: {
		url: 'https://gifconvert.vxtwitter.com/convert.avif?url=https%3A%2F%2Fvideo.twimg.com%2Ftweet_video%2FHUKrfRHXIAAdssa.mp4',
		proxy_url:
			'https://images-ext-1.discordapp.net/external/ynozJlOM/%3Furl%3Dhttps%3A%2F%2Fvideo.twimg.com%2Ftweet_video%2FHUKrfRHXIAAdssa.mp4/https/gifconvert.vxtwitter.com/convert.avif',
		width: 720,
		height: 612,
		content_type: 'image/avif'
	},
	footer: { text: 'vxTwitter / fixvx • GIF' }
});

describe('preview no bridge Discord → Papo', () => {
	it('URL no conteúdo fica para o preview nativo do Papo, sem embed duplicado', async () => {
		const { bridge, api, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1', 'olá https://example.com/a', { authorBot: true, embeds: [richPreview('primeiro'), richPreview('segundo')] }));
		await settle();

		const embeds = api.sent[0]!.embeds ?? [];
		expect(embeds).toHaveLength(1);
		// O cartão não replica o embed do Discord; o URL no content aciona o crawler nativo do Papo.
		expect(embeds[0]!.author?.name).toBe('Jenga');
		expect(embeds[0]!.description).toBe('');
		expect(api.sent[0]!.content).toContain('olá');
		expect(api.sent[0]!.content).toContain('https://example.com/a');
	});

	it('mensagem sem preview não ganha embed vazio', async () => {
		const { bridge, api, outbox, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1', 'sem link'));
		await settle();

		expect(api.sent).toHaveLength(1);
		expect(api.sent[0]!.embeds).toHaveLength(1);
		expect(outbox.counts().dead).toBe(0);
	});

	it('embed personalizado de bot sem hyperlink é convertido mesmo após embed inválido', async () => {
		const { bridge, api, outbox, settle } = fixture();

		await bridge.onDiscordMessage(
			discordMessage('dm-1', 'texto', { authorBot: true, embeds: [{ type: 'unknown' }, { type: 'rich', url: 'https://example.com/x', title: 'convertível' }] })
		);
		await settle();

		const embeds = api.sent[0]!.embeds ?? [];
		expect(embeds[0]!.description).toContain('texto');
		expect(embeds[1]!.title).toBe('convertível');
		expect(outbox.counts().dead).toBe(0);
	});

	it('embed personalizado é enviado também no modo webhook do Papo', async () => {
		const { bridge, webhookSends, settle } = fixture({ papoWebhookMode: true });
		await bridge.onDiscordMessage(
			discordMessage('dm-custom-webhook-mode', '', {
				authorBot: true,
				embeds: [richPreview('custom-no-webhook')]
			})
		);
		await settle();

		expect(webhookSends).toHaveLength(1);
		expect(webhookSends[0]!.embeds).toHaveLength(1);
		expect(webhookSends[0]!.embeds![0]!.title).toBe('custom-no-webhook');
	});

	it('edição de embed personalizado também atualiza a cópia de webhook do Papo', async () => {
		const { bridge, webhookEdits, settle } = fixture({ papoWebhookMode: true });
		await bridge.onDiscordMessage(discordMessage('dm-custom-webhook-edit', 'status do bot', { authorBot: true }));
		await settle();

		await bridge.onDiscordEdit(
			{} as never,
			discordMessage('dm-custom-webhook-edit', 'status do bot', { authorBot: true, embeds: [richPreview('editado-webhook')] })
		);
		await settle();

		expect(webhookEdits.some((edit) => edit.embeds?.[0]?.title === 'editado-webhook')).toBe(true);
	});

	it('embed personalizado de webhook sem hyperlink é convertido', async () => {
		const { bridge, api, settle } = fixture();
		await bridge.onDiscordMessage(
			discordMessage('dm-webhook', 'notificação personalizada', {
				authorBot: false,
				webhookId: 'webhook-1',
				embeds: [richPreview('webhook')]
			})
		);
		await settle();

		expect(api.sent[0]!.embeds).toHaveLength(2);
		expect(api.sent[0]!.embeds![1]!.title).toBe('webhook');
	});

	it('embed personalizado de bot com content vazio não aciona um segundo preview nativo', async () => {
		const { bridge, api, settle } = fixture();
		await bridge.onDiscordMessage(
			discordMessage('dm-bot-empty', '', {
				authorBot: true,
				embeds: [richPreview('custom-vazio')]
			})
		);
		await settle();

		expect(api.sent[0]!.embeds).toHaveLength(2);
		expect(api.sent[0]!.embeds![1]!.title).toBe('custom-vazio');
		expect(api.sent[0]!.content ?? '').toBe('');
	});

	it('imagem em embed personalizado vira thumbnail mesmo com attachments comuns desativados', async () => {
		const { bridge, api, link, store, settle } = fixture();
		store.setChannelLinkFlag(link.id, 'bridge_attachments', 0);
		const imageUrl = 'https://cdn.discordapp.com/attachments/111/222/imagem-sem-extensao';
		const proxyUrl = 'https://media.discordapp.net/attachments/111/222/imagem-sem-extensao?width=480&height=480';

		await bridge.onDiscordMessage(
			discordMessage('dm-bot-image', '', {
				authorBot: true,
				attachments: [{ id: 'attachment-1', name: 'imagem-sem-extensao', size: 128, url: imageUrl }],
				embeds: [{
					type: 'rich',
					title: 'Sua imagem de perfil.',
					image: { url: imageUrl, proxy_url: proxyUrl, width: 480, height: 480 }
				}]
			})
		);
		await settle();

		const sent = api.sent[0]!;
		expect(sent.embeds).toHaveLength(2);
		expect(sent.embeds![1]!.title).toBe('Sua imagem de perfil.');
		expect(sent.embeds![1]!.thumbnail?.url).toBeUndefined();
		expect(sent.embeds![1]!.thumbnail?.attachment_name).toBe(sent.attachments![0]!.name);
		expect(sent.attachments).toHaveLength(1);
	});

	it(
		'faz upload da image do CDN e usa o attachment como thumbnail do embed, sem media server',
		async () => {
			const { bridge, api, settle } = fixture();
			const imageUrl = [
				'https://cdn.discordapp.com/avatars/2065552277044035584/',
				'b8624b4931b177ada37a361dfcdd83cc.png?size=1024'
			].join('');
			const proxyUrl = [
				'https://images-ext-1.discordapp.net/external/signature/cdn.discordapp.com',
				new URL(imageUrl).pathname,
				'?size=1024'
			].join('');
			const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

			const { urls } = await withFetch(
				async (url) =>
					url === imageUrl
						? new Response(pngHeader, { status: 200, headers: { 'content-type': 'image/png' } })
						: new Response('not found', { status: 404 }),
				async () => {
					await bridge.onDiscordMessage(
						discordMessage('dm-bot-cdn-avatar', '', {
							authorBot: true,
							embeds: [{
								type: 'rich',
								title: 'Sua imagem de perfil.',
								image: {
									url: imageUrl,
									proxy_url: proxyUrl,
									content_type: 'image/png',
									width: 1024,
									height: 1024
								}
							}]
						})
					);
					await settle();
				}
			);

			expect(urls).toEqual([imageUrl]);
			const sent = api.sent[0]!;
			expect(sent.embeds).toHaveLength(2);
			expect(sent.embeds![1]!.title).toBe('Sua imagem de perfil.');
			const thumbnail = sent.embeds![1]!.thumbnail!;
			expect(thumbnail.url).toBeUndefined();
			expect(thumbnail.attachment_name).toBe(sent.attachments![0]!.name);
			expect(thumbnail.mime_type).toBe('image/png');
			expect(sent.attachments).toHaveLength(1);
			expect(sent.attachments![0]!.name).toContain('b8624b4931b177ada37a361dfcdd83cc.png');
		}
	);

	it('recria a cópia e anexa a imagem se o embed do bot ganha mídia numa edição', async () => {
		const { bridge, api, settle } = fixture();
		const imageUrl = 'https://cdn.discordapp.com/avatars/123456789/edited-image.png?size=1024';
		const proxyUrl = 'https://images-ext-1.discordapp.net/external/signature/edited-image.png';
		const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

		const { urls } = await withFetch(
			async (url) =>
				url === imageUrl
					? new Response(pngHeader, { status: 200, headers: { 'content-type': 'image/png' } })
					: new Response('not found', { status: 404 }),
			async () => {
				await bridge.onDiscordMessage(
					discordMessage('dm-late-bot-image', 'status do bot', { authorBot: true })
				);
				await settle();

				await bridge.onDiscordEdit(
					{} as never,
					discordMessage('dm-late-bot-image', 'status do bot', {
						authorBot: true,
						embeds: [{
							type: 'rich',
							title: 'Imagem recebida depois',
							image: {
								url: imageUrl,
								proxy_url: proxyUrl,
								content_type: 'image/png',
								width: 1024,
								height: 1024
							}
						}]
					})
				);
				await settle();
			}
		);

		expect(urls).toEqual([imageUrl]);
		expect(api.sent).toHaveLength(2);
		expect(api.sent[1]!.embeds![1]!.title).toBe('Imagem recebida depois');
		expect(api.sent[1]!.embeds![1]!.thumbnail?.url).toBeUndefined();
		expect(api.sent[1]!.embeds![1]!.thumbnail?.attachment_name).toBe(api.sent[1]!.attachments![0]!.name);
		expect(api.sent[1]!.attachments).toHaveLength(1);
	});

	it('prefere thumbnail do Discord e usa image apenas quando thumbnail falta', async () => {
		const { bridge, api, settle } = fixture();
		const thumbnailUrl = 'https://images.example.com/thumb.png';
		const imageUrl = 'https://cdn.discordapp.com/avatars/123456789/image.png?size=1024';

		await bridge.onDiscordMessage(
			discordMessage('dm-bot-both-media', '', {
				authorBot: true,
				embeds: [{
					type: 'rich',
					title: 'embed com duas imagens',
					thumbnail: { url: thumbnailUrl, content_type: 'image/png', width: 100, height: 100 },
					image: { url: imageUrl, content_type: 'image/png', width: 1024, height: 1024 }
				}]
			})
		);
		await settle();

		const sent = api.sent[0]!;
		expect(sent.embeds![1]!.thumbnail?.url).toBe(thumbnailUrl);
		expect(sent.embeds![1]!.thumbnail?.attachment_name).toBeUndefined();
		expect(sent.attachments ?? []).toHaveLength(0);
	});

	it('imagem de embed components de bot também é preservada sem MIME explícito', async () => {
		const { bridge, api, settle } = fixture();
		const imageUrl = 'https://cdn.discordapp.com/attachments/111/222/component-image';
		const proxyUrl = 'https://media.discordapp.net/attachments/111/222/component-image?width=480';

		await bridge.onDiscordMessage(
			discordMessage('dm-bot-components', '', {
				authorBot: true,
				embeds: [{
					type: 'components',
					title: 'Imagem do bot',
					url: 'https://example.com/profile',
					components: [{
						type: 17,
						components: [{
							type: 12,
							items: [{ media: { url: imageUrl, proxy_url: proxyUrl, width: 480, height: 480 } }]
						}]
					}]
				}]
			})
		);
		await settle();

		expect(api.sent[0]!.embeds).toHaveLength(2);
		expect(api.sent[0]!.embeds![1]!.thumbnail?.url).toBeUndefined();
		expect(api.sent[0]!.embeds![1]!.thumbnail?.attachment_name).toBe(api.sent[0]!.attachments![0]!.name);
		expect(api.sent[0]!.attachments).toHaveLength(1);
	});

	it('embed de GIF de bot sem URL no content continua sendo convertido', async () => {
		const { bridge, api, link, store, settle } = fixture();
		store.setChannelLinkFlag(link.id, 'bridge_attachments', 0);
		await bridge.onDiscordMessage(
			discordMessage('dm-bot-gif', '', {
				authorBot: true,
				embeds: [{
					type: 'rich',
					url: 'https://giphy.com/gifs/custom-bot-gif',
					title: 'GIF personalizado',
					image: { url: 'https://media.giphy.com/media/custom-bot-gif/giphy.gif', width: 320, height: 240, content_type: 'image/gif' }
				}]
			})
		);
		await settle();

		expect(api.sent[0]!.embeds).toHaveLength(2);
		expect(api.sent[0]!.embeds![1]!.title).toBe('GIF personalizado');
		expect(api.sent[0]!.content ?? '').toBe('');
	});

	it('embed de usuário sem hyperlink não é convertido e sua URL vai para o crawler nativo', async () => {
		const { bridge, api, settle } = fixture();
		await bridge.onDiscordMessage(
			discordMessage('dm-human', 'mensagem com preview', {
				authorBot: false,
				embeds: [richPreview('nativo')]
			})
		);
		await settle();

		expect(api.sent[0]!.embeds).toHaveLength(1);
		expect(api.sent[0]!.embeds![0]!.description).toBe('');
		expect(api.sent[0]!.content).toContain('mensagem com preview');
		expect(api.sent[0]!.content).toContain('https://example.com/nativo');
	});

	it('GIF do Twitter via espelho chega como vídeo, não como imagem que o backend do Papo descarta', async () => {
		const { bridge, api, settle } = fixture();

		await bridge.onDiscordMessage(
			discordMessage('dm-1', 'olha o gif', { authorBot: true, embeds: [vxTwitterGif()] })
		);
		await settle();

		const previews = api.sent[0]!.embeds ?? [];
		expect(previews).toHaveLength(2);
		const preview = previews.at(-1)!;
		// o mp4 está escondido no query do conversor avif: é ele que o Papo reproduz
		expect(preview.video?.url).toBe('https://video.twimg.com/tweet_video/HUKrfRHXIAAdssa.mp4');
		expect(preview.video?.mime_type).toBe('video/mp4');
		expect(preview.thumbnail).toBeUndefined();
		expect(preview.url).toBe('https://vxtwitter.com/hardestgifs/status/2108436160964136985');
	});

	it('anexo e preview convivem: o cartão não perde o arquivo nem o preview', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(Buffer.from('conteúdo'), { status: 200 });
		try {
			const { bridge, api, settle } = fixture();
			await bridge.onDiscordMessage(
				discordMessage('dm-1', 'com anexo', {
					authorBot: false,
					attachments: [{ id: 'a1', name: 'nota.txt', contentType: 'text/plain', size: 9, url: 'https://cdn.example.com/nota.txt' }],
					embeds: [richPreview('artigo')]
				})
			);
			await settle();

			expect(api.sent[0]!.attachments?.map((a) => a.name)).toEqual(['nota.txt']);
			expect(api.sent[0]!.embeds).toHaveLength(1);
			expect(api.sent[0]!.content).toContain('com anexo');
			expect(api.sent[0]!.content).toContain('https://example.com/artigo');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('GIF do picker do Discord já vai como anexo: o embed da mesma mídia não é duplicado', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(Buffer.from('gif'), { status: 200 });
		try {
			const { bridge, api, settle } = fixture();
			await bridge.onDiscordMessage(
				discordMessage('dm-1', '', {
					authorBot: false,
					attachments: [{ id: 'a1', name: 'gif.gif', contentType: 'image/gif', size: 3, url: 'https://cdn.discordapp.com/attachments/111/222/gif.gif' }],
					embeds: [
						{
							type: 'gifv',
							url: 'https://klipy.com/gifs/gif',
							title: 'GIF',
							image: { url: 'https://media.discordapp.net/attachments/111/222/gif.gif' },
							thumbnail: { url: 'https://media.discordapp.net/attachments/111/222/gif.gif' }
						}
					]
				})
			);
			await settle();

			expect(api.sent[0]!.attachments?.map((a) => a.name)).toEqual(['gif.gif']);
			expect(api.sent[0]!.embeds).toHaveLength(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('o preview fica guardado no mapa: re-render posterior não o perde', async () => {
		const { bridge, store, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1', 'olá', { authorBot: true, embeds: [richPreview('artigo')] }));
		await settle();

		const map = store.findMapByDiscord('dm-1')[0]!;
		expect(JSON.parse(map.link_embeds!) as EmbedLike[]).toHaveLength(1);
	});
});

describe('preview no bridge Papo → Discord', () => {
	it('mensagem com link-preview cria o cartão e o embed extra com a imagem re-hospedada', async () => {
		const { bridge, discord, settle } = fixture();

		bridge.onPapoEvent(papoMessage('pm1', 'olá https://example.com/a', { embeds: [linkPreview('primeiro'), linkPreview('segundo')] }));
		await settle();

		const embeds = discord.sends[0]!.embeds;
		expect(embeds).toHaveLength(2);
		expect(embeds[0]!.author?.name).toBe('u');
		expect(embeds[0]!.description).toContain('olá');
		expect(embeds[1]!.title).toBe('primeiro');
		expect(embeds[1]!.url).toBe('https://example.com/artigo');
		// o Papo não expõe a imagem do embed por URL: a ponte re-hospeda e o Discord aponta para cá
		expect(embeds[1]!.thumbnail?.url).toMatch(/^http:\/\/media\.local:8080\/media\/[0-9a-f]{64}\.webp$/);
	});

	it('URL de GIF de provedor é encaminhada sem resolução local', async () => {
		const { bridge, discord, settle } = fixture();
		const url = 'https://giphy.com/gifs/3oEdV9QtPEA95';

		bridge.onPapoEvent(papoMessage('pm1', url));
		await settle();

		const embeds = discord.sends[0]!.embeds;
		expect(embeds).toHaveLength(1);
		expect(embeds[0]!.description).toContain(url);
	});

	it('mensagem sem preview sai com um único embed', async () => {
		const { bridge, discord, outbox, settle } = fixture();

		bridge.onPapoEvent(papoMessage('pm1', 'sem link'));
		await settle();

		expect(discord.sends[0]!.embeds).toHaveLength(1);
		expect(outbox.counts().dead).toBe(0);
	});

	it('avatar e mídia do preview são anexados uma única vez', async () => {
		const { bridge, discord, settle } = fixture({ avatar: true, mediaBaseUrl: null });

		bridge.onPapoEvent(papoMessage('pm1', 'olá https://example.com/a', { embeds: [linkPreview('artigo')] }));
		await settle();

		const files = discord.sends[0]!.files;
		// sem media server público o avatar do cartão é um anexo referenciado; reenviá-lo pelo
		// caminho das referências deixa uma cópia sem embed consumindo-a, e o Discord desenha
		// no corpo da mensagem todo arquivo órfão — uma foto grande do avatar
		expect(files.filter((f) => f.startsWith('avatar-'))).toHaveLength(1);
		expect(files.filter((f) => f.startsWith('media-'))).toHaveLength(1);
		expect(discord.sends[0]!.embeds[0]!.author?.icon_url).toMatch(/^attachment:\/\/avatar-[0-9a-f]{64}\.png$/);
	});
});

describe('message_embeds_update', () => {
	const embedsEvent = (messageId: string, embeds: unknown[] | null) =>
		({ type: 'message_embeds_update', channel_id: 'chan-1', message_id: messageId, embeds }) as never;

	it('preview que chega antes do mapeamento não é perdido', async () => {
		const { store, bridge, discord, settle } = fixture();

		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('artigo')]));
		await settle(200);
		// a cópia ainda não existe: o evento fica adiado, não descartado
		expect(store.peekDeferredEvents('papo', 'pm1')).toHaveLength(1);
		expect(discord.edits).toEqual([]);

		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();

		expect(store.peekDeferredEvents('papo', 'pm1')).toEqual([]);
		expect(discord.sends[0]!.embeds).toHaveLength(1);
		// o preview aparece assim que a cópia é criada
		const last = discord.edits.at(-1)!;
		expect(last.messageId).toBe('d1');
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds[0]!.author?.name).toBe('u');
		expect(last.embeds[1]!.title).toBe('artigo');
	});

	it('preview repetido não duplica o embed no destino', async () => {
		const { bridge, discord, settle } = fixture();
		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();

		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('artigo')]));
		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('artigo')]));
		await settle();

		const last = discord.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds.filter((e) => e.title === 'artigo')).toHaveLength(1);
	});

	it('conteúdo novo substitui o preview anterior', async () => {
		const { bridge, discord, settle } = fixture();
		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();

		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('primeiro')]));
		await settle();
		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('segundo')]));
		await settle();

		const last = discord.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds[1]!.title).toBe('segundo');
	});

	it('remoção do preview reescreve a cópia só com o cartão', async () => {
		const { store, bridge, discord, settle } = fixture();
		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();
		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('artigo')]));
		await settle();
		expect(discord.edits.at(-1)!.embeds).toHaveLength(2);

		bridge.onPapoEvent(embedsEvent('pm1', null));
		await settle();

		const last = discord.edits.at(-1)!;
		expect(last.embeds).toHaveLength(1);
		expect(last.embeds[0]!.author?.name).toBe('u');
		expect(last.embeds[0]!.description).toContain('olá');
		expect(store.findMapByPapo('pm1')[0]!.link_embeds).toBe('[]');
	});

	it('duas atualizações fora de ordem: a mais recente é a que fica no destino', async () => {
		// a atualização antiga tem a mídia mais lenta para buscar; ainda assim não pode chegar por último
		const { store, bridge, discord, settle } = fixture({ embedImageDelayMs: 300 });
		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();

		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('antiga-lenta', 'https://example.com/antiga')]));
		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('nova-rapida', 'https://example.com/nova')]));
		await settle();

		const last = discord.edits.at(-1)!;
		expect(last.embeds[1]!.title).toBe('nova-rapida');
		expect(store.findMapByPapo('pm1')[0]!.link_embeds).toContain('nova-rapida');
	});

	it('revisão mais antiga executada depois não reverte o preview mais recente', async () => {
		const { store, outbox, bridge, link, discord, settle } = fixture();
		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();
		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('nova')]));
		await settle();

		const before = discord.edits.length;
		outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'edit',
			dedupeKey: 'papo-embeds:pm1:0:atrasada',
			revision: '2026-10-09T10:00:00Z',
			payload: {
				job: {
					kind: 'edit',
					side: 'papo',
					linkId: link.id,
					sourceMessageId: 'pm1',
					targetChannelId: '111',
					chunkIndex: 0,
					chunkTotal: 1,
					text: '',
					revision: '2026-10-09T10:00:00Z'
				},
				embedsOnly: true,
				papoEmbeds: [linkPreview('antiga')]
			}
		});
		await bridge.drain();
		await settle(200);

		expect(discord.edits).toHaveLength(before);
		expect(store.findMapByPapo('pm1')[0]!.link_embeds).toContain('nova');
	});

	it('o preview sobrevive ao refresh do resumo de reações e não apaga o cartão', async () => {
		const { bridge, discord, settle } = fixture();
		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();
		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('artigo')]));
		await settle();

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: null, unicode: '👍', count: 3 } as never);
		await settle();

		const last = discord.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds[0]!.description).toContain('👍 3');
		expect(last.embeds[0]!.description).toContain('olá');
		expect(last.embeds[1]!.title).toBe('artigo');
	});

	it('edição do texto mantém o preview junto do cartão', async () => {
		const { bridge, discord, settle } = fixture();
		bridge.onPapoEvent(papoMessage('pm1', 'olá'));
		await settle();
		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('artigo')]));
		await settle();

		bridge.onPapoEvent({ type: 'message_edit', id: 'pm1', channel_id: 'chan-1', content: 'editado', edited_at: '2026-10-09T18:10:00Z' } as never);
		await settle();

		const last = discord.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds[0]!.description).toContain('editado');
		expect(last.embeds[1]!.title).toBe('artigo');
	});

	it('orçamento de caracteres: o cartão continua primeiro mesmo com o preview extra', async () => {
		const { bridge, discord, outbox, settle } = fixture();
		bridge.onPapoEvent(papoMessage('pm1', 'a'.repeat(3500)));
		await settle();

		bridge.onPapoEvent(embedsEvent('pm1', [linkPreview('artigo')]));
		await settle();

		const last = discord.edits.at(-1)!;
		expect(last.embeds[0]!.author?.name).toBe('u');
		expect(last.embeds[0]!.description).toContain('aaaa');
		expect(outbox.counts().dead).toBe(0);
	});
});

/** Preview em componentes: o formato que o Discord usa hoje para link de mídia (fixture do HAR). */
const ogInstagramPreview = () => ({
	type: 'components',
	url: 'https://www.oginstagram.com/reel/DeSKFT8BTKO/',
	components: [
		{
			type: 17,
			accent_color: 16711785,
			components: [
				{ type: 10, content: '**South America Memes** <:verified:1556598045670514798>' },
				{ type: 10, content: 'ligando pra nada só pro feriado segunda-feira 👿👿' },
				{
					type: 12,
					items: [
						{
							media: {
								url: 'https://www.oginstagram.com/offload/DeSKFT8BTKO/1?v=2',
								proxy_url: 'https://images-ext-1.discordapp.net/external/_8DS/https/www.oginstagram.com/offload/DeSKFT8BTKO/1',
								width: 720,
								height: 1280,
								content_type: 'video/mp4'
							}
						}
					]
				}
			]
		}
	]
});

const videoPreview = () => ({
	id: 'e-video',
	source_type: 'link',
	site_name: 'X',
	url: 'https://x.com/i/status/1',
	title: 'Vídeo',
	description: 'resumo do vídeo',
	thumbnail: { width: 720, height: 1280, mime_type: 'image/webp' },
	video: { url: 'https://video.twimg.com/amplify_video/1/avc1/1280x720/x.mp4', mime_type: 'video/mp4' }
});

const youtubePreview = () => ({
	id: 'e-youtube',
	source_type: 'link',
	fetch_method: 'oembed',
	provider: 'YouTube',
	url: 'https://www.youtube.com/watch?v=dwK9fhsOGK8',
	title: 'Novo projeto: Cachaça Pinga Reactor 4',
	thumbnail: { width: 480, height: 360, mime_type: 'image/webp' },
	video: { url: 'https://www.youtube.com/embed/dwK9fhsOGK8' }
});

const withFetch = async <T>(handler: (url: string) => Promise<Response>, run: () => Promise<T>): Promise<{ result: T; urls: string[] }> => {
	const original = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		const url = String(input);
		urls.push(url);
		return handler(url);
	}) as never;
	try {
		return { result: await run(), urls };
	} finally {
		globalThis.fetch = original;
	}
};

describe('preview do Discord que chega depois da mensagem', () => {
	it('MESSAGE_UPDATE com hyperlink mantém o preview nativo e não converte o embed', async () => {
		const { bridge, api, settle } = fixture();
		const url = 'https://www.oginstagram.com/reel/DeSKFT8BTKO/';

		await bridge.onDiscordMessage(discordMessage('dm-1', url, { authorBot: false }));
		await settle();
		expect(api.sent[0]!.embeds).toHaveLength(1);

		await bridge.onDiscordEdit(
			{} as never,
			discordMessage('dm-1', url, { authorBot: false, embeds: [ogInstagramPreview()] })
		);
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(1);
		expect(last.embeds[0]!.author?.name).toBe('Jenga');
		expect(last.embeds[0]!.description).toBe('');
		expect(last.content).toContain(url);
		expect(last.embeds.some((e) => e.title === 'South America Memes')).toBe(false);
	});

	it('hyperlink do Discord não é persistido como embed do bridge nas edições', async () => {
		const { store, bridge, api, settle } = fixture();
		const url = 'https://www.oginstagram.com/reel/DeSKFT8BTKO/';
		await bridge.onDiscordMessage(discordMessage('dm-1', url, { authorBot: false }));
		await settle();
		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', url, { authorBot: false, embeds: [ogInstagramPreview()] }));
		await settle();

		expect(store.findMapByDiscord('dm-1')[0]!.link_embeds).toBeFalsy();

		await bridge.onDiscordEdit(
			{} as never,
			discordMessage('dm-1', 'texto corrigido', { authorBot: false, embeds: [ogInstagramPreview()] })
		);
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(1);
		expect(last.embeds[0]!.description).toBe('');
		expect(last.content).toContain('texto corrigido');
		expect(last.content).toContain(url);
	});

	it('MESSAGE_UPDATE repetido não duplica o hyperlink como embed', async () => {
		const { bridge, api, settle } = fixture();
		const url = 'https://www.oginstagram.com/reel/DeSKFT8BTKO/';
		await bridge.onDiscordMessage(discordMessage('dm-1', url, { authorBot: false }));
		await settle();

		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', url, { authorBot: false, embeds: [ogInstagramPreview()] }));
		await settle();
		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', url, { authorBot: false, embeds: [ogInstagramPreview()] }));
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(1);
		expect(last.embeds.some((e) => e.title === 'South America Memes')).toBe(false);
	});

	it('URL de preview que chega tarde é inserida mesmo com edições de texto desligadas', async () => {
		const { bridge, api, settle } = fixture({ bridgeEdits: false });
		const content = 'abrindo uma página';
		await bridge.onDiscordMessage(discordMessage('dm-late-native', content, { authorBot: false }));
		await settle();

		await bridge.onDiscordEdit(
			{} as never,
			discordMessage('dm-late-native', content, { authorBot: false, embeds: [richPreview('nativo-tardio')] })
		);
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(1);
		expect(last.embeds[0]!.description).toBe('');
		expect(last.content).toContain('abrindo uma página');
		expect(last.content).toContain('https://example.com/nativo-tardio');
	});

	it('hyperlink recebido antes do mapeamento não gera embed adiado', async () => {
		const { store, bridge, api, outbox, settle } = fixture({ bridgeEdits: false });
		const url = 'https://www.oginstagram.com/reel/DeSKFT8BTKO/';

		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', url, { authorBot: false, embeds: [ogInstagramPreview()] }));
		expect(store.peekDeferredEvents('discord', 'dm-1')).toEqual([]);

		await bridge.onDiscordMessage(discordMessage('dm-1', url, { authorBot: false }));
		await settle();

		expect(store.peekDeferredEvents('discord', 'dm-1')).toEqual([]);
		expect(api.sent[0]!.embeds).toHaveLength(1);
		expect(outbox.counts().dead).toBe(0);
	});

	it('embed personalizado de bot sem hyperlink é convertido quando chega por edição', async () => {
		const { bridge, api, settle } = fixture();
		await bridge.onDiscordMessage(discordMessage('dm-1', 'status do serviço', { authorBot: true }));
		await settle();

		await bridge.onDiscordEdit(
			{} as never,
			discordMessage('dm-1', 'status do serviço', { authorBot: true, embeds: [ogInstagramPreview()] })
		);
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds[1]!.title).toBe('South America Memes');
	});
	
	it.each([
		['Tenor', 'https://tenor.com/view/funny-gif-1234567890', 'https://media.tenor.com/abc/tenor.gif'],
		['Giphy', 'https://giphy.com/gifs/lkdH8FmImcGoylv3t3', 'https://media.giphy.com/media/lkdH8FmImcGoylv3t3/giphy.gif'],
		['Klipy', 'https://klipy.com/gifs/some-gif', 'https://static.klipy.com/gifs/some-gif.gif']
	])('%s URL is sent cleanly for backend crawling, without a duplicate provider embed', async (_provider, url, mediaUrl) => {
		const { bridge, api, settle } = fixture();

		await bridge.onDiscordMessage(
			discordMessage('dm-1', url, {
				embeds: [
					{
						type: 'rich',
						url,
						title: 'GIF',
						image: {
							url: mediaUrl,
							proxy_url: 'https://images-ext-1.discordapp.net/external/proxy/gif.gif',
							width: 300,
							height: 224,
							content_type: 'image/gif'
						}
					}
				]
			})
		);
		await settle();

		// O backend recebe a URL original no campo content; o bridge envia só o card de autoria.
		expect(api.sent[0]!.content).toBe(url);
		expect(api.sent[0]!.embeds).toHaveLength(1);
		expect(api.sent[0]!.embeds![0]!.description).toBe('');
	});

	it('uses the clean provider page URL when Discord sends only an embed', async () => {
		const { bridge, api, settle } = fixture();
		const url = 'https://klipy.com/gifs/source-only';

		await bridge.onDiscordMessage(
			discordMessage('dm-embed-only', '', {
				authorBot: false,
				embeds: [
					{
						type: 'rich',
						url,
						title: 'GIF',
						image: { url: 'https://static.klipy.com/gifs/source-only.gif', content_type: 'image/gif' }
					}
				]
			})
		);
		await settle();

		expect(api.sent[0]!.content).toBe(url);
		expect(api.sent[0]!.embeds).toHaveLength(1);
	});

});

describe('mídia do preview no Discord', () => {
	it('preview com mp4 vira anexo da mensagem: é o anexo que traz o player', async () => {
		const { bridge, discord, settle } = fixture();
		const { urls } = await withFetch(
			async () => new Response(Buffer.from('bytes-do-mp4'), { status: 200, headers: { 'content-type': 'video/mp4' } }),
			async () => {
				bridge.onPapoEvent(papoMessage('pm1', 'https://x.com/i/status/1', { embeds: [videoPreview()] }));
				await settle();
			}
		);

		expect(urls).toContain('https://video.twimg.com/amplify_video/1/avc1/1280x720/x.mp4');
		const send = discord.sends[0]!;
		expect(send.files).toEqual([expect.stringMatching(/^media-[0-9a-f]{64}\.mp4$/)]);
		expect(send.embeds[1]!.thumbnail?.url).toMatch(/^http:\/\/media\.local:8080\/media\/[0-9a-f]{64}\.webp$/);
		// o Discord ignora `video` em embed criado por bot: o payload não pode levar o campo
		expect(send.embeds[1]).not.toHaveProperty('video');
		expect(send.embeds[1]).not.toHaveProperty('media_refs');
	});

	it('sem media server público a thumbnail também vai como anexo', async () => {
		const { bridge, discord, settle } = fixture({ mediaBaseUrl: null });
		await withFetch(
			async () => new Response(Buffer.from('bytes-do-mp4'), { status: 200, headers: { 'content-type': 'video/mp4' } }),
			async () => {
				bridge.onPapoEvent(papoMessage('pm1', 'https://x.com/i/status/1', { embeds: [videoPreview()] }));
				await settle();
			}
		);

		const send = discord.sends[0]!;
		expect(send.embeds[1]!.thumbnail?.url).toMatch(/^attachment:\/\/media-[0-9a-f]{64}\.webp$/);
		expect(send.files).toEqual([
			expect.stringMatching(/^media-[0-9a-f]{64}\.webp$/),
			expect.stringMatching(/^media-[0-9a-f]{64}\.mp4$/)
		]);
	});

	it('o edit reenvia a mídia do preview: o Discord resolve a referência no mesmo request', async () => {
		const { bridge, discord, settle } = fixture({ mediaBaseUrl: null });
		await withFetch(
			async () => new Response(Buffer.from('bytes-do-mp4'), { status: 200, headers: { 'content-type': 'video/mp4' } }),
			async () => {
				bridge.onPapoEvent(papoMessage('pm1', 'https://x.com/i/status/1', { embeds: [videoPreview()] }));
				await settle();
				bridge.onPapoEvent({ type: 'message_edit', id: 'pm1', channel_id: 'chan-1', content: 'editado', edited_at: '2026-10-09T18:10:00Z' } as never);
				await settle();
			}
		);

		const last = discord.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.files).toEqual([
			expect.stringMatching(/^media-[0-9a-f]{64}\.webp$/),
			expect.stringMatching(/^media-[0-9a-f]{64}\.mp4$/)
		]);
	});

	it('página de player (YouTube) não é arquivo: nada é baixado, o preview segue com a thumbnail', async () => {
		const { bridge, discord, settle } = fixture();
		const { urls } = await withFetch(
			async () => new Response(Buffer.from('html'), { status: 200, headers: { 'content-type': 'text/html' } }),
			async () => {
				bridge.onPapoEvent(papoMessage('pm1', 'https://www.youtube.com/watch?v=dwK9fhsOGK8', { embeds: [youtubePreview()] }));
				await settle();
			}
		);

		expect(urls).toEqual([]);
		const send = discord.sends[0]!;
		expect(send.files).toEqual([]);
		expect(send.embeds[1]!.url).toBe('https://www.youtube.com/watch?v=dwK9fhsOGK8');
		expect(send.embeds[1]!.thumbnail?.url).toMatch(/^http:\/\/media\.local:8080\/media\/[0-9a-f]{64}\.webp$/);
	});

	it('vídeo que não cabe no limite do Discord fica de fora, e o preview continua', async () => {
		const { bridge, discord, outbox, settle } = fixture({ maxFileBytes: 8 });
		await withFetch(
			async () => new Response(Buffer.from('mp4-maior-que-o-limite'), { status: 200, headers: { 'content-type': 'video/mp4' } }),
			async () => {
				bridge.onPapoEvent(papoMessage('pm1', 'https://x.com/i/status/1', { embeds: [videoPreview()] }));
				await settle();
			}
		);

		const send = discord.sends[0]!;
		expect(send.files).toEqual([]);
		expect(send.embeds).toHaveLength(2);
		expect(send.embeds[1]!.title).toBe('Vídeo');
		expect(outbox.counts().dead).toBe(0);
	});
});

describe('mídia hospedada pelo Discord vira anexo no Papo', () => {
	/**
	 * `cdn.discordapp.com` / `media.discordapp.net` expiram junto com a mensagem original e o
	 * hotlink é bloqueado: o bridge baixa e re-envia como arquivo da mensagem do Papo.
	 */
	it('embed com mídia do CDN do Discord sai como arquivo baixado, não URL no card', async () => {
		const { bridge, api, settle } = fixture();
		const { urls } = await withFetch(
			async () => new Response(Buffer.from('imagem-do-discord'), { status: 200, headers: { 'content-type': 'image/png' } }),
			async () => {
				await bridge.onDiscordMessage(
					discordMessage('dm-1', 'olha a foto', {
						authorBot: false,
						embeds: [
							{
								type: 'image',
								url: 'https://cdn.discordapp.com/attachments/111/222/foto.png',
								title: 'foto.png',
								image: {
									url: 'https://cdn.discordapp.com/attachments/111/222/foto.png',
									proxy_url: 'https://media.discordapp.net/attachments/111/222/foto.png?ex=66&is=66&hm=aa',
									width: 400,
									height: 300,
									content_type: 'image/png'
								}
							}
						]
					})
				);
				await settle();
			}
		);

		const sent = api.sent[0]!;
		expect(sent.attachments?.map((a) => a.name)).toEqual(['foto.png']);
		// baixado do CDN, não do proxy assinado
		expect(urls).toContain('https://cdn.discordapp.com/attachments/111/222/foto.png');
		// o card da ponte é o único embed: o preview não acrescenta nada além de uma URL que quebra
		expect(sent.embeds ?? []).toHaveLength(1);
		expect(sent.embeds![0]!.description).toBe('');
		expect(sent.content).toContain('olha a foto');
	});

	it('link de arquivo do Discord colado no texto também vira anexo, e sai do texto', async () => {
		const { bridge, api, settle } = fixture();
		const { urls } = await withFetch(
			async () => new Response(Buffer.from('video-colado'), { status: 200, headers: { 'content-type': 'video/mp4' } }),
			async () => {
				await bridge.onDiscordMessage(discordMessage('dm-1', 'https://cdn.discordapp.com/attachments/111/222/clipe.mp4'));
				await settle();
			}
		);

		const sent = api.sent[0]!;
		expect(sent.attachments?.map((a) => a.name)).toEqual(['clipe.mp4']);
		expect(urls).toContain('https://cdn.discordapp.com/attachments/111/222/clipe.mp4');
		// o arquivo chegou: repetir embaixo uma URL que não abre fora do Discord é ruído
		expect(sent.embeds![0]!.description).not.toContain('cdn.discordapp.com');
	});

	it('com anexos desligados o link colado continua no texto: é o único transporte', async () => {
		const { store, bridge, api, link, settle } = fixture();
		store.setChannelLinkFlag(link.id, 'bridge_attachments', 0);
		await bridge.onDiscordMessage(discordMessage('dm-1', 'https://cdn.discordapp.com/attachments/111/222/clipe.mp4'));
		await settle();

		expect(api.sent[0]!.embeds![0]!.description).toBe('');
		expect(api.sent[0]!.content).toContain('https://cdn.discordapp.com/attachments/111/222/clipe.mp4');
	});

	it('a mesma mídia servida por outro host não é baixada duas vezes', async () => {
		const { bridge, api, settle } = fixture();
		await withFetch(
			async () => new Response(Buffer.from('gif-do-picker'), { status: 200, headers: { 'content-type': 'image/gif' } }),
			async () => {
				await bridge.onDiscordMessage(
					discordMessage('dm-1', 'gif', {
						authorBot: false,
						attachments: [{ id: 'att-1', name: 'gif.gif', url: 'https://cdn.discordapp.com/attachments/111/222/gif.gif', size: 12, contentType: 'image/gif' }],
						embeds: [
							{
								type: 'gifv',
								url: 'https://klipy.com/gifs/algo',
								title: 'GIF',
								image: { url: 'https://media.discordapp.net/attachments/111/222/gif.gif', width: 300, height: 224, content_type: 'image/gif' }
							}
						]
					})
				);
				await settle();
			}
		);

		expect(api.sent[0]!.attachments?.map((a) => a.name)).toEqual(['gif.gif']);
	});

	it('GIF que só existe como imagem do embed do Discord sobrevive animado como arquivo', async () => {
		const { bridge, api, settle } = fixture();
		await withFetch(
			async () => new Response(Buffer.from('gif-animado'), { status: 200, headers: { 'content-type': 'image/gif' } }),
			async () => {
				await bridge.onDiscordMessage(
					discordMessage('dm-1', 'olha o gif', {
						authorBot: false,
						embeds: [
							{
								type: 'image',
								url: 'https://cdn.discordapp.com/attachments/111/222/animado.gif',
								title: 'animado.gif',
								image: { url: 'https://cdn.discordapp.com/attachments/111/222/animado.gif', width: 300, height: 224, content_type: 'image/gif' }
							}
						]
					})
				);
				await settle();
			}
		);

		expect(api.sent[0]!.attachments?.map((a) => a.name)).toEqual(['animado.gif']);
	});

	it('com anexos desligados o preview continua com a URL (não há para onde re-hospedar)', async () => {
		const { store, bridge, api, link, settle } = fixture();
		store.setChannelLinkFlag(link.id, 'bridge_attachments', 0);
		await bridge.onDiscordMessage(
			discordMessage('dm-1', 'olha a foto', {
				authorBot: false,
				embeds: [
					{
						type: 'image',
						url: 'https://cdn.discordapp.com/attachments/111/222/foto.png',
						title: 'foto.png',
						image: { url: 'https://cdn.discordapp.com/attachments/111/222/foto.png', width: 400, height: 300, content_type: 'image/png' }
					}
				]
			})
		);
		await settle();

		const sent = api.sent[0]!;
		expect(sent.attachments ?? []).toHaveLength(0);
		expect(sent.embeds ?? []).toHaveLength(1);
		expect(sent.content).toContain('https://cdn.discordapp.com/attachments/111/222/foto.png');
	});
});

describe('link de anexo do Discord com assinatura vencida', () => {
	/**
	 * O CDN só serve anexo com `?ex=&is=&hm=` válidos, e a assinatura vence em ~24h: um 404 não
	 * quer dizer que o arquivo morreu, quer dizer que o link venceu. O bridge renova a assinatura
	 * em `attachments/refresh-urls` antes de declarar a mídia perdida.
	 */
	const hex = (seconds: number) => seconds.toString(16);
	const now = () => Math.floor(Date.now() / 1000);
	const signed = (path: string, ttl: number) =>
		`https://cdn.discordapp.com/attachments/111/222/${path}?ex=${hex(now() + ttl)}&is=${hex(now())}&hm=beef`;

	it('GIF de favorito sem assinatura: renova o link e nem tenta o link vencido', async () => {
		const { bridge, api, discord, outbox, settle } = fixture();
		const unsigned = 'https://media.discordapp.net/attachments/223594824681521152/935544876509048852/image0-6.gif';
		const renewed = `https://cdn.discordapp.com/attachments/223594824681521152/935544876509048852/image0-6.gif?ex=${hex(now() + 86_400)}&is=${hex(now())}&hm=deadbeef`;
		discord.refreshMediaUrl = async () => renewed;

		const { urls } = await withFetch(
			async (url) =>
				url === renewed
					? new Response(Buffer.from('gif-vivo'), { status: 200, headers: { 'content-type': 'image/gif' } })
					: new Response('This content is no longer available.', { status: 404 }),
			async () => {
				await bridge.onDiscordMessage(
					discordMessage('dm-1', unsigned, {
						embeds: [
							{
								type: 'gifv',
								url: unsigned,
								title: 'image0-6.gif',
								image: { url: unsigned, width: 480, height: 480, content_type: 'image/gif' }
							}
						]
					})
				);
				await settle();
			}
		);

		expect(api.sent[0]?.attachments?.map((a) => a.name)).toEqual(['image0-6.gif']);
		// o link sem assinatura seria 404 certo: a renovação vem antes da primeira tentativa
		expect(urls).toEqual([renewed]);
		// e o texto não repete a URL quebrada embaixo do arquivo que chegou
		expect(api.sent[0]?.embeds?.[0]?.description).toBe('');
		expect(outbox.counts().dead).toBe(0);
	});

	it('404 com assinatura ainda válida também tenta renovar antes de desistir', async () => {
		const { bridge, api, discord, outbox, settle } = fixture();
		const fresh = signed('clipe.mp4', 3600);
		const renewed = signed('clipe.mp4', 86_400);
		discord.refreshMediaUrl = async () => renewed;

		const { urls } = await withFetch(
			async (url) =>
				url === renewed
					? new Response(Buffer.from('video-vivo'), { status: 200, headers: { 'content-type': 'video/mp4' } })
					: new Response('This content is no longer available.', { status: 404 }),
			async () => {
				await bridge.onDiscordMessage(discordMessage('dm-1', fresh));
				await settle();
			}
		);

		expect(api.sent[0]?.attachments?.map((a) => a.name)).toEqual(['clipe.mp4']);
		expect(urls).toEqual([fresh, renewed]);
		expect(outbox.counts().dead).toBe(0);
	});

	it('o mesmo arquivo enviado por pessoas diferentes renova a assinatura uma vez só', async () => {
		const { bridge, api, discord, settle } = fixture();
		const path = 'https://cdn.discordapp.com/attachments/223594824681521152/935544876509048852/image0-6.gif';
		const renewed = `${path}?ex=${hex(now() + 86_400)}&is=${hex(now())}&hm=deadbeef`;
		let refreshes = 0;
		discord.refreshMediaUrl = async () => {
			refreshes++;
			return renewed;
		};

		await withFetch(
			async (url) =>
				url === renewed
					? new Response(Buffer.from('gif'), { status: 200, headers: { 'content-type': 'image/gif' } })
					: new Response('This content is no longer available.', { status: 404 }),
			async () => {
				// assinaturas diferentes, o mesmo caminho: é o GIF de favorito que muita gente manda
				await bridge.onDiscordMessage(discordMessage('dm-1', `${path}?ex=1&is=1&hm=aa`));
				await bridge.onDiscordMessage(discordMessage('dm-2', `${path}?ex=2&is=2&hm=bb`));
				await settle();
			}
		);

		expect(refreshes).toBe(1);
		expect(api.sent.map((s) => s.attachments?.map((a) => a.name))).toEqual([['image0-6.gif'], ['image0-6.gif']]);
	});

	it('mídia que não existe mais vira aviso no texto: a mensagem continua bridgeada', async () => {
		const { bridge, api, outbox, settle } = fixture();
		await withFetch(
			async () => new Response('This content is no longer available.', { status: 404 }),
			async () => {
				await bridge.onDiscordMessage(
					discordMessage('dm-1', 'olha o gif', {
						embeds: [
							{
								type: 'image',
								url: 'https://cdn.discordapp.com/attachments/111/222/morto.gif',
								title: 'morto.gif',
								image: { url: 'https://cdn.discordapp.com/attachments/111/222/morto.gif', width: 300, height: 224, content_type: 'image/gif' }
							}
						]
					})
				);
				await settle();
			}
		);

		const sent = api.sent[0]!;
		expect(sent.attachments ?? []).toHaveLength(0);
		expect(sent.embeds![0]!.description).toBe('');
		expect(sent.content).toContain('olha o gif');
		expect(sent.content).toContain('morto.gif');
		expect(sent.content).toContain('não está mais disponível');
		// o job não vai para `dead`: perder um arquivo não é motivo para perder a mensagem
		expect(outbox.counts().dead).toBe(0);
	});

	it('429 do CDN é transitório: o bridge re-tenta em vez de descartar a mídia', async () => {
		const { bridge, api, outbox, settle } = fixture();
		await withFetch(
			async () => new Response(null, { status: 429 }),
			async () => {
				await bridge.onDiscordMessage(discordMessage('dm-1', signed('foto.png', 3600)));
				await settle();
			}
		);

		expect(api.sent).toHaveLength(0);
		// a fila do teste esgota as tentativas rápido: o que importa é que o 429 re-tentou,
		// em vez de virar "mídia indisponível" na primeira recusa
		const dead = outbox.list('dead');
		expect(dead).toHaveLength(1);
		expect(dead[0]!.attempts).toBeGreaterThan(1);
		expect(dead[0]!.last_error).toContain('429');
	});
});
