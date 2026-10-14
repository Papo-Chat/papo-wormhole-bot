import { describe, expect, it } from 'vitest';
import type { APIEmbed } from 'discord.js';
import { discordHostedMedia, discordMediaLinksInContent, firstDiscordPreview, firstPapoPreview, giphyEmbed } from '../src/bridge/previews.js';
import { isDiscordMediaUrl } from '../src/bridge/embeds.js';
import { DISCORD_LIMITS } from '../src/bridge/limits.js';
import type { PapoEmbed } from '../src/papo/types.js';

/**
 * Preview de link como embed **extra** da ponte: o cartão principal (autor, avatar, horário,
 * conteúdo) continua primeiro e o preview entra atrás dele. Só o primeiro preview compatível
 * é aproveitado, e a mídia que já sai como anexo não ganha um segundo embed igual.
 */

/** Embed do Discord como o gateway o entrega (`type` é o texto, não o enum). */
const discordEmbed = (e: {
	type?: string;
	url?: string;
	title?: string;
	description?: string;
	thumbnail?: { url: string };
	image?: { url: string };
	video?: { url: string };
}): APIEmbed => e as unknown as APIEmbed;

describe('firstDiscordPreview (Discord → Papo)', () => {
	it('converte o primeiro link-preview para o formato do Papo', () => {
		const preview = firstDiscordPreview([
			discordEmbed({
				type: 'rich',
				url: 'https://example.com/artigo',
				title: 'Um artigo',
				description: 'Resumo do artigo',
				thumbnail: { url: 'https://example.com/thumb.png' }
			})
		]);
		expect(preview?.url).toBe('https://example.com/artigo');
		expect(preview?.title).toBe('Um artigo');
		expect(preview?.description).toBe('Resumo do artigo');
		expect(preview?.thumbnail?.url).toBe('https://example.com/thumb.png');
		expect(preview?.site_name).toBe('example.com');
	});

	it('só o primeiro preview: mais que isso repete URL e estoura o orçamento', () => {
		const preview = firstDiscordPreview([
			discordEmbed({ type: 'rich', url: 'https://a.example/1', title: 'primeiro' }),
			discordEmbed({ type: 'rich', url: 'https://b.example/2', title: 'segundo' })
		]);
		expect(preview?.title).toBe('primeiro');
	});

	it('aceita os tipos de preview que o Discord produz (link, image, video, gifv, article)', () => {
		for (const type of ['link', 'image', 'video', 'gifv', 'article']) {
			expect(firstDiscordPreview([discordEmbed({ type, url: 'https://example.com/x', title: type })])?.title).toBe(type);
		}
	});

	it('ignora embed que não é preview', () => {
		expect(firstDiscordPreview([discordEmbed({ type: 'unknown', url: 'https://example.com/x', title: 'nada' })])).toBeUndefined();
	});

	it('mensagem sem preview não produz embed', () => {
		expect(firstDiscordPreview([])).toBeUndefined();
		expect(firstDiscordPreview(undefined)).toBeUndefined();
		expect(firstDiscordPreview([discordEmbed({ type: 'rich' })])).toBeUndefined();
	});

	it('não duplica a URL que já sai como anexo da mensagem', () => {
		const preview = firstDiscordPreview(
			[discordEmbed({ type: 'image', url: 'https://cdn.example.com/imagem.png', title: 'imagem' })],
			['https://cdn.example.com/imagem.png']
		);
		expect(preview).toBeUndefined();
	});

	it('não duplica o GIF do picker: o anexo já carrega a mídia do embed', () => {
		// o Discord hospeda o GIF no CDN e o embed aponta para a mesma mídia em outro host
		const preview = firstDiscordPreview(
			[
				discordEmbed({
					type: 'gifv',
					url: 'https://klipy.com/gifs/algo',
					title: 'GIF',
					image: { url: 'https://media.discordapp.net/attachments/111/222/gif.gif' },
					thumbnail: { url: 'https://media.discordapp.net/attachments/111/222/gif.gif' }
				})
			],
			['https://cdn.discordapp.com/attachments/111/222/gif.gif']
		);
		expect(preview).toBeUndefined();
	});

	it('preview de página continua entrando quando o anexo é outra coisa', () => {
		const preview = firstDiscordPreview(
			[discordEmbed({ type: 'rich', url: 'https://example.com/artigo', title: 'artigo' })],
			['https://cdn.discordapp.com/attachments/111/222/nota.txt']
		);
		expect(preview?.title).toBe('artigo');
	});

	it('aplica os limites do Papo em vez de derrubar o embed', () => {
		const preview = firstDiscordPreview([
			discordEmbed({ type: 'rich', url: 'https://example.com', title: 't'.repeat(1000), description: 'd'.repeat(9000) })
		]);
		expect((preview?.title ?? '').length).toBeLessThanOrEqual(256);
		expect((preview?.description ?? '').length).toBeLessThanOrEqual(4192);
	});
});

