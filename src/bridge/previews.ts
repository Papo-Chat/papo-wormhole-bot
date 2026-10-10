import type { APIEmbed } from 'discord.js';
import type { PapoEmbed, PapoEmbedInput } from '../papo/types.js';
import { discordEmbedsToPapo, papoEmbedsToDiscord, type DiscordEmbedPayload } from './embeds.js';
import { DISCORD_LIMITS, clampText } from './limits.js';
import type { GiphyGif } from './giphy.js';

/**
 * Preview de link como embed extra da ponte.
 *
 * O cartão principal (autor, avatar, horário, conteúdo) é a mensagem bridgeada; o preview é
 * um embed **adicional**, sempre atrás do cartão, e nunca o substitui. Só o primeiro preview
 * compatível é aproveitado — mais que isso estoura o orçamento de embeds e repete a mesma URL.
 */

/** Tipos de embed do Discord que funcionam como preview de link. */
const DISCORD_PREVIEW_TYPES = new Set(['rich', 'link', 'image', 'video', 'gifv', 'article']);

const urlOf = (e: { url?: string | null }): string | undefined => (e.url ? e.url : undefined);

/**
 * Identidade da mídia: o caminho do URL, sem host nem query.
 * O Discord serve a mesma mídia por hosts diferentes (`cdn.discordapp.com` no anexo,
 * `media.discordapp.net` no embed) e com assinatura de proxy na query; o caminho é o que
 * permanece igual. Picker de GIF (Klipy/Giphy) chega como anexo **e** embed da mesma mídia.
 */
const mediaKey = (url?: string | null): string | undefined => {
	if (!url) return undefined;
	try {
		return new URL(url).pathname.toLowerCase();
	} catch {
		return undefined;
	}
};

/**
 * Primeiro preview do Discord convertível para o Papo.
 * `attachmentUrls`: mídia que já sai como anexo da mensagem bridgeada. Preview que representa
 * a mesma mídia (mesmo caminho, ainda que em outro host) é descartado: o GIF ou a imagem já
 * vai no destino como arquivo, e um embed atrás dele seria a mesma coisa duplicada.
 */
export function firstDiscordPreview(
	embeds: readonly APIEmbed[] | undefined,
	attachmentUrls: readonly string[] = []
): PapoEmbedInput | undefined {
	const bridged = new Set(attachmentUrls.map(mediaKey).filter(Boolean));
	for (const e of embeds ?? []) {
		if (e.type && !DISCORD_PREVIEW_TYPES.has(e.type)) continue;
		const media = [urlOf(e), e.image?.url, e.thumbnail?.url, e.video?.url].map(mediaKey);
		if (media.some((key) => key && bridged.has(key))) continue;
		const [converted] = discordEmbedsToPapo([e as unknown as DiscordEmbedPayload]);
		if (converted && Object.keys(converted).length) return converted;
	}
	return undefined;
}

/**
 * Primeiro preview do Papo convertível para o Discord.
 * `thumbnailUrlFor`: o Papo não expõe a imagem do embed por URL; quem tem os bytes é
 * `GET /embeds/{id}` e o bridge re-hospeda no media server.
 */
export function firstPapoPreview(
	embeds: readonly PapoEmbed[] | null | undefined,
	opts: { thumbnailUrlFor?: (embed: PapoEmbed) => string | undefined } = {}
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
