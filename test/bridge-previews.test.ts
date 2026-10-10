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
	embeds?: PapoEmbedInput[];
	attachments?: { name: string }[];
}

const fixture = (opts: { embedImageDelayMs?: number; mediaBaseUrl?: string | null; maxFileBytes?: number; bridgeEdits?: boolean } = {}) => {
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
		extFor: (sha: string) => mediaFiles.get(sha)?.ext ?? 'bin'
	};

	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u', nickname: null })),
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
		edits: [] as { id: string; embeds: EmbedLike[] }[],
		editMessage: async (id: string, _content: string, embeds: EmbedLike[]) => void api.edits.push({ id, embeds }),
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
		destroy: async () => {}
	};

	const bridge = new Bridge(config, store, outbox, api as never, { close: () => {}, connect: () => {} } as never, discord as never, media as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	if (opts.bridgeEdits === false) store.setChannelLinkFlag(link.id, 'bridge_edits', 0);
	const settle = (quietMs = 700) => settleQueue(outbox, quietMs, 6000);
	return { store, outbox, bridge, link, api, discord, settle };
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

const discordMessage = (id: string, content: string, extra: Record<string, unknown> = {}) =>
	({
		id,
		channelId: '111',
		channel: { isThread: () => false },
		author: { id: 'user-1', username: 'jenga', displayName: 'Jenga', displayAvatarURL: () => 'https://cdn.example.com/a.png' },
		member: { displayName: 'Jenga' },
		content,
		createdAt: new Date(),
		attachments: [],
		embeds: [],
		...extra
	}) as never;

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

describe('preview no bridge Discord → Papo', () => {
	it('texto + URL cria o cartão principal e um embed extra com o primeiro preview', async () => {
		const { bridge, api, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1', 'olá https://example.com/a', { embeds: [richPreview('primeiro'), richPreview('segundo')] }));
		await settle();

		const embeds = api.sent[0]!.embeds ?? [];
		expect(embeds).toHaveLength(2);
		// o cartão da ponte continua primeiro: autor, texto e rodapé da mensagem bridgeada
		expect(embeds[0]!.author?.name).toBe('Jenga');
		expect(embeds[0]!.description).toContain('olá');
		// o preview entra atrás, sem substituir o cartão
		expect(embeds[1]!.title).toBe('primeiro');
		expect(embeds[1]!.url).toBe('https://example.com/primeiro');
		expect(embeds[1]!.thumbnail?.url).toBe('https://example.com/primeiro/thumb.png');
	});

	it('mensagem sem preview não ganha embed vazio', async () => {
		const { bridge, api, outbox, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('dm-1', 'sem link'));
		await settle();

		expect(api.sent).toHaveLength(1);
		expect(api.sent[0]!.embeds).toHaveLength(1);
		expect(outbox.counts().dead).toBe(0);
	});

	it('preview que não converte não derruba a mensagem', async () => {
		const { bridge, api, outbox, settle } = fixture();

		await bridge.onDiscordMessage(
			discordMessage('dm-1', 'texto', { embeds: [{ type: 'unknown' }, { type: 'rich', url: 'https://example.com/x', title: 'convertível' }] })
		);
		await settle();

		const embeds = api.sent[0]!.embeds ?? [];
		expect(embeds[0]!.description).toContain('texto');
		expect(embeds[1]!.title).toBe('convertível');
		expect(outbox.counts().dead).toBe(0);
	});

	it('anexo e preview convivem: o cartão não perde o arquivo nem o preview', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(Buffer.from('conteúdo'), { status: 200 });
		try {
			const { bridge, api, settle } = fixture();
			await bridge.onDiscordMessage(
				discordMessage('dm-1', 'com anexo', {
					attachments: [{ id: 'a1', name: 'nota.txt', contentType: 'text/plain', size: 9, url: 'https://cdn.example.com/nota.txt' }],
					embeds: [richPreview('artigo')]
				})
			);
			await settle();

			expect(api.sent[0]!.attachments?.map((a) => a.name)).toEqual(['nota.txt']);
			expect(api.sent[0]!.embeds).toHaveLength(2);
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

		await bridge.onDiscordMessage(discordMessage('dm-1', 'olá', { embeds: [richPreview('artigo')] }));
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

	it('GIF do picker do Papo vira imagem no Discord, sem o marcador cru', async () => {
		const { bridge, discord, settle } = fixture();

		bridge.onPapoEvent(papoMessage('pm1', 'giphy:3oEdV9QtPEA95'));
		await settle();

		const embeds = discord.sends[0]!.embeds;
		expect(embeds).toHaveLength(2);
		expect(embeds[1]!.image?.url).toBe('https://media.giphy.com/media/3oEdV9QtPEA95/giphy.gif');
		expect(embeds[1]!.url).toBe('https://giphy.com/gifs/3oEdV9QtPEA95');
		// o marcador não pode chegar como texto no Discord
		expect(embeds[0]!.description).not.toContain('giphy:');
	});

	it('mensagem sem preview sai com um único embed', async () => {
		const { bridge, discord, outbox, settle } = fixture();

		bridge.onPapoEvent(papoMessage('pm1', 'sem link'));
		await settle();

		expect(discord.sends[0]!.embeds).toHaveLength(1);
		expect(outbox.counts().dead).toBe(0);
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
	it('MESSAGE_UPDATE com o link-preview aplica o preview à cópia do Papo', async () => {
		const { bridge, api, settle } = fixture();

		// o Discord cria a mensagem sem o preview: a cópia sai só com o cartão
		await bridge.onDiscordMessage(discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/'));
		await settle();
		expect(api.sent[0]!.embeds).toHaveLength(1);

		await bridge.onDiscordEdit(
			{} as never,
			discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/', { embeds: [ogInstagramPreview()] })
		);
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		// o cartão continua primeiro e intacto; o preview entra atrás
		expect(last.embeds[0]!.author?.name).toBe('Jenga');
		expect(last.embeds[0]!.description).toContain('oginstagram');
		expect(last.embeds[1]!.title).toBe('South America Memes');
		expect(last.embeds[1]!.description).toContain('ligando pra nada');
		// o mp4 do carrossel vira vídeo no Papo: é o que faz o preview ter player
		expect(last.embeds[1]!.video?.mime_type).toBe('video/mp4');
		expect(last.embeds[1]!.video?.url).toContain('oginstagram.com/offload/DeSKFT8BTKO/1');
	});

	it('preview do Discord fica no mapa e sobrevive às edições seguintes', async () => {
		const { store, bridge, api, settle } = fixture();
		await bridge.onDiscordMessage(discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/'));
		await settle();
		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/', { embeds: [ogInstagramPreview()] }));
		await settle();

		expect(JSON.parse(store.findMapByDiscord('dm-1')[0]!.link_embeds!) as EmbedLike[]).toHaveLength(1);

		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', 'texto corrigido', { embeds: [ogInstagramPreview()] }));
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds[0]!.description).toContain('texto corrigido');
		expect(last.embeds[1]!.title).toBe('South America Memes');
	});

	it('MESSAGE_UPDATE repetido não duplica o preview', async () => {
		const { bridge, api, settle } = fixture();
		await bridge.onDiscordMessage(discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/'));
		await settle();

		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/', { embeds: [ogInstagramPreview()] }));
		await settle();
		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/', { embeds: [ogInstagramPreview()] }));
		await settle();

		const last = api.edits.at(-1)!;
		expect(last.embeds.filter((e) => e.title === 'South America Memes')).toHaveLength(1);
	});

	it('preview que chega antes do mapeamento espera a cópia em vez de se perder', async () => {
		const { store, bridge, api, outbox, settle } = fixture({ bridgeEdits: false });

		// o MESSAGE_UPDATE chega antes do MESSAGE_CREATE bridgeado: sem destino, o preview fica
		// adiado e é enfileirado pelo flush que acompanha a criação do mapeamento
		await bridge.onDiscordEdit({} as never, discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/', { embeds: [ogInstagramPreview()] }));
		expect(store.peekDeferredEvents('discord', 'dm-1').map((e) => e.kind)).toEqual(['embeds']);

		await bridge.onDiscordMessage(discordMessage('dm-1', 'https://www.oginstagram.com/reel/DeSKFT8BTKO/'));
		await settle();

		expect(store.peekDeferredEvents('discord', 'dm-1')).toEqual([]);
		const last = api.edits.at(-1)!;
		expect(last.embeds).toHaveLength(2);
		expect(last.embeds[1]!.title).toBe('South America Memes');
		expect(outbox.counts().dead).toBe(0);
	});

	it('GIF que só existe como imagem do embed vai como arquivo animado', async () => {
		const { bridge, api, settle } = fixture();
		const { urls } = await withFetch(
			async () => new Response(Buffer.from('gif-animado'), { status: 200, headers: { 'content-type': 'image/gif' } }),
			async () => {
				await bridge.onDiscordMessage(
					discordMessage('dm-1', 'https://giphy.com/gifs/lkdH8FmImcGoylv3t3', {
						embeds: [
							{
								type: 'rich',
								url: 'https://giphy.com/gifs/lkdH8FmImcGoylv3t3',
								title: 'GIF',
								image: {
									url: 'https://media.giphy.com/media/lkdH8FmImcGoylv3t3/giphy.gif',
									proxy_url: 'https://images-ext-1.discordapp.net/external/ZgLT/https/media.giphy.com/media/lkdH8FmImcGoylv3t3/giphy.gif',
									width: 300,
									height: 224,
									content_type: 'image/gif'
								}
							}
						]
					})
				);
				await settle();
			}
		);

		// o Papo re-encode a imagem do embed como thumbnail estática: animação só sobrevive como arquivo
		expect(api.sent[0]!.attachments?.map((a) => a.name)).toEqual(['lkdH8FmImcGoylv3t3-giphy.gif']);
		expect(urls.some((u) => u.includes('giphy.gif'))).toBe(true);
		const preview = api.sent[0]!.embeds![1]!;
		expect(preview.title).toBe('GIF');
		expect(preview.thumbnail).toBeUndefined();
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
