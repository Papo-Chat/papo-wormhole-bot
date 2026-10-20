import { describe, expect, it } from 'vitest';
import {
	attachmentRefName,
	discordApiEmbed,
	discordEmbedMedia,
	discordEmbedsToPapo,
	papoEmbedsToDiscord,
	shaFromAttachmentRef,
	type DiscordEmbedPayload
} from '../src/bridge/embeds.js';
import { firstDiscordPreview, rawDiscordEmbeds } from '../src/bridge/previews.js';
import type { PapoEmbed } from '../src/papo/types.js';

/**
 * Mídia dos previews de link, nos dois sentidos.
 *
 * As fixtures vêm dos HARs reais (`traces/`): é o shape que o Discord devolve ao ler uma
 * mensagem — inclusive o preview novo em `components`, que o picker e o Instagram usam.
 */

const asEmbed = (e: Record<string, unknown>): DiscordEmbedPayload => e as unknown as DiscordEmbedPayload;
const first = (e: Record<string, unknown>) => discordEmbedsToPapo([asEmbed(e)])[0] ?? {};

/** GIF do picker Klipy no Discord: `gifv` com vídeo mp4 e thumbnail webp estática. */
const klipyGifv = () => ({
	type: 'gifv',
	provider: { name: 'Klipy', url: 'https://klipy.com' },
	url: 'https://klipy.com/gifs/orihime-bread-girl',
	title: 'Orihime: The Bread Bag Girl',
	thumbnail: {
		url: 'https://static.klipy.com/ii/d7ae/DT0Dl1xZ.webp',
		proxy_url: 'https://images-ext-1.discordapp.net/external/CF8k/https/static.klipy.com/ii/d7ae/DT0Dl1xZ.webp',
		width: 498,
		height: 498
	},
	video: {
		url: 'https://static.klipy.com/ii/d7ae/vTXuDBugGeZn6Djx.mp4',
		proxy_url: 'https://images-ext-1.discordapp.net/external/P17-/https/static.klipy.com/ii/d7ae/vTXuDBugGeZn6Djx.mp4',
		width: 640,
		height: 640
	}
});

/** YouTube no Discord: `video` com página de player no `video.url` (não é arquivo). */
const youtubeVideo = () => ({
	type: 'video',
	provider: { name: 'YouTube', url: 'https://www.youtube.com' },
	url: 'https://www.youtube.com/watch?v=dwK9fhsOGK8',
	title: 'Novo projeto: Cachaça Pinga Reactor 4',
	description: 'Obrigado governo federal pela inovação tecnológica.',
	author: { name: 'Aleatoriedades Cíclicas', url: 'https://www.youtube.com/channel/UChP4N8e' },
	thumbnail: {
		url: 'https://i.ytimg.com/vi/dwK9fhsOGK8/hqdefault.jpg',
		proxy_url: 'https://images-ext-1.discordapp.net/external/1f17/https/i.ytimg.com/vi/dwK9fhsOGK8/hqdefault.jpg',
		width: 480,
		height: 360,
		content_type: 'image/jpeg'
	},
	video: { url: 'https://www.youtube.com/embed/dwK9fhsOGK8', width: 1280, height: 720 }
});

/** GitHub no Discord: `article` com og:image. */
const githubArticle = () => ({
	type: 'article',
	provider: { name: 'GitHub' },
	url: 'https://github.com/Papo-Chat/papo-backend',
	title: 'GitHub - Papo-Chat/papo-backend',
	description: 'O backend oficial da aplicação Web Papo.',
	thumbnail: {
		url: 'https://opengraph.githubassets.com/c6b1/Papo-Chat/papo-backend',
		proxy_url: 'https://images-ext-1.discordapp.net/external/Z7-J/https/opengraph.githubassets.com/c6b1/Papo-Chat/papo-backend',
		width: 1200,
		height: 600,
		content_type: 'image/png'
	}
});

