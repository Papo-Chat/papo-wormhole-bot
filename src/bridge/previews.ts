import type { APIEmbed } from 'discord.js';
import type { PapoEmbed, PapoEmbedInput } from '../papo/types.js';
import {
	discordEmbedMedia,
	discordEmbedsToPapo,
	discordMediaSourceUrl,
	gifVariantUrl,
	isDiscordHostedMedia,
	isDiscordMediaUrl,
	isGifPlayerEmbed,
	papoEmbedsToDiscord,
	type DiscordEmbedPayload,
	type DiscordMedia,
	type DiscordToPapoOptions,
	type PreviewMedia
} from './embeds.js';
import { DISCORD_LIMITS, clampText } from './limits.js';
import type { GiphyGif } from './giphy.js';

/**
 * Preview de link como embed extra da ponte.
 *
 * O cartão principal (autor, avatar, horário, conteúdo) é a mensagem bridgeada; o preview é
 * um embed **adicional**, sempre atrás do cartão, e nunca o substitui. Só o primeiro preview
 * compatível é aproveitado — mais que isso estoura o orçamento de embeds e repete a mesma URL.
 */

/**
 * Tipos de embed do Discord que funcionam como preview de link. `gifv` é o tipo histórico do
 * picker de GIF; desde 24/02/2026 o Discord indexa a mesma mídia como `gif`, e `components` é
 * o preview novo de link de mídia (Instagram e afins) — nenhum dos três está nos tipos do
 * discord-api-types instalado, mas todos aparecem nos payloads.
 */
const DISCORD_PREVIEW_TYPES = new Set(['rich', 'link', 'image', 'video', 'gifv', 'gif', 'article', 'components']);

const urlOf = (e: { url?: string | null }): string | undefined => (e.url ? e.url : undefined);

/**
 * Identidade da mídia: o caminho do URL, sem host nem query.
 * O Discord serve a mesma mídia por hosts diferentes (`cdn.discordapp.com` no anexo,
 * `media.discordapp.net` no embed) e com assinatura de proxy na query; o caminho é o que
 * permanece igual. Picker de GIF (Klipy/Giphy) chega como anexo **e** embed da mesma mídia.
 */
export const mediaKey = (url?: string | null): string | undefined => {
	if (!url) return undefined;
	try {
		return new URL(url).pathname.toLowerCase();
	} catch {
		return undefined;
	}
};

/**
 * Embeds do Discord na forma crua da API. A classe `Embed` do discord.js reescreve a mídia em
 * camelCase (`proxyURL`) e não expõe `components` — o conversor precisa dos campos da API:
 * é o `proxy_url` que sobrevive à origem e são os componentes que carregam o preview novo.
 */
export function rawDiscordEmbeds(embeds: readonly APIEmbed[] | undefined): APIEmbed[] {
	return (embeds ?? []).map((e) => (e as { data?: APIEmbed }).data ?? e);
}

/**
 * Primeiro preview do Discord convertível para o Papo.
 * `attachmentUrls`: mídia que já sai como anexo da mensagem bridgeada. Preview que representa
 * a mesma mídia (mesmo caminho, ainda que em outro host) é descartado: o GIF ou a imagem já
 * vai no destino como arquivo, e um embed atrás dele seria a mesma coisa duplicada.
 * `rehostDiscordMedia`: mídia hospedada pelo Discord sai do embed (vai como anexo baixado).
 */
