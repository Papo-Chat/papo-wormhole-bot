import type { PapoEmbed, PapoEmbedInput } from '../papo/types.js';
import {
	DISCORD_LIMITS,
	PAPO_LIMITS,
	clampText
} from './limits.js';

/** Shape de embed aceito pela API do Discord (REST). */
export interface DiscordEmbedPayload {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	timestamp?: string;
	author?: { name: string; url?: string; icon_url?: string };
	footer?: { text: string; icon_url?: string };
	thumbnail?: { url: string };
	image?: { url: string };
	fields?: { name: string; value: string; inline?: boolean }[];
}

export const intToHex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/** Referência a um arquivo enviado junto da mensagem (o Discord resolve localmente). */
export const attachmentRef = (name: string): string => `attachment://${name}`;

/** Nome canônico do anexo de avatar (o sha vai inteiro para o edit reanexar). */
export const avatarAttachmentName = (sha: string, ext: string): string => `avatar-${sha}.${ext}`;

/** Extrai o sha256 de uma referência `attachment://avatar-<sha>.<ext>`. */
export function shaFromAttachmentRef(url?: string): string | undefined {
	if (!url) return undefined;
	const m = /^attachment:\/\/avatar-([0-9a-f]{64})\.[a-z0-9]+$/.exec(url);
	return m?.[1];
}

export const hexToInt = (color?: string | null): number | undefined => {
	if (!color) return undefined;
	const m = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
	return m ? Number.parseInt(m[1]!, 16) : undefined;
};

const hostOf = (url?: string | null): string | undefined => {
	if (!url) return undefined;
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
};

/** Soma o texto de um embed (orçamento de 6000 chars por mensagem nos dois lados). */
export function embedTextLength(e: DiscordEmbedPayload | PapoEmbedInput): number {
	const anyE = e as DiscordEmbedPayload & PapoEmbedInput;
	return (
		(anyE.title?.length ?? 0) +
		(anyE.description?.length ?? 0) +
		(anyE.author?.name?.length ?? 0) +
		(anyE.footer?.text?.length ?? 0) +
		(anyE.fields ?? []).reduce((acc, f) => acc + f.name.length + f.value.length, 0)
	);
}

/** Corta embeds que ultrapassem o orçamento conjunto de texto da mensagem. */
export function fitEmbedBudget<T extends DiscordEmbedPayload | PapoEmbedInput>(embeds: T[], budget = 6000): T[] {
	const out: T[] = [];
	let used = 0;
	for (const e of embeds) {
		const len = embedTextLength(e);
		if (used + len <= budget) {
			out.push(e);
			used += len;
			continue;
		}
		const remaining = budget - used;
		if (remaining <= 64) break;
		if (e.description) {
			const trimmed = { ...e, description: clampText(e.description, Math.max(1, remaining)) } as T;
			out.push(trimmed);
			used += embedTextLength(trimmed);
		}
		break;
	}
	return out;
}

