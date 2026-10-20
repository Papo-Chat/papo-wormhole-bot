import type { PapoEmbed, PapoEmbedInput } from '../papo/types.js';
import { DISCORD_LIMITS, PAPO_IMAGE_MIMES, PAPO_LIMITS, PAPO_VIDEO_MIMES, clampText } from './limits.js';

/** Shape de embed: o que a API do Discord aceita gravar, mais o que ela devolve ao ler. */
export interface DiscordEmbedPayload {
	title?: string;
	description?: string;
	url?: string;
	color?: number;
	timestamp?: string;
	author?: { name: string; url?: string; icon_url?: string; proxy_icon_url?: string | null };
	footer?: { text: string; icon_url?: string };
	thumbnail?: DiscordEmbedMedia;
	image?: DiscordEmbedMedia;
	/**
	 * Vídeo que o Discord resolveu a partir da URL da mensagem. Somente leitura: a API não
	 * aceita gravar `video` — no destino, vídeo é sempre um **anexo** da mensagem.
	 */
	video?: DiscordEmbedMedia;
	/** Embed `components`: o preview novo do Discord, que aninha texto e mídia em componentes. */
	components?: DiscordComponentNode[];
	type?: string;
	fields?: { name: string; value: string; inline?: boolean }[];
	/**
	 * Anexos que este embed exige para existir. `attachment://` só resolve se o arquivo for
	 * reenviado em cada edit, então a referência é guardada no snapshot da cópia.
	 * Não é campo da API do Discord: é removido antes do envio.
	 */
	media_refs?: { name: string; sha: string }[];
}

/** Objeto de mídia de embed: `url` é a origem, `proxy_url` é o que o Discord re-serva. */
export interface DiscordEmbedMedia {
	url?: string | null;
	proxy_url?: string | null;
	content_type?: string | null;
	width?: number | null;
	height?: number | null;
}

/** Nó do embed `components` do Discord (preview de link de mídia). */
export interface DiscordComponentNode {
	type?: number;
	content?: string;
	accent_color?: number;
	components?: DiscordComponentNode[];
	accessory?: { media?: DiscordEmbedMedia };
	items?: { media?: DiscordEmbedMedia }[];
	media?: DiscordEmbedMedia;
}

export const intToHex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

/** Referência a um arquivo enviado junto da mensagem (o Discord resolve localmente). */
export const attachmentRef = (name: string): string => `attachment://${name}`;

/** Nome canônico do anexo de avatar (o sha vai inteiro para o edit reanexar). */
export const avatarAttachmentName = (sha: string, ext: string): string => `avatar-${sha}.${ext}`;

/** Nome canônico do anexo de mídia de preview (thumbnail/vídeo que o edit precisa reenviar). */
export const mediaAttachmentName = (sha: string, ext: string): string => `media-${sha}.${ext}`;

/** Extrai o sha256 de uma referência `attachment://avatar-<sha>.<ext>` ou `attachment://media-<sha>.<ext>`. */
export function shaFromAttachmentRef(url?: string | null): string | undefined {
	if (!url) return undefined;
	const m = /^attachment:\/\/(?:avatar|media)-([0-9a-f]{64})\.[a-z0-9]+$/.exec(url);
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

/** Nome do arquivo que uma referência `attachment://<nome>` exige no destino. */
export function attachmentRefName(url?: string | null): string | undefined {
	if (!url) return undefined;
	const m = /^attachment:\/\/([^\s]+)$/.exec(url);
	return m?.[1];
}

const VIDEO_EXT_MIME: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg' };
const IMAGE_EXT_MIME: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp',
	gif: 'image/gif',
	avif: 'image/avif',
	bmp: 'image/bmp'
};

/** Extensão final do caminho do URL (ignora query e assinatura de proxy). */
const pathExt = (url: string): string => {
	try {
		return /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? '';
	} catch {
		return '';
	}
};

/** MIME de uma URL de mídia pelo caminho, quando o payload não declara nenhum. */
export const mimeFromUrl = (url: string): string => VIDEO_EXT_MIME[pathExt(url)] ?? IMAGE_EXT_MIME[pathExt(url)] ?? '';

/** Mídia de embed já resolvida para o destino: URL e MIME garantidos. */
export interface DiscordMedia {
	/** URL escolhida para o destino (o proxy do Discord, quando houver). */
	url: string;
	/** URL da origem: o caminho é o que identifica a mesma mídia servida por outro host. */
	origin?: string;
	mime: string;
	width?: number;
	height?: number;
}