describe('mídia hospedada pelo Discord (URL volátil)', () => {
	it('reconhece o arquivo que o Discord hospeda', () => {
		expect(isDiscordMediaUrl('https://cdn.discordapp.com/attachments/1/2/video.mp4')).toBe(true);
		// assinatura de expiração na query é o que faz a URL quebrar
		expect(isDiscordMediaUrl('https://media.discordapp.net/attachments/1/2/video.mp4?ex=66&is=66&hm=ab')).toBe(true);
		expect(isDiscordMediaUrl('https://cdn.discordapp.com/embed/attachments/1/2/imagem.png')).toBe(true);
		// proxy de terceiros: re-serva conteúdo de fora, não a mídia do Discord
		expect(isDiscordMediaUrl('https://images-ext-1.discordapp.net/external/xyz/https/example.com/a.png')).toBe(false);
		// avatar/banner são imagem de identidade, não arquivo de mensagem
		expect(isDiscordMediaUrl('https://cdn.discordapp.com/avatars/1/abc.png')).toBe(false);
		// link de mensagem não é mídia
		expect(isDiscordMediaUrl('https://discord.com/channels/1/2/3')).toBe(false);
		expect(isDiscordMediaUrl('https://example.com/x.png')).toBe(false);
		expect(isDiscordMediaUrl(undefined)).toBe(false);
	});

	it('re-host tira do preview a mídia do Discord, e o resto do card continua', () => {
		const preview = firstDiscordPreview(
			[discordEmbed({ type: 'rich', url: 'https://example.com/artigo', title: 'artigo', thumbnail: { url: 'https://cdn.discordapp.com/attachments/1/2/thumb.png' } })],
			[],
			{ rehostDiscordMedia: true }
		);
		expect(preview?.title).toBe('artigo');
		expect(preview?.url).toBe('https://example.com/artigo');
		expect(preview?.thumbnail).toBeUndefined();
	});

	it('preview que só existia pela mídia do CDN sai do card: o anexo carrega a mídia', () => {
		const preview = firstDiscordPreview(
			[discordEmbed({
				type: 'image',
				url: 'https://cdn.discordapp.com/attachments/1/2/imagem.png',
				title: 'imagem.png',
				image: { url: 'https://cdn.discordapp.com/attachments/1/2/imagem.png' }
			})],
			[],
			{ rehostDiscordMedia: true }
		);
		expect(preview).toBeUndefined();
	});

	it('sem re-host o preview continua com a URL (link com anexos desligados)', () => {
		const preview = firstDiscordPreview([
			discordEmbed({
				type: 'image',
				url: 'https://cdn.discordapp.com/attachments/1/2/imagem.png',
				title: 'imagem.png',
				image: { url: 'https://cdn.discordapp.com/attachments/1/2/imagem.png' }
			})
		]);
		expect(preview?.thumbnail?.url).toBe('https://cdn.discordapp.com/attachments/1/2/imagem.png');
	});

	it('discordHostedMedia coleta a mídia de todos os embeds, uma vez por arquivo', () => {
		const media = discordHostedMedia([
			discordEmbed({
				type: 'image',
				image: { url: 'https://cdn.discordapp.com/attachments/1/2/a.png' },
				thumbnail: { url: 'https://media.discordapp.net/attachments/1/2/a.png' }
			}),
			discordEmbed({ type: 'rich', url: 'https://example.com/x', thumbnail: { url: 'https://example.com/thumb.png' } }),
			discordEmbed({ type: 'video', video: { url: 'https://cdn.discordapp.com/attachments/1/2/b.mp4' } })
		] as never);
		expect(media.map((m) => m.url)).toEqual([
			'https://cdn.discordapp.com/attachments/1/2/a.png',
			'https://cdn.discordapp.com/attachments/1/2/b.mp4'
		]);
	});

	it('discordMediaLinksInContent pega o link de arquivo do Discord escrito no texto', () => {
		expect(discordMediaLinksInContent('olha https://cdn.discordapp.com/attachments/1/2/video.mp4 legal')).toEqual([
			'https://cdn.discordapp.com/attachments/1/2/video.mp4'
		]);
		// cerca de código não é link
		expect(discordMediaLinksInContent('```\nhttps://cdn.discordapp.com/attachments/1/2/x.png\n```')).toEqual([]);
		expect(discordMediaLinksInContent('link de fora https://example.com/a.png')).toEqual([]);
		expect(discordMediaLinksInContent('')).toEqual([]);
		expect(discordMediaLinksInContent(undefined)).toEqual([]);
	});
});