/** Embed do Discord → EmbedInput do Papo. */
export function discordEmbedsToPapo(embeds: DiscordEmbedPayload[]): PapoEmbedInput[] {
	const out: PapoEmbedInput[] = [];
	for (const e of embeds.slice(0, PAPO_LIMITS.embedsPerMessage)) {
		const input: PapoEmbedInput = {};
		if (e.title) input.title = clampText(e.title, PAPO_LIMITS.embedTitleMax);
		if (e.description) input.description = clampText(e.description, PAPO_LIMITS.embedDescriptionMax);
		if (e.url) input.url = clampText(e.url, PAPO_LIMITS.embedUrlMax);
		const color = typeof e.color === 'number' ? intToHex(e.color) : undefined;
		if (color) input.color = color;
		if (e.author?.name) {
			input.author = { name: clampText(e.author.name, PAPO_LIMITS.embedAuthorMax) };
			if (e.author.url) input.author.url = clampText(e.author.url, PAPO_LIMITS.embedUrlMax);
			// avatar do autor: o backend do Papo baixa e re-serva (author_media)
			if (e.author.icon_url) input.author.icon_url = clampText(e.author.icon_url, PAPO_LIMITS.embedUrlMax);
		}
		if (e.footer?.text) input.footer = { text: clampText(e.footer.text, PAPO_LIMITS.embedFooterMax) };
		const host = hostOf(e.url);
		if (host) input.site_name = clampText(host, 128);
		// O Papo renderiza a imagem da thumbnail; a imagem principal vira thumbnail quando é a única.
		const image = e.thumbnail?.url ?? e.image?.url;
		if (image) input.thumbnail = { url: clampText(image, PAPO_LIMITS.embedUrlMax) };
		if (e.fields?.length) {
			input.fields = e.fields.slice(0, PAPO_LIMITS.embedFieldsMax).map((f) => ({
				name: clampText(f.name, PAPO_LIMITS.embedFieldNameMax),
				value: clampText(f.value, PAPO_LIMITS.embedFieldValueMax),
				inline: Boolean(f.inline)
			}));
		}
		if (Object.keys(input).length) out.push(input);
	}
	return fitEmbedBudget(out, PAPO_LIMITS.embedTotalChars);
}

/** Embed do Papo → embed do Discord (metadados; mídia do Papo não tem URL pública). */
/**
 * Embeds do Papo → embeds do Discord.
 *
 * `thumbnailUrlFor`: o Papo não expõe a imagem do embed por URL (o payload traz só
 * mime/width/height/size). Quem tem os bytes é `GET /embeds/{id}` (`image_data`);
 * o bridge re-hospeda no media server e passa a URL daqui.
 */
export function papoEmbedsToDiscord(
	embeds: PapoEmbed[],
	opts: { thumbnailUrlFor?: (embed: PapoEmbed) => string | undefined } = {}
): DiscordEmbedPayload[] {
	const out: DiscordEmbedPayload[] = [];
	for (const e of embeds.slice(0, DISCORD_LIMITS.embedsPerMessage)) {
		const payload: DiscordEmbedPayload = {};
		if (e.title) payload.title = clampText(e.title, DISCORD_LIMITS.embedTitleMax);
		if (e.description) payload.description = clampText(e.description, DISCORD_LIMITS.embedDescriptionMax);
		if (e.url) payload.url = e.url;
		const color = hexToInt(e.color);
		if (color !== undefined) payload.color = color;
		if (e.author?.name) {
			payload.author = { name: clampText(e.author.name, DISCORD_LIMITS.embedAuthorMax) };
			if (e.author.url) payload.author.url = e.author.url;
		}
		if (e.footer?.text) payload.footer = { text: clampText(e.footer.text, DISCORD_LIMITS.embedFooterMax) };
		if (e.fields?.length) {
			payload.fields = e.fields.slice(0, DISCORD_LIMITS.embedFieldsMax).map((f) => ({
				name: clampText(f.name, DISCORD_LIMITS.embedFieldNameMax),
				value: clampText(f.value, DISCORD_LIMITS.embedFieldValueMax),
				inline: Boolean(f.inline)
			}));
		}
		const thumb = e.thumbnail?.url ?? e.image?.url ?? opts.thumbnailUrlFor?.(e);
		if (thumb) payload.thumbnail = { url: thumb };
		if (Object.keys(payload).length) out.push(payload);
	}
	return fitEmbedBudget(out, DISCORD_LIMITS.embedTotalChars);
}

export interface BridgeEmbedInput {
	authorName: string;
	authorIconUrl?: string;
	authorUrl?: string;
	description: string;
	footerText: string;
	timestamp?: string;
	colorHex?: string;
	title?: string;
	url?: string;
	imageUrl?: string;
	thumbnailUrl?: string;
	/** Selo de origem (linha de topo do card do Papo). Padrão: `Discord`. */
	siteName?: string;
	fields?: { name: string; value: string; inline?: boolean }[];
}