/**
 * URL de onde baixar a mídia que o Discord hospeda: o CDN é a forma canônica
 * (`media.discordapp.net` é só o proxy do mesmo arquivo).
 */
export const discordMediaSourceUrl = (media: DiscordMedia): string =>
	isDiscordMediaUrl(media.origin) ? media.origin! : media.url;

/** Mídia servida pelo Discord (na URL escolhida ou na origem): volátil, não pode virar embed no Papo. */
export const isDiscordHostedMedia = (media: DiscordMedia): boolean =>
	isDiscordMediaUrl(media.url) || isDiscordMediaUrl(media.origin);

const areaOf = (m: DiscordMedia): number => (m.width ?? 0) * (m.height ?? 0);

/**
 * Um objeto de mídia do Discord em forma utilizável.
 * `proxy_url` tem prioridade: é o que o próprio Discord re-serva — sem hotlink bloqueado na
 * origem e sem assinatura que expira, o que importa porque o relay de vídeo do Papo busca a
 * URL horas depois. Classifica pelo `content_type` e, na falta dele, pela extensão: um
 * `video.url` de página (o `/embed/` do YouTube) não é arquivo e não vira mídia. Como último
 * recurso, `playerFallback` aceita um `video` de embed que o Discord desenhou como player
 * quando ele re-serva o arquivo — é o mp4 sem extensão dos espelhos de Twitter/Instagram.
 */