describe('firstPapoPreview (Papo → Discord)', () => {
	const embed: PapoEmbed = {
		id: 'e1',
		source_type: 'link',
		site_name: 'Example',
		url: 'https://example.com/artigo',
		title: 'Um artigo',
		description: 'Resumo',
		thumbnail: { width: 100, height: 100, mime_type: 'image/webp' }
	};

	it('converte o primeiro preview e usa a imagem re-hospedada', () => {
		const preview = firstPapoPreview([embed], { thumbnailUrlFor: () => 'https://media.bot/embeds/e1.webp' });
		expect(preview?.url).toBe('https://example.com/artigo');
		expect(preview?.title).toBe('Um artigo');
		expect(preview?.description).toBe('Resumo');
		expect(preview?.thumbnail?.url).toBe('https://media.bot/embeds/e1.webp');
	});

	it('só o primeiro preview', () => {
		const preview = firstPapoPreview([embed, { ...embed, id: 'e2', title: 'segundo' }]);
		expect(preview?.title).toBe('Um artigo');
	});

	it('preview sem imagem convertível continua convertível (texto e URL)', () => {
		const preview = firstPapoPreview([{ id: 'e3', source_type: 'link', url: 'https://example.com', title: 'link' }]);
		expect(preview?.title).toBe('link');
		expect(preview?.thumbnail).toBeUndefined();
	});

	it('mensagem sem preview não produz embed', () => {
		expect(firstPapoPreview([])).toBeUndefined();
		expect(firstPapoPreview(null)).toBeUndefined();
		expect(firstPapoPreview(undefined)).toBeUndefined();
	});
});

describe('giphyEmbed', () => {
	it('o GIF do picker vira embed de imagem com a página como link', () => {
		const embed = giphyEmbed({
			id: 'abc',
			url: 'https://media.giphy.com/media/abc/giphy.gif',
			pageUrl: 'https://giphy.com/gifs/abc',
			title: 'Gato dançando'
		});
		expect(embed.image?.url).toBe('https://media.giphy.com/media/abc/giphy.gif');
		expect(embed.url).toBe('https://giphy.com/gifs/abc');
		expect(embed.title).toBe('Gato dançando');
	});

	it('título longo é cortado no limite do Discord', () => {
		const embed = giphyEmbed({
			id: 'abc',
			url: 'https://x/g.gif',
			pageUrl: 'https://giphy.com/gifs/abc',
			title: 't'.repeat(1000)
		});
		expect((embed.title ?? '').length).toBeLessThanOrEqual(DISCORD_LIMITS.embedTitleMax);
	});
});