export function firstDiscordPreview(
	embeds: readonly APIEmbed[] | undefined,
	attachmentUrls: readonly string[] = [],
	opts: DiscordToPapoOptions = {}
): PapoEmbedInput | undefined {
	const bridged = new Set(attachmentUrls.map(mediaKey).filter(Boolean));
	for (const e of embeds ?? []) {
		if (e.type && !DISCORD_PREVIEW_TYPES.has(e.type)) continue;
		const payload = e as unknown as DiscordEmbedPayload;
		const media = discordEmbedMedia(payload);
		const keys = [urlOf(e), ...media.images, ...media.videos]
			.flatMap((m) => (typeof m === 'string' ? [m] : m ? [m.url, m.origin] : []))
			.map(mediaKey);
		if (keys.some((key) => key && bridged.has(key))) continue;
		const [converted] = discordEmbedsToPapo([payload], opts);
		if (!converted || !Object.keys(converted).length) continue;
		// preview que só existia pela mídia do CDN: re-hospedada como anexo, o card não acrescenta
		// nada além de uma URL que quebra
		if (
			opts.rehostDiscordMedia &&
			!converted.thumbnail &&
			!converted.image &&
			!converted.video &&
			isDiscordMediaUrl(converted.url)
		)
			continue;
		return converted;
	}
	return undefined;
}

/**
 * Toda mídia que o Discord hospeda nos embeds da mensagem (imagem de anexo, preview de
 * imagem, vídeo do picker). O bridge baixa cada uma e reenvia como anexo da mensagem no Papo:
 * a URL do CDN expira junto com a mensagem original.
 * `skipGifPlayerMedia`: o GIF que vai como arquivo da mensagem cobre o mp4 em loop e o frame
 * estático que o player do Discord re-serviu dele — re-hospedar os dois é mandar a mesma mídia
 * três vezes.
 */
export function discordHostedMedia(
	embeds: readonly APIEmbed[] | undefined,
	opts: { skipGifPlayerMedia?: boolean } = {}
): DiscordMedia[] {
	const out: DiscordMedia[] = [];
	const seen = new Set<string>();
	for (const e of embeds ?? []) {
		const payload = e as unknown as DiscordEmbedPayload;
		const { images, videos } = discordEmbedMedia(payload);
		const gifOnly = Boolean(opts.skipGifPlayerMedia) && isGifPlayerEmbed(payload);
		for (const m of [...images, ...videos]) {
			if (gifOnly && m.mime !== 'image/gif') continue;
			if (!isDiscordHostedMedia(m)) continue;
			const key = mediaKey(discordMediaSourceUrl(m));
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(m);
		}
	}
	return out;
}