const discordMediaOf = (m?: DiscordEmbedMedia | null, playerFallback = false): DiscordMedia | undefined => {
	const url = m?.proxy_url ?? m?.url;
	if (!url) return undefined;
	const declared = (m?.content_type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	// sem tipo declarado nem extensão, o único sinal confiável de que é arquivo e não página:
	// o Discord desenhou um player (gifv/gif/video) e re-serviu a mídia. O `/embed/` do YouTube
	// não tem proxy; o mp4 sem extensão de um espelho de Twitter tem
	const mime = declared || mimeFromUrl(url) || (playerFallback && m?.proxy_url ? 'video/mp4' : '');
	if (!mime) return undefined;
	return { url, origin: m?.url ?? undefined, mime, width: m?.width ?? undefined, height: m?.height ?? undefined };
};

/**
 * URL de mídia que o próprio URL carrega no query. Conversores de preview entregam um
 * intermediário (`convert.avif?url=https://video.twimg.com/....mp4`): o arquivo de verdade é o
 * de dentro — é o que preserva a animação, e o de fora costuma vir num formato que o destino
 * não decodifica.
 */
function embeddedMediaUrls(m?: DiscordEmbedMedia | null): string[] {
	if (!m?.url) return [];
	try {
		const out: string[] = [];
		for (const value of new URL(m.url).searchParams.values()) {
			if (/^https?:\/\//i.test(value) && mimeFromUrl(value)) out.push(value);
		}
		return out;
	} catch {
		return [];
	}
}

/** Percorre a árvore de componentes de um embed `components` do Discord. */
function walkComponents(nodes?: DiscordComponentNode[]): DiscordComponentNode[] {
	const out: DiscordComponentNode[] = [];
	const visit = (list?: DiscordComponentNode[]) => {
		for (const n of list ?? []) {
			out.push(n);
			visit(n.components);
		}
	};
	visit(nodes);
	return out;
}

/**
 * Imagem principal preferida para converter um embed ao Papo: use thumbnail quando existe;
 * image é fallback. Mídia de componentes fica como último recurso.
 */
export function preferredDiscordEmbedImage(embed: DiscordEmbedPayload): DiscordMedia | undefined {
	const supported = (media: DiscordMedia[]) =>
		media.find((candidate) => PAPO_IMAGE_MIMES.includes(candidate.mime));

	const fromThumbnail = supported(
		discordEmbedMedia({ ...embed, image: undefined, components: undefined }).images
	);
	if (fromThumbnail) return fromThumbnail;

	const fromImage = supported(
		discordEmbedMedia({ ...embed, thumbnail: undefined, components: undefined }).images
	);
	if (fromImage) return fromImage;

	return supported(discordEmbedMedia(embed).images);
}

/**
 * Toda mídia de um embed do Discord: embed simples (`image`/`thumbnail`/`video`) ou o preview
 * novo em componentes, que aninha mídia em `accessory`/`items`. Imagens vêm da maior para a menor.
 */
export function discordEmbedMedia(embed: DiscordEmbedPayload): { images: DiscordMedia[]; videos: DiscordMedia[] } {
	const images: DiscordMedia[] = [];
	const videos: DiscordMedia[] = [];
	// o tipo é o que o Discord desenhou: player. Autoriza aceitar um `video` sem tipo declarado
	// nem extensão desde que o Discord re-serva o arquivo
	const player = embed.type === 'video' || embed.type === 'gifv' || embed.type === 'gif';
	const push = (media: DiscordMedia | undefined): void => {
		if (!media) return;
		if (media.mime.startsWith('video/')) videos.push(media);
		else if (media.mime.startsWith('image/')) images.push(media);
	};
	const add = (m?: DiscordEmbedMedia | null, allowPlayerFallback = false): void => {
		push(discordMediaOf(m, allowPlayerFallback));
		// o URL entregue pode ser um conversor carregando o arquivo no query: o de dentro também
		// entra, e é ele que costuma ser reproduzível
		for (const url of embeddedMediaUrls(m)) {
			const mime = mimeFromUrl(url);
			if (!mime) continue;
			push({ url, origin: url, mime, width: m?.width ?? undefined, height: m?.height ?? undefined });
		}
	};
	/** Algumas embeds de bots omitem content_type e usam URL sem extensão no campo image. */
	const addImage = (m?: DiscordEmbedMedia | null): void => {
		const url = m?.proxy_url ?? m?.url;
		if (!url) return;
		const media = discordMediaOf(m);
		if (media?.mime.startsWith('image/')) push(media);
		else {
			const declared = (m?.content_type ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
			const extMime = mimeFromUrl(url);
			if (declared.startsWith('video/') || extMime.startsWith('video/')) {
				if (media) push(media);
			} else {
				push({
					url,
					origin: m?.url ?? undefined,
					mime: declared.startsWith('image/') ? declared : extMime.startsWith('image/') ? extMime : 'image/webp',
					width: m?.width ?? undefined,
					height: m?.height ?? undefined
				});
			}
		}
		for (const embeddedUrl of embeddedMediaUrls(m)) {
			const mime = mimeFromUrl(embeddedUrl);
			if (mime) push({ url: embeddedUrl, origin: embeddedUrl, mime, width: m?.width ?? undefined, height: m?.height ?? undefined });
		}
	};
	addImage(embed.image);
	addImage(embed.thumbnail);
	add(embed.video, player);
	for (const node of walkComponents(embed.components)) {
		addImage(node.media);
		addImage(node.accessory?.media);
		for (const item of node.items ?? []) addImage(item.media);
	}
	images.sort((a, b) => areaOf(b) - areaOf(a));
	return { images, videos };
}

/**
 * A imagem que representa o preview: a maior do embed. Avatar/ícone de canto fica de fora
 * quando o embed tem vídeo — no Papo a thumbnail é desenhada como imagem grande do card.
 */
const previewImageOf = (media: { images: DiscordMedia[]; videos: DiscordMedia[] }): DiscordMedia | undefined => {
	const [biggest] = media.images;
	if (!biggest) return undefined;
	const video = media.videos[0];
	return video && areaOf(biggest) * 4 < areaOf(video) ? undefined : biggest;
};

/** Marcações do Discord que o Papo não renderiza: emoji custom, timestamp relativo, texto pequeno. */
const discordMarkupToPapo = (text: string): string =>
	text
		.replace(/<a?:[A-Za-z0-9_]{1,32}:\d{1,25}>/g, '')
		.replace(/<t:\d{1,12}(?::\w{1,2})?>/g, '')
		.replace(/^-# /gm, '')
		.replace(/[ \t]+$/gm, '')
		.replace(/[ \t]*[·|][ \t]*$/g, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

/** Textos de um embed `components`, na ordem em que o Discord os desenha. */
function componentTexts(embed: DiscordEmbedPayload): string[] {
	return walkComponents(embed.components)
		.filter((n) => n.type === 10 && n.content)
		.map((n) => discordMarkupToPapo(n.content!))
		.filter(Boolean);
}

/** Título e corpo do preview em componentes: a primeira linha é o título, o resto é corpo. */
function componentTitleAndBody(texts: string[]): { title?: string; body?: string } {
	const [first, ...rest] = texts;
	if (!first) return {};
	const [head, ...tail] = first.split('\n');
	const blocks = [tail.filter((l) => l.trim()).join('\n'), ...rest].filter(Boolean);
	return {
		title: head?.trim() ? clampText(head.trim().replace(/\*\*|__|~~/g, ''), PAPO_LIMITS.embedTitleMax) : undefined,
		body: blocks.join('\n\n') || undefined
	};
}

/** Cor de destaque do preview em componentes. */
const componentColor = (embed: DiscordEmbedPayload): string | undefined => {
	const accent = walkComponents(embed.components).find((n) => typeof n.accent_color === 'number')?.accent_color;
	return accent === undefined ? undefined : intToHex(accent);
};

/**
 * Hosts onde o Discord hospeda a própria mídia: anexo, embed e emoji sobem para cá.
 * A URL é volátil — some quando a mensagem original é apagada, e o hotlink é bloqueado
 * para quem tenta re-servir fora do Discord.
 */
const DISCORD_MEDIA_HOSTS = new Set([
	'cdn.discordapp.com',
	'media.discordapp.net',
	'cdn.discordapp.net',
	'media.discordapp.com'
]);

/** Caminhos do CDN que são arquivo de mensagem (avatar/banner são imagem de identidade, não mídia). */
const DISCORD_MEDIA_PATH = /^\/(embed\/)?(attachments|embeds|emojis|stickers)\//i;

/**
 * Só `/attachments/` e `/embed/attachments/` são assinados. Os outros caminhos do CDN
 * (`/emojis/`, `/stickers/`, `/embeds/`) são públicos e não expiram.
 */
const DISCORD_SIGNED_PATH = /^\/(embed\/)?attachments\//i;

/**
 * URL de arquivo hospedado pelo Discord (`/attachments/…`, `/embeds/…`). O proxy de terceiros
 * (`images-ext-N.discordapp.net/external/…`) fica fora de propósito: ele re-serva conteúdo
 * de fora, não a mídia que o Discord hospeda.
 */
export function isDiscordMediaUrl(url?: string | null): boolean {
	const host = hostOf(url);
	if (!host || !DISCORD_MEDIA_HOSTS.has(host.toLowerCase())) return false;
	try {
		return DISCORD_MEDIA_PATH.test(new URL(url!).pathname);
	} catch {
		return false;
	}
}

/**
 * Momento em que a assinatura do link vence. Desde dez/2023 o CDN só serve anexo com
 * `?ex=&is=&hm=` válidos, e `ex` é o epoch de expiração em hexadecimal: link sem parâmetro
 * ou com `ex` no passado responde 404 mesmo com o arquivo vivo.
 */
export function discordSignatureExpiry(url?: string | null): number | undefined {
	try {
		const ex = new URL(url!).searchParams.get('ex');
		const seconds = ex ? Number.parseInt(ex, 16) : Number.NaN;
		return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Link de anexo do Discord que o CDN já não serve: falta assinatura ou ela venceu. É o caso
 * do link colado no texto (Discord mostra o link limpo, sem assinatura) e do job que volta
 * para a fila horas depois, quando a assinatura do payload original expirou.
 */
export function discordLinkIsStale(url?: string | null): boolean {
	const host = hostOf(url);
	if (!host || !DISCORD_MEDIA_HOSTS.has(host.toLowerCase())) return false;
	try {
		if (!DISCORD_SIGNED_PATH.test(new URL(url!).pathname)) return false;
		const expiry = discordSignatureExpiry(url);
		return expiry === undefined || expiry * 1000 <= Date.now();
	} catch {
		return false;
	}
}

/** Host legível, sem o `www.` que os dois lados mostram como ruído. */
const siteNameOf = (url?: string | null): string | undefined => hostOf(url)?.replace(/^www\./, '');

/** Opções da conversão Discord → Papo. */
export interface DiscordToPapoOptions {
	/**
	 * Mídia hospedada pelo Discord (`cdn.discordapp.com` / `media.discordapp.net`) sai do embed:
	 * a URL expira com a mensagem original e o backend do Papo não consegue re-servi-la depois.
	 * Quem re-hospeda é o bridge (`discordHostedMedia`), e o destino da mídia vira anexo.
	 */
	rehostDiscordMedia?: boolean;
}

/** Embed do Discord → EmbedInput do Papo. */
export function discordEmbedsToPapo(embeds: DiscordEmbedPayload[], opts: DiscordToPapoOptions = {}): PapoEmbedInput[] {
	const out: PapoEmbedInput[] = [];
	for (const e of embeds.slice(0, PAPO_LIMITS.embedsPerMessage)) {
		const input: PapoEmbedInput = {};
		const texts = componentTexts(e);
		const parts = texts.length ? componentTitleAndBody(texts) : {};
		const title = e.title ?? parts.title;
		const description = e.description ?? parts.body;
		if (title) input.title = clampText(title, PAPO_LIMITS.embedTitleMax);
		if (description) input.description = clampText(description, PAPO_LIMITS.embedDescriptionMax);
		if (e.url) input.url = clampText(e.url, PAPO_LIMITS.embedUrlMax);
		const color = typeof e.color === 'number' ? intToHex(e.color) : componentColor(e);
		if (color) input.color = color;
		if (e.author?.name) {
			input.author = { name: clampText(e.author.name, PAPO_LIMITS.embedAuthorMax) };
			if (e.author.url) input.author.url = clampText(e.author.url, PAPO_LIMITS.embedUrlMax);
			// avatar do autor: o backend do Papo baixa e re-serva (author_media)
			const authorIcon = e.author.proxy_icon_url ?? e.author.icon_url;
			if (authorIcon) input.author.icon_url = clampText(authorIcon, PAPO_LIMITS.embedUrlMax);
		}
		if (e.footer?.text) input.footer = { text: clampText(e.footer.text, PAPO_LIMITS.embedFooterMax) };
		const host = siteNameOf(e.url);
		if (host) input.site_name = clampText(host, 128);
		let { images, videos } = discordEmbedMedia(e);
		if (opts.rehostDiscordMedia) {
			// mídia que o Discord hospeda é volátil: o bridge baixa e reenvia como anexo, e o
			// card fica com o texto/URL da página em vez de uma imagem que quebra
			images = images.filter((m) => !isDiscordHostedMedia(m));
			videos = videos.filter((m) => !isDiscordHostedMedia(m));
		}
		// O Papo renderiza a imagem da thumbnail; a imagem principal vira thumbnail quando é a única.
		// Só os formatos que o backend decodifica: um avif seria baixado e descartado (o preview
		// chegaria sem imagem), e um vídeo fora da allowlist faz o backend recusar a mensagem inteira.
		const preferredImage = preferredDiscordEmbedImage(e);
		const image =
			preferredImage && (!opts.rehostDiscordMedia || !isDiscordHostedMedia(preferredImage))
				? preferredImage
				: previewImageOf({
						images: images.filter((m) => PAPO_IMAGE_MIMES.includes(m.mime)),
						videos
					});
		if (image) {
			input.thumbnail = { url: clampText(image.url, PAPO_LIMITS.embedUrlMax) };
			if (image.mime === 'image/gif') input.thumbnail.mime_type = 'image/gif';
		}
		// Vídeo direto vira `video` no Papo: o backend re-serva pelo relay (GET /embeds/{id}/video)
		// e o card desenha o player. Página de player (YouTube) não é arquivo: fica só o cartão.
		const video = videos.find((v) => PAPO_VIDEO_MIMES.includes(v.mime));
		if (video) input.video = {
			url: clampText(video.url, PAPO_LIMITS.embedUrlMax),
			mime_type: video.mime
		};
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

/**
 * Mídia do preview já materializada pelo bridge: URL pública da thumbnail e anexos que a
 * mensagem precisa carregar. O Discord não aceita gravar `video` num embed — vídeo de
 * link-preview só chega ao destino como arquivo da mensagem.
 */
export interface PreviewMedia {
	thumbnailUrl?: string;
	refs?: { name: string; sha: string }[];
}

/**
 * Embeds do Papo → embeds do Discord.
 *
 * `thumbnailUrlFor`: o Papo não expõe a imagem do embed por URL (o payload traz só
 * mime/width/height/size). Quem tem os bytes é `GET /embeds/{id}` (`image_data`); o bridge
 * re-hospeda (media server ou anexo da mensagem) e passa a URL daqui.
 * `mediaFor`: mídia resolvida para este embed; as referências voltam em `media_refs` para o
 * edit poder reenviá-las.
 */
export function papoEmbedsToDiscord(
	embeds: PapoEmbed[],
	opts: {
		thumbnailUrlFor?: (embed: PapoEmbed) => string | undefined;
		mediaFor?: (embed: PapoEmbed) => PreviewMedia | undefined;
	} = {}
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
		const media = opts.mediaFor?.(e);
		const thumb = e.thumbnail?.url ?? e.image?.url ?? opts.thumbnailUrlFor?.(e) ?? media?.thumbnailUrl;
		if (thumb) payload.thumbnail = { url: thumb };
		if (media?.refs?.length) payload.media_refs = media.refs;
		if (Object.keys(payload).length) out.push(payload);
	}
	return fitEmbedBudget(out, DISCORD_LIMITS.embedTotalChars);
}

/**
 * Embed pronto para a API do Discord: sem os campos que só o bridge usa (`media_refs`, e a
 * mídia/vídeo que vieram de um embed lido e não podem ser gravados).
 */
export function discordApiEmbed<T extends DiscordEmbedPayload>(e: T): T {
	if (!e.media_refs && !e.video && !e.components) return e;
	const { media_refs: _refs, video: _video, components: _components, ...rest } = e;
	return rest as T;
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