/** Instagram no Discord: o preview novo, em componentes (texto + avatar + carrossel de vídeo). */
const ogInstagramComponents = () => ({
	type: 'components',
	url: 'https://www.oginstagram.com/reel/DeSKFT8BTKO/',
	components: [
		{
			type: 17,
			id: 1,
			accent_color: 16711785,
			components: [
				{
					type: 9,
					components: [
						{
							type: 10,
							content:
								'**South America Memes** <:verified:1556598045670514798>\n[@southamericamemes](https://www.instagram.com/southamericamemes/)\n\n❤️ **15,309**  💬 **135**'
						}
					],
					accessory: {
						type: 11,
						media: {
							url: 'https://www.oginstagram.com/offload/DeSKFT8BTKO/avatar?v=2',
							proxy_url: 'https://images-ext-1.discordapp.net/external/UR0M/%3Fv%3D2/https/www.oginstagram.com/offload/DeSKFT8BTKO/avatar',
							width: 150,
							height: 150,
							content_type: 'image/jpeg'
						}
					}
				},
				{ type: 10, content: 'ligando pra nada só pro feriado segunda-feira 👿👿' },
				{
					type: 12,
					items: [
						{
							media: {
								url: 'https://www.oginstagram.com/offload/DeSKFT8BTKO/1?v=2',
								proxy_url:
									'https://images-ext-1.discordapp.net/external/_8DS/%3Fv%3D2/https/www.oginstagram.com/offload/DeSKFT8BTKO/1',
								width: 720,
								height: 1280,
								content_type: 'video/mp4'
							}
						}
					]
				},
				{ type: 10, content: '-# <:OGInstagram:1556597080229810266> OGInstagram · <t:1791570606:s>' },
				{ type: 1, components: [{ type: 2, style: 5, label: '📷 Instagram', url: 'https://www.instagram.com/reel/DeSKFT8BTKO/' }] }
			]
		}
	]
});

/**
 * GIF de Twitter no Discord pelo espelho vxTwitter/fixvx: o preview é `rich` e o `image` é um
 * conversor avif **carregando o mp4 de verdade no query**. O avif não está na allowlist do Papo.
 */
