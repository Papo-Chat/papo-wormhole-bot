import { describe, expect, it } from 'vitest';
import type { APIEmbed } from 'discord.js';
import { discordGifLinks, discordGifOf, discordHostedMedia, discordMediaLinksInContent, firstDiscordPreview, firstPapoPreview, giphyEmbed, stripDiscordMediaLinks } from '../src/bridge/previews.js';
import { discordLinkIsStale, discordMediaDownloadUrls, discordSignatureExpiry, gifVariantUrl, isDiscordMediaUrl } from '../src/bridge/embeds.js';
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

	it('link de anexo sem assinatura válida está vencido (o CDN responde 404 com o arquivo vivo)', () => {
		const hex = (seconds: number) => seconds.toString(16);
		const now = Math.floor(Date.now() / 1000);
		const past = hex(now - 3600);
		const future = hex(now + 3600);

		// copiar link no Discord entrega o caminho limpo: sem assinatura o CDN recusa
		expect(discordLinkIsStale('https://cdn.discordapp.com/attachments/1/2/gif.gif')).toBe(true);
		expect(discordLinkIsStale('https://media.discordapp.net/attachments/1/2/gif.gif')).toBe(true);
		expect(discordLinkIsStale(`https://cdn.discordapp.com/attachments/1/2/gif.gif?ex=${past}&is=${past}&hm=ab`)).toBe(true);
		expect(discordLinkIsStale(`https://cdn.discordapp.com/attachments/1/2/gif.gif?ex=${future}&is=${past}&hm=ab`)).toBe(false);
		// `/emojis/` e `/stickers/` são públicos: não são assinados, não vencem
		expect(discordLinkIsStale('https://cdn.discordapp.com/emojis/1.gif')).toBe(false);
		expect(discordLinkIsStale('https://cdn.discordapp.com/stickers/1.json')).toBe(false);
		// fora do CDN não é link que o bridge renova
		expect(discordLinkIsStale('https://example.com/a.png')).toBe(false);
		expect(discordLinkIsStale(undefined)).toBe(false);
	});

	it('lê a expiração da assinatura: `ex` é o epoch em hexadecimal', () => {		const seconds = Math.floor(Date.now() / 1000) + 60;
		expect(discordSignatureExpiry(`https://cdn.discordapp.com/attachments/1/2/a.png?ex=${seconds.toString(16)}&is=1&hm=ab`)).toBe(seconds);
		expect(discordSignatureExpiry('https://cdn.discordapp.com/attachments/1/2/a.png')).toBeUndefined();
		expect(discordSignatureExpiry('https://cdn.discordapp.com/attachments/1/2/a.png?ex=zz')).toBeUndefined();
	});

	it('o link que virou anexo sai do texto: a URL do CDN não abre fora do Discord', () => {
		expect(stripDiscordMediaLinks('https://cdn.discordapp.com/attachments/1/2/a.gif')).toBe('');
		expect(stripDiscordMediaLinks('olha o gif https://media.discordapp.net/attachments/1/2/a.gif 👍')).toBe('olha o gif 👍');
		// o rótulo do link markdown fica; o alvo quebrado sai
		expect(stripDiscordMediaLinks('[o gif](https://cdn.discordapp.com/attachments/1/2/a.gif)')).toBe('o gif');
		// `<link>` é o jeito do Discord de suprimir o preview: some inteiro
		expect(stripDiscordMediaLinks('olá <https://cdn.discordapp.com/attachments/1/2/a.gif>')).toBe('olá');
		// linha que era só o link não deixa quebra extra
		expect(stripDiscordMediaLinks('a\nhttps://cdn.discordapp.com/attachments/1/2/a.gif\nb')).toBe('a\n\nb');
		// cerca de código é texto escrito, não link: não virou anexo
		expect(stripDiscordMediaLinks('veja `https://cdn.discordapp.com/attachments/1/2/a.gif` aqui')).toBe('veja `https://cdn.discordapp.com/attachments/1/2/a.gif` aqui');
		// link de fora e link de mensagem não são mídia re-hospedada
		expect(stripDiscordMediaLinks('https://example.com/a.png')).toBe('https://example.com/a.png');
		expect(stripDiscordMediaLinks('https://discord.com/channels/1/2/3')).toBe('https://discord.com/channels/1/2/3');
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

	it('o GIF que vai como arquivo cobre o mp4 em loop e o frame estático do player', () => {
		const embeds = [
			discordEmbed({
				type: 'gifv',
				url: 'https://klipy.com/gifs/algo',
				image: { url: 'https://cdn.discordapp.com/attachments/1/2/gif.gif' },
				video: { url: 'https://cdn.discordapp.com/embed/attachments/1/2/gif-loop.mp4' },
				thumbnail: { url: 'https://cdn.discordapp.com/embed/attachments/1/2/gif-frame.webp' }
			})
		] as never;
		// sem a regra, a mesma mídia chega três vezes: o GIF, o loop e o frame parado
		expect(discordHostedMedia(embeds).map((m) => m.url)).toEqual([
			'https://cdn.discordapp.com/attachments/1/2/gif.gif',
			'https://cdn.discordapp.com/embed/attachments/1/2/gif-frame.webp',
			'https://cdn.discordapp.com/embed/attachments/1/2/gif-loop.mp4'
		]);
		expect(discordHostedMedia(embeds, { skipGifPlayerMedia: true }).map((m) => m.url)).toEqual([
			'https://cdn.discordapp.com/attachments/1/2/gif.gif'
		]);
		// vídeo de verdade (não é player de GIF) continua re-hospedado
		expect(
			discordHostedMedia([discordEmbed({ type: 'video', video: { url: 'https://cdn.discordapp.com/attachments/1/2/b.mp4' } })] as never, {
				skipGifPlayerMedia: true
			}).map((m) => m.url)
		).toEqual(['https://cdn.discordapp.com/attachments/1/2/b.mp4']);
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

describe('GIF do Discord viaja como arquivo (discordGifOf)', () => {
	/** GIF do picker Klipy: o Discord só expõe o mp4 em loop e o frame webp do mesmo GIF. */
	const klipyGifv = () => ({
		type: 'gifv',
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
	}) as never;

	it('mp4 do player vira arquivo pela variante `.gif` do mesmo caminho', () => {
		const gif = discordGifOf([klipyGifv()]);
		// Klipy serve o GIF e o loop pelo mesmo caminho com extensões diferentes
		expect(gif?.media?.gifVariant).toBe('https://static.klipy.com/ii/d7ae/vTXuDBugGeZn6Djx.gif');
		// o mp4 que o Discord garante continua sendo a URL do destino, se a variante falhar
		expect(gif?.media?.url).toBe('https://images-ext-1.discordapp.net/external/P17-/https/static.klipy.com/ii/d7ae/vTXuDBugGeZn6Djx.mp4');
	});

	it('a mídia `image/gif` do embed é o arquivo: não há variante a deduzir', () => {
		const gif = discordGifOf([
			discordEmbed({
				type: 'image',
				url: 'https://cdn.discordapp.com/attachments/1/2/animado.gif',
				image: { url: 'https://cdn.discordapp.com/attachments/1/2/animado.gif' }
			})
		] as never);
		expect(gif?.media?.url).toBe('https://cdn.discordapp.com/attachments/1/2/animado.gif');
		expect(gif?.media?.gifVariant).toBeUndefined();
	});

	it('anexo `.gif` já é o arquivo: nada a baixar, e o mp4 do player continua sobrando', () => {
		const gif = discordGifOf([klipyGifv()], [{ name: 'gif.gif', contentType: 'image/gif' }]);
		expect(gif).toEqual({});
		// o anexo pode ser o GIF pelo MIME ou pelo nome
		expect(discordGifOf([], [{ name: 'arquivo', contentType: 'image/gif; charset=binary' }])).toEqual({});
		expect(discordGifOf([], [{ name: 'gif.GIF', contentType: null }])).toEqual({});
	});

	it('mensagem sem GIF nenhum não produz mídia', () => {
		expect(discordGifOf([discordEmbed({ type: 'rich', url: 'https://example.com/x', thumbnail: { url: 'https://example.com/t.png' } })] as never)).toBeUndefined();
		expect(discordGifOf([])).toBeUndefined();
		expect(discordGifOf(undefined)).toBeUndefined();
		// vídeo de verdade não é GIF deduzido: só o player de GIF (`gifv`/`gif`) é
		expect(discordGifOf([discordEmbed({ type: 'video', video: { url: 'https://example.com/a.mp4' } })] as never)).toBeUndefined();
	});

	it('gifVariantUrl: o proxy de terceiros do Discord tem o caminho assinado, extensão incluída', () => {
		expect(gifVariantUrl('https://static.klipy.com/ii/d7ae/vTXu.mp4')).toBe('https://static.klipy.com/ii/d7ae/vTXu.gif');
		// assinatura de CDN vale para o caminho assinado: a variante nasce limpa e é renovada
		expect(gifVariantUrl('https://cdn.discordapp.com/embed/attachments/1/2/loop.mp4?ex=66&is=66&hm=ab')).toBe(
			'https://cdn.discordapp.com/embed/attachments/1/2/loop.gif'
		);
		expect(gifVariantUrl('https://images-ext-1.discordapp.net/external/P17/https/static.klipy.com/ii/d7ae/vTXu.mp4')).toBeUndefined();
		// já é gif, e página de player não é arquivo
		expect(gifVariantUrl('https://media.giphy.com/media/abc/giphy.gif')).toBeUndefined();
		expect(gifVariantUrl('https://www.youtube.com/embed/dwK9fhsOGK8')).toBeUndefined();
		expect(gifVariantUrl(undefined)).toBeUndefined();
	});

	it('gifAsFile tira o mp4 e o frame estático do card: o arquivo animado é o GIF', () => {
		const preview = firstDiscordPreview([klipyGifv()], [], { gifAsFile: true });
		expect(preview?.title).toBe('Orihime: The Bread Bag Girl');
		expect(preview?.url).toBe('https://klipy.com/gifs/orihime-bread-girl');
		expect(preview?.video).toBeUndefined();
		expect(preview?.thumbnail).toBeUndefined();
		// sem a regra, o Papo desenha o loop mp4 com um frame parado
		expect(firstDiscordPreview([klipyGifv()])?.video?.mime_type).toBe('video/mp4');
	});

	it('o download busca a origem intocada antes do proxy do Discord', () => {
		// o proxy re-encode para caber no embed: um GIF que passa por ele chega como frame parado
		const giphy = {
			url: 'https://images-ext-1.discordapp.net/external/ZgLT/https/media.giphy.com/media/abc/giphy.gif',
			origin: 'https://media.giphy.com/media/abc/giphy.gif',
			mime: 'image/gif'
		};
		expect(discordMediaDownloadUrls(giphy)).toEqual(['https://media.giphy.com/media/abc/giphy.gif', giphy.url]);
		// o CDN é a forma canônica do que o Discord hospeda; o proxy do mesmo arquivo é o plano B
		const cdn = { url: 'https://media.discordapp.net/attachments/1/2/foto.png', origin: 'https://cdn.discordapp.com/attachments/1/2/foto.png', mime: 'image/png' };
		expect(discordMediaDownloadUrls(cdn)).toEqual(['https://cdn.discordapp.com/attachments/1/2/foto.png', cdn.url]);
		// origem que é página, não arquivo, não é candidata a download
		const page = { url: 'https://images-ext-1.discordapp.net/external/Zg/https/example.com/x', origin: 'https://example.com/x', mime: 'image/png' };
		expect(discordMediaDownloadUrls(page)).toEqual([page.url]);
	});

	it('discordGifLinks: a página e a mídia do embed que carrega o GIF', () => {
		const links = discordGifLinks([klipyGifv()]);
		expect(links).toContain('https://klipy.com/gifs/orihime-bread-girl');
		expect(links).toContain('https://static.klipy.com/ii/d7ae/vTXuDBugGeZn6Djx.mp4');
		// embed sem GIF nenhum não empresta link: o resto da mensagem continua no texto
		expect(discordGifLinks([discordEmbed({ type: 'rich', url: 'https://example.com/a', thumbnail: { url: 'https://example.com/t.png' } }) as never])).toEqual([]);
	});

	it('o link do GIF sai do texto: embaixo do arquivo ele seria o preview duplicado', () => {
		const page = 'https://giphy.com/gifs/funny-happy-excited-okfv';
		const media = 'https://media.giphy.com/media/okfv/giphy.gif';
		expect(stripDiscordMediaLinks(`olha ${page} 😂`, [page, media])).toBe('olha 😂');
		// `[rótulo](link)` conserva o rótulo
		expect(stripDiscordMediaLinks(`[o gif](${page})`, [page])).toBe('o gif');
		// só o link que virou arquivo sai: o resto da mensagem é o que a pessoa escreveu
		expect(stripDiscordMediaLinks(`veja https://example.com/a e ${page}`, [page])).toBe('veja https://example.com/a e');
		// cerca de código não é tocada
		expect(stripDiscordMediaLinks(`\`\`\`\n${page}\n\`\`\``, [page])).toBe(`\`\`\`\n${page}\n\`\`\``);
		// sem URLs extras, o comportamento é o de sempre
		expect(stripDiscordMediaLinks('olha https://example.com/a')).toBe('olha https://example.com/a');
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