/** Anexo `.gif` (o picker do Discord entrega o GIF como arquivo da mensagem). */
export const isGifAttachment = (a: { name?: string | null; contentType?: string | null }): boolean =>
	((a.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '') === 'image/gif' || /\.gif$/i.test(a.name ?? '');

export interface DiscordGif {
	/** O arquivo animado que o bridge ainda precisa baixar; `undefined` quando o anexo da origem já é ele. */
	media?: DiscordMedia;
}

/**
 * O GIF animado que a mensagem do Discord carrega, na forma de arquivo para o bridge baixar.
 *
 * O player do Discord (`gifv`/`gif`) re-serviu o GIF como mp4 em loop mais um frame estático,
 * e o backend do Papo desenha isso como player de vídeo: a animação morre no meio do caminho.
 * Ordem de preferência: a mídia `image/gif` do embed, e por último a variante `.gif` do mp4 que
 * o player mostra — Klipy e Giphy servem o mesmo caminho com as duas extensões.
 * `undefined` quando a mensagem não tem GIF nenhum; `media` ausente quando o anexo da origem
 * já é o arquivo (não há o que baixar, mas o mp4 do player continua sobrando no card).
 */
export function discordGifOf(
	embeds: readonly APIEmbed[] | undefined,
	attachments: readonly { name?: string | null; contentType?: string | null }[] = []
): DiscordGif | undefined {
	if (attachments.some(isGifAttachment)) return {};
	for (const e of embeds ?? []) {
		const payload = e as unknown as DiscordEmbedPayload;
		const { images, videos } = discordEmbedMedia(payload);
		const [gif] = images.filter((m) => m.mime === 'image/gif');
		if (gif) return { media: { ...gif, url: discordMediaSourceUrl(gif) } };
		if (!isGifPlayerEmbed(payload)) continue;
		for (const m of [...videos, ...images]) {
			const variant = gifVariantUrl(m.origin) ?? gifVariantUrl(m.url);
			if (!variant) continue;
			// o mp4 que o Discord garante continua sendo a URL do destino: a variante é
			// tentativa, não substituta
			return { media: { ...m, url: discordMediaSourceUrl(m), gifVariant: variant } };
		}
	}
	return undefined;
}

const CONTENT_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/g;

/**
 * Links de arquivo do Discord escritos no texto da mensagem. Quem cola
 * `https://cdn.discordapp.com/attachments/…` no Discord quer a mídia, não o link: o bridge
 * baixa e reenvia como anexo no Papo. Cerca de código não é link.
 */
export function discordMediaLinksInContent(content?: string | null): string[] {
	if (!content) return [];
	const prose = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
	const out: string[] = [];
	for (const m of prose.matchAll(CONTENT_URL_RE)) {
		const url = m[0]?.replace(/[.,;:!?]+$/, '');
		if (url && isDiscordMediaUrl(url)) out.push(url);
	}
	return out;
}

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * Tira do texto os links de arquivo do Discord que o bridge re-hospeda como anexo da mensagem.
 * Quem cola `https://cdn.discordapp.com/attachments/…` quer a mídia, e a URL não funciona fora do
 * Discord (assinatura vencida): manter as duas é mostrar um link quebrado embaixo do arquivo que
 * chegou. `[rótulo](link)` conserva o rótulo; `<link>` some junto com os colchetes. Cerca de código
 * não é link — é o texto que a pessoa escreveu, e não virou anexo (`discordMediaLinksInContent`).
 */
export function stripDiscordMediaLinks(content: string): string {
	if (!content) return content;
	const code: string[] = [];
	const guarded = content.replace(/```[\s\S]*?```|`[^`\n]*`/g, (block) => {
		code.push(block);
		return `\u0000${code.length - 1}\u0000`;
	});
	const withoutLinks = guarded
		.replace(MARKDOWN_LINK_RE, (raw, label: string, url: string) => (isDiscordMediaUrl(url) ? label.trim() : raw))
		.replace(CONTENT_URL_RE, (url) => (isDiscordMediaUrl(url) ? '' : url));
	// limpeza antes de devolver o código: o que a pessoa escreveu dentro do cerca não é tocado,
	// e a indentação de lista também não
	const cleaned = withoutLinks
		.replace(/<\s*>/g, '')
		.replace(/(?<=\S)[ \t]{2,}/g, ' ')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n');
	const restored = cleaned.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => code[Number(index)] ?? '');
	return restored.trim();
}

/**
 * Primeiro preview do Papo convertível para o Discord.
 * `thumbnailUrlFor`: o Papo não expõe a imagem do embed por URL; quem tem os bytes é
 * `GET /embeds/{id}` e o bridge re-hospeda (media server ou anexo da mensagem).
 * `mediaFor`: mídia já baixada pelo bridge — a thumbnail pode vir como `attachment://` e o
 * vídeo entra como anexo, porque o Discord não grava `video` em embed criado por bot.
 */
export function firstPapoPreview(
	embeds: readonly PapoEmbed[] | null | undefined,
	opts: {
		thumbnailUrlFor?: (embed: PapoEmbed) => string | undefined;
		mediaFor?: (embed: PapoEmbed) => PreviewMedia | undefined;
	} = {}
): DiscordEmbedPayload | undefined {
	for (const e of embeds ?? []) {
		const [converted] = papoEmbedsToDiscord([e], opts);
		if (converted && Object.keys(converted).length) return converted;
	}
	return undefined;
}

/** GIF do picker do Papo como embed extra do Discord (o marcador cru não renderiza lá). */
export function giphyEmbed(gif: GiphyGif): DiscordEmbedPayload {
	return {
		title: clampText(gif.title, DISCORD_LIMITS.embedTitleMax),
		url: gif.pageUrl,
		image: { url: gif.url }
	};
}