const vxTwitterGif = () => ({
	type: 'rich',
	url: 'https://vxtwitter.com/hardestgifs/status/2108436160964136985',
	description: 'https://t.co/rGCV8x7bXD',
	color: 1942002,
	author: {
		name: 'Hardest GIFs 🔥 (@hardestgifs)',
		url: 'https://x.com/hardestgifs/status/2108436160964136985',
		icon_url: 'https://pbs.twimg.com/profile_images/1640140330/breakdance_normal.gif',
		proxy_icon_url: 'https://images-ext-1.discordapp.net/external/LG_uv/https/pbs.twimg.com/profile_images/1640140330/breakdance_normal.gif'
	},
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

describe('preview do Discord → Papo: mídia', () => {
	it('GIF Klipy leva o vídeo mp4: a thumbnail webp é estática e não representa o GIF', () => {
		const embed = first(klipyGifv());
		expect(embed.video?.url).toBe('https://images-ext-1.discordapp.net/external/P17-/https/static.klipy.com/ii/d7ae/vTXuDBugGeZn6Djx.mp4');
		expect(embed.video?.mime_type).toBe('video/mp4');
		expect(embed.title).toBe('Orihime: The Bread Bag Girl');
		expect(embed.url).toBe('https://klipy.com/gifs/orihime-bread-girl');
	});

	it('GIF do picker no tipo novo do Discord (`gif`) também entra como preview', () => {
		const preview = firstDiscordPreview([
			asEmbed({
				type: 'gif',
				url: 'https://klipy.com/gifs/orihime',
				title: 'Orihime',
				video: {
					url: 'https://static.klipy.com/ii/d7ae/vTXu.mp4',
					proxy_url: 'https://images-ext-1.discordapp.net/external/P17/https/static.klipy.com/ii/d7ae/vTXu.mp4',
					width: 640,
					height: 640
				}
			}) as never
		]);
		expect(preview?.video?.mime_type).toBe('video/mp4');
	});

	it('o proxy do Discord tem prioridade sobre a URL da origem', () => {
		const embed = first(githubArticle());
		expect(embed.thumbnail?.url).toBe('https://images-ext-1.discordapp.net/external/Z7-J/https/opengraph.githubassets.com/c6b1/Papo-Chat/papo-backend');
	});

	it('YouTube vira cartão com thumbnail e link, sem vídeo: página de player não é arquivo', () => {
		const embed = first(youtubeVideo());
		expect(embed.video).toBeUndefined();
		expect(embed.title).toBe('Novo projeto: Cachaça Pinga Reactor 4');
		expect(embed.author?.name).toBe('Aleatoriedades Cíclicas');
		expect(embed.thumbnail?.url).toContain('i.ytimg.com/vi/dwK9fhsOGK8/hqdefault.jpg');
		expect(embed.url).toBe('https://www.youtube.com/watch?v=dwK9fhsOGK8');
	});

	it('article do GitHub vira preview com título, descrição e imagem', () => {
		const embed = first(githubArticle());
		expect(embed.title).toBe('GitHub - Papo-Chat/papo-backend');
		expect(embed.description).toBe('O backend oficial da aplicação Web Papo.');
		expect(embed.site_name).toBe('github.com');
	});

	it('GIF que só existe como imagem fica marcado como gif: o bridge manda como arquivo', () => {
		const embed = first({
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
		});
		expect(embed.thumbnail?.mime_type).toBe('image/gif');
		expect(embed.video).toBeUndefined();
	});

	it('GIF do Twitter via espelho: o mp4 que o conversor carrega no query é o vídeo do preview', () => {
		const embed = first(vxTwitterGif());
		// o `image` é um conversor: o arquivo de verdade está no query dele
		expect(embed.video?.url).toBe('https://video.twimg.com/tweet_video/HUKrfRHXIAAdssa.mp4');
		expect(embed.video?.mime_type).toBe('video/mp4');
		// o avif do conversor não está na allowlist do Papo: seria baixado e descartado
		expect(embed.thumbnail).toBeUndefined();
		expect(embed.author?.icon_url).toContain('pbs.twimg.com/profile_images/1640140330/breakdance_normal.gif');
	});

	it('mídia fora da allowlist do Papo não é oferecida: o backend recusaria a mensagem inteira', () => {
		const video = first({
			type: 'video',
			url: 'https://example.com/v/1',
			video: {
				url: 'https://cdn.example.com/v/1',
				proxy_url: 'https://images-ext-1.discordapp.net/external/x/https/cdn.example.com/v/1',
				content_type: 'video/quicktime'
			}
		});
		const image = first({
			type: 'rich',
			url: 'https://example.com/a',
			image: {
				url: 'https://cdn.example.com/diagrama.svg',
				proxy_url: 'https://images-ext-1.discordapp.net/external/x/https/cdn.example.com/diagrama.svg',
				width: 400,
				height: 400,
				content_type: 'image/svg+xml'
			}
		});
		expect(video.video).toBeUndefined();
		expect(image.thumbnail).toBeUndefined();
		// o texto do preview sobrevive: o que não reproduz vira cartão com link
		expect(image.url).toBe('https://example.com/a');
	});
});

describe('preview em componentes (o preview novo do Discord)', () => {
	it('extrai título, corpo e vídeo do embed de componentes do Instagram', () => {
		const embed = first(ogInstagramComponents());
		expect(embed.title).toBe('South America Memes');
		expect(embed.description).toContain('@southamericamemes');
		expect(embed.description).toContain('ligando pra nada só pro feriado segunda-feira');
		expect(embed.video?.mime_type).toBe('video/mp4');
		expect(embed.video?.url).toContain('oginstagram.com/offload/DeSKFT8BTKO/1');
		expect(embed.url).toBe('https://www.oginstagram.com/reel/DeSKFT8BTKO/');
		expect(embed.site_name).toBe('oginstagram.com');
		expect(embed.color).toBe('#ff0069');
	});

	it('emoji custom, timestamp relativo e texto pequeno do Discord não viram ruído no Papo', () => {
		const embed = first(ogInstagramComponents());
		expect(embed.description).not.toContain('<:verified:');
		expect(embed.description).not.toContain('<t:1791570606');
		expect(embed.description).not.toContain('-# ');
		expect(embed.title).not.toContain('**');
	});

	it('avatar de canto não vira thumbnail quando o embed tem vídeo', () => {
		const embed = first(ogInstagramComponents());
		// o Papo desenha a thumbnail como imagem grande do card: avatar 150x150 viraria banner
		expect(embed.thumbnail?.url ?? '').not.toContain('avatar');
	});

	it('mídia aninhada em componentes é recolhida: avatar e vídeo do carrossel', () => {
		const { images, videos } = discordEmbedMedia(asEmbed(ogInstagramComponents()));
		expect(videos.map((v) => v.mime)).toEqual(['video/mp4']);
		expect(images.map((i) => i.mime)).toEqual(['image/jpeg']);
	});

	it('preview cuja mídia já sai como anexo da mensagem é descartado', () => {
		const preview = firstDiscordPreview([asEmbed(ogInstagramComponents()) as never], ['https://www.oginstagram.com/offload/DeSKFT8BTKO/1?v=2']);
		expect(preview).toBeUndefined();
	});

	it('anexo de outra mídia não cancela o preview', () => {
		const preview = firstDiscordPreview([asEmbed(ogInstagramComponents()) as never], ['https://cdn.discordapp.com/attachments/1/2/nota.pdf']);
		expect(preview?.title).toBe('South America Memes');
	});
});

describe('preview do Papo → Discord: mídia', () => {
	const videoEmbed: PapoEmbed = {
		id: 'e-1',
		source_type: 'link',
		url: 'https://x.com/i/status/1',
		title: 'Vídeo',
		thumbnail: { mime_type: 'image/webp', width: 720, height: 1280 },
		video: { url: 'https://video.twimg.com/amplify_video/1/avc1/1280x720/x.mp4', mime_type: 'video/mp4' }
	};

	it('a mídia materializada entra como referência de anexo, para o edit reenviar', () => {
		const [payload = {}] = papoEmbedsToDiscord([videoEmbed], {
			mediaFor: () => ({
				thumbnailUrl: 'attachment://media-aaaa.webp',
				refs: [
					{ name: 'media-aaaa.webp', sha: 'a'.repeat(64) },
					{ name: 'media-bbbb.mp4', sha: 'b'.repeat(64) }
				]
			})
		});
		expect(payload.image?.url).toBe('attachment://media-aaaa.webp');
		expect(payload.thumbnail).toBeUndefined();
		expect(payload.media_refs).toHaveLength(2);
		// o Discord não aceita gravar vídeo em embed: o que leva o player é o anexo
		expect(payload.video).toBeUndefined();
	});

	it('sem mídia materializada o preview segue só com os metadados', () => {
		const [payload = {}] = papoEmbedsToDiscord([videoEmbed]);
		expect(payload.title).toBe('Vídeo');
		expect(payload.thumbnail).toBeUndefined();
		expect(payload.media_refs).toBeUndefined();
	});

	it('campos privados do bridge não vão para a API do Discord', () => {
		const [payload = {}] = papoEmbedsToDiscord([videoEmbed], {
			mediaFor: () => ({ thumbnailUrl: 'attachment://media-cccc.webp', refs: [{ name: 'media-cccc.webp', sha: 'c'.repeat(64) }] })
		});
		expect(payload).toHaveProperty('media_refs');
		const sent = discordApiEmbed(payload);
		expect(sent).not.toHaveProperty('media_refs');
		expect(sent.image?.url).toBe('attachment://media-cccc.webp');
		expect(sent.thumbnail).toBeUndefined();
		expect(discordApiEmbed(asEmbed(ogInstagramComponents()))).not.toHaveProperty('components');
	});

	it('a referência de anexo é reconhecida nos dois prefixos (avatar e mídia)', () => {
		expect(shaFromAttachmentRef('attachment://avatar-aaaa.png')).toBeUndefined();
		expect(shaFromAttachmentRef(`attachment://media-${'d'.repeat(64)}.mp4`)).toBe('d'.repeat(64));
		expect(attachmentRefName(`attachment://media-${'d'.repeat(64)}.mp4`)).toBe(`media-${'d'.repeat(64)}.mp4`);
	});
});

describe('embeds do Discord na forma crua da API', () => {
	it('a classe Embed do discord.js é desmontada para expor proxy_url e components', () => {
		const raw = { type: 'components', url: 'https://x.com', components: [{ type: 10, content: 'oi' }] };
		const wrapped = { data: raw, url: 'https://x.com', thumbnail: { proxyURL: 'https://proxy/x' } };
		const [embed] = rawDiscordEmbeds([wrapped as never]);
		expect(embed).toBe(raw as never);
		// sem `data` (embed já cru, vindo do REST) o objeto passa como está
		expect(rawDiscordEmbeds([raw as never])[0]).toBe(raw as never);
		expect(rawDiscordEmbeds(undefined)).toEqual([]);
	});
});