/** Embed "mensagem bridgeada" no Discord (autor do Papo + avatar + data). */
export function buildDiscordBridgeEmbed(i: BridgeEmbedInput): DiscordEmbedPayload {
	const payload: DiscordEmbedPayload = {
		author: {
			name: clampText(i.authorName, DISCORD_LIMITS.embedAuthorMax),
			...(i.authorUrl ? { url: i.authorUrl } : {}),
			...(i.authorIconUrl ? { icon_url: i.authorIconUrl } : {})
		},
		description: clampText(i.description, DISCORD_LIMITS.embedDescriptionMax),
		footer: { text: clampText(i.footerText, DISCORD_LIMITS.embedFooterMax) }
	};
	if (i.title) payload.title = clampText(i.title, DISCORD_LIMITS.embedTitleMax);
	if (i.url) payload.url = i.url;
	const color = hexToInt(i.colorHex);
	if (color !== undefined) payload.color = color;
	if (i.timestamp) payload.timestamp = i.timestamp;
	if (i.imageUrl) payload.image = { url: i.imageUrl };
	if (i.thumbnailUrl) payload.thumbnail = { url: i.thumbnailUrl };
	if (i.fields?.length) {
		payload.fields = i.fields.slice(0, DISCORD_LIMITS.embedFieldsMax).map((f) => ({
			name: clampText(f.name, DISCORD_LIMITS.embedFieldNameMax),
			value: clampText(f.value, DISCORD_LIMITS.embedFieldValueMax),
			inline: Boolean(f.inline)
		}));
	}
	return payload;
}

/** Embed "mensagem bridgeada" no Papo (autor do Discord + data + selo de origem). */
export function buildPapoBridgeEmbed(i: BridgeEmbedInput): PapoEmbedInput {
	const payload: PapoEmbedInput = {
		// O card do Papo desenha `site_name` na linha de topo e o ícone do autor
		// (`author_media`) no selo dessa linha: nome no topo, avatar no ícone.
		// A linha de autor do card é omitida pelo frontend quando repete o nome do topo.
		author: {
			name: clampText(i.authorName, PAPO_LIMITS.embedAuthorMax),
			...(i.authorUrl ? { url: i.authorUrl } : {}),
			...(i.authorIconUrl ? { icon_url: clampText(i.authorIconUrl, PAPO_LIMITS.embedUrlMax) } : {})
		},
		description: clampText(i.description, PAPO_LIMITS.embedDescriptionMax),
		footer: { text: clampText(i.footerText, PAPO_LIMITS.embedFooterMax) },
		site_name: clampText(i.authorName ?? 'Discord', 128)
	};
	if (i.title) payload.title = clampText(i.title, PAPO_LIMITS.embedTitleMax);
	if (i.url) payload.url = clampText(i.url, PAPO_LIMITS.embedUrlMax);
	if (i.colorHex && /^#[0-9a-fA-F]{6}$/.test(i.colorHex)) payload.color = i.colorHex;
	// O card do Papo não tem ícone de author e desenha a thumbnail como imagem grande
	// do card (largura total): avatar na thumbnail viraria banner. Só imagem de
	// conteúdo vai na thumbnail.
	if (i.thumbnailUrl) payload.thumbnail = { url: clampText(i.thumbnailUrl, PAPO_LIMITS.embedUrlMax) };
	if (i.imageUrl) payload.image = { url: clampText(i.imageUrl, PAPO_LIMITS.embedUrlMax) };
	if (i.fields?.length) {
		payload.fields = i.fields.slice(0, PAPO_LIMITS.embedFieldsMax).map((f) => ({
			name: clampText(f.name, PAPO_LIMITS.embedFieldNameMax),
			value: clampText(f.value, PAPO_LIMITS.embedFieldValueMax),
			inline: Boolean(f.inline)
		}));
	}
	return payload;
}
