import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from 'pino';
import type { APIEmbed, Message as DiscordMessage, PartialMessage as PartialDiscordMessage } from 'discord.js';
import type { Config } from '../config.js';
import { scoped } from '../logger.js';
import type { ChannelLink, MessageMapRow, Store } from '../db/store.js';
import { Outbox, type OutboxRow } from '../db/outbox.js';
import { PapoApi, type SendMessageInput } from '../papo/api.js';
import { PapoApiError } from '../papo/types.js';
import { PapoWs } from '../papo/ws.js';
import { handlePapoCommand } from '../commands/papo-commands.js';

import type {
	PapoEmbed,
	PapoEmbedInput,
	PapoMessage,
	PapoWsAvatarEvent,
	PapoWsDeleteEvent,
	PapoWsEditEvent,
	PapoWsEmbedsEvent,
	PapoWsEvent,
	PapoWsMessageEvent,
	PapoWsModerationEvent,
	PapoWsPinEvent,
	PapoWsPresenceEvent,
	PapoWsPresenceSyncEvent,
	PapoWsReactEvent
} from '../papo/types.js';
import { DiscordBridge } from '../discord/bridge.js';
import { chunkLabel, chunkText } from './chunk.js';
import {
	authorLabel,
	discordToPapoContent,
	discordUserMentionIds,
	formatDate,
	papoEmojiNames,
	papoMentionIds,
	papoToDiscordContent,
	type TranslateResolvers
} from './translator.js';
import {
	attachmentRef,
	attachmentRefName,
	avatarAttachmentName,
	buildDiscordBridgeEmbed,
	buildPapoBridgeEmbed,
	discordApiEmbed,
	discordLinkIsStale,
	discordMediaSourceUrl,
	discordSignatureExpiry,
	fitEmbedBudget,
	mediaAttachmentName,
	mimeFromUrl,
	shaFromAttachmentRef,
	type DiscordEmbedPayload,
	type DiscordMedia,
	type PreviewMedia
} from './embeds.js';
import { prepareAttachments, sanitizeName, SourceGoneError, type SourceAttachment } from './attachments.js';
import { mergeReactionCounts, reactionSummaryText, type ReactionDisplay } from './reactions.js';
import { EMBED_CHUNK_CHARS, PAPO_LIMITS, PAPO_EMBED_CHUNK_CHARS, DISCORD_LIMITS, PAPO_VIDEO_MIMES, clampText } from './limits.js';
import { EmojiBridge, type ApplicationEmojiResolver, type GuildEmojiResolver } from './emoji.js';
import type { MediaStore } from './media.js';
import { PapoIdentity, type AuthorInfo } from './identity.js';
import { PapoWebhooks, type PapoWebhookRef } from '../papo/webhooks.js';
import { copySignatures, signedFooter } from './signature.js';
import {
	discordHostedMedia,
	discordMediaLinksInContent,
	firstDiscordLinkUrl,
	firstDiscordPreview,
	hasHyperlinkInContent,
	firstPapoPreview,
	mediaKey,
	rawDiscordEmbeds,
	stripDiscordMediaLinks
} from './previews.js';
import { EXTRA_CHUNK_BASE, type BridgeJob, type DeleteJob, type EditJob, type PinJob, type ReactionJob, type SourceRef, type ToDiscordMessageJob, type ToPapoMessageJob } from './jobs.js';
import { createHash } from 'node:crypto';

/** Erro permanente: retry não resolve (payload inválido, permissão, recurso sumido). */
class PermanentError extends Error {}

/** Erro transitório explícito: o job volta para a fila com backoff. */
class RetryableError extends Error {}

/**
 * Janela em que um eco esperado do Papo ainda vale. É curta de propósito: o eco chega
 * enquanto a nossa chamada ainda está em voo. Marcador de uso único + janela curta é o
 * que evita suprimir uma reação legítima igual à nossa.
 */
const SELF_REACTION_TTL_SECONDS = 20;

/** Janela em que uma edição do Discord ainda pode estar esperando o mapeamento da ponte. */
const EDIT_MAP_GRACE_MS = 5 * 60_000;

/** Janela em que um delete ainda espera o mapeamento da mensagem de origem aparecer. */
const DELETE_MAP_GRACE_MS = 10 * 60_000;

/** Resumo de reações: agrupa mudanças da mesma mensagem numa única re-escrita do embed. */
const FOOTER_DEBOUNCE_MS = 300;

/** Teto de espera pelos workers do bridge no encerramento. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

/** Selo de edição no rodapé do embed re-renderido (o texto novo vai no `description`). */
const EDIT_MARK = '✏️ editado · ';

/** Selo da linha de reações no `description` (footer de embed não renderiza emoji custom). */
const REACTION_MARK = '↳ ';

/**
 * Nota de reply da cópia de webhook. Webhook não responde mensagem (limitação da API do
 * Discord), então a referência chega como link no topo do `content` — o link é o que o leitor
 * do Discord usa para abrir a mensagem respondida, e o `de @autor` diz quem é sem precisar
 * abrir. Sem o rótulo do autor (cópia antiga, anterior à coluna) a nota fica só com o link.
 */
const replyNoteFor = (link?: string | null, author?: string | null): string => {
	if (!link) return '';
	const who = author ? ` de @${author}` : '';
	return `*Respondendo:[${link}]${who}*`;
};

/** Buscas no Discord por menção que o payload não trouxe, por mensagem. */
const MENTION_LOOKUP_LIMIT = 10;

/** Só converte embeds personalizados de bots/webhooks sem URL no conteúdo da mensagem. */
function shouldConvertCustomDiscordEmbeds(message: { content?: string | null; webhookId?: string | null; author?: { bot?: boolean } | null }): boolean {
	return Boolean(message.author?.bot || message.webhookId) && !hasHyperlinkInContent(message.content);
}

/** Identidade de uma reação do Papo, estável entre o evento WS e a execução do job. */
const papoReactionKey = (e: { emoji_id: string | null; unicode: string | null }): string =>
	e.emoji_id ? `e:${e.emoji_id}` : `u:${e.unicode ?? ''}`;

/** Chave canônica de um emoji no destino: id (custom) ou nome/unicode. */
const mirrorEmojiKey = (emojiId: string | null | undefined, nameOrUnicode: string | null | undefined): string =>
	emojiId ? `i:${emojiId}` : `u:${nameOrUnicode ?? ''}`;

/** Chave canônica a partir do token renderizável do Discord (`<:nome:id>`, `<a:nome:id>` ou unicode). */
const discordMirrorKey = (token: string): string => {
	const custom = /^<a?:[A-Za-z0-9_]{1,32}:(\d+)>$/.exec(token);
	return custom ? `i:${custom[1]}` : `u:${token}`;
};

/** Vocabulário de presença do Discord → vocabulário do Papo (`/online` cruza os dois). */
const DISCORD_STATUS_TO_PAPO: Record<string, string> = {
	online: 'online',
	idle: 'away',
	dnd: 'busy',
	invisible: 'offline',
	offline: 'offline'
};

/** Envelope persistido na coluna `payload` do outbox. */
interface Envelope {
	job: BridgeJob;
	embed?: DiscordEmbedPayload;
	embedsOnly?: boolean;
	embeds?: DiscordEmbedPayload[];
	/**
	 * Embeds **da origem (Papo)**, ainda não convertidos: a conversão e a busca da imagem
	 * acontecem na execução do job, como com os anexos. Assim a preparação de mídia não
	 * atrasa a entrada na fila — e não é ela que decide a ordem das atualizações.
	 */
	papoEmbeds?: PapoEmbed[];
	/**
	 * Preview de link **já convertido para o Papo** (origem Discord). O Discord anexa o
	 * preview de link depois de criar a mensagem, então ele chega por `MESSAGE_UPDATE` e é
	 * aplicado à cópia do Papo como estado separado do texto.
	 */
	papoPreviews?: PapoEmbedInput[];
	/** Re-rendera o embed da cópia com o resumo atual de reações (nome persistido no outbox). */
	footerOnly?: boolean;
}

/** Preview de link do Discord adiado até a cópia do Papo existir. */
interface DiscordPreviewDeferred {
	embed: PapoEmbedInput;
}

const isDiscordTransient = (err: unknown): boolean => {
	const status = (err as { status?: number })?.status;
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
	const msg = (err as Error)?.message ?? '';
	return /rate limit|429|timeout|ECONNRESET|socket hang up|fetch failed/i.test(msg);
};

const isPapoPermanent = (err: unknown): boolean =>
	err instanceof PapoApiError && (err.status === 400 || err.status === 403 || err.status === 404);

/** Discord 10014: o emoji não existe (ou está indisponível) para aquela mensagem. */
const isUnknownEmoji = (err: unknown): boolean => {
	const e = err as { code?: number; message?: string };
	return e?.code === 10014 || /unknown emoji/i.test(e?.message ?? '');
};

const GIF_SOURCE_DOMAINS = ['tenor.com', 'giphy.com', 'giphy.media', 'klipy.com'] as const;
const GIF_SOURCE_URL_RE = /https?:\/\/[^\s<>"'\x60)\]]+/g;

function isGifSourceUrl(raw?: string | null): boolean {
	if (!raw) return false;
	try {
		const url = new URL(raw);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
		const host = url.hostname.toLowerCase().replace(/\.$/, '');
		return GIF_SOURCE_DOMAINS.some((domain) => host === domain || host.endsWith('.' + domain));
	} catch {
		return false;
	}
}

function gifSourceUrlIn(content: string, embeds: readonly { url?: string | null }[] = []): string | undefined {
	for (const match of content.matchAll(GIF_SOURCE_URL_RE)) {
		const candidate = (match[0] ?? '').replace(/[.,;:!?]+$/, '');
		if (isGifSourceUrl(candidate)) return candidate;
	}
	return embeds.find((embed) => isGifSourceUrl(embed.url))?.url ?? undefined;
}

function withContentUrl(content: string, sourceUrl: string): string {
	return content.trim() ? content + '\n' + sourceUrl : sourceUrl;
}

function withGifSourceUrl(content: string, sourceUrl: string): string {
	return gifSourceUrlIn(content) ? content : withContentUrl(content, sourceUrl);
}

export class Bridge {
	private readonly log: Logger;
	private papoUserId?: string;
	private readonly identity: PapoIdentity;
	private readonly emojis: EmojiBridge;
	/** Um worker serializado por canal-link (preserva a ordem da conversa). */
	private readonly running = new Map<number, Promise<void>>();
	/**
	 * Enqueue que chegou enquanto o worker do link estava ativo: o `claimNext` final do
	 * worker pode ter rodado antes do enqueue. O flag força o worker a re-checar a fila
	 * antes de encerrar, senão o job órfão esperaria até o próximo evento.
	 */
	private readonly rerun = new Set<number>();
	/** Encerramento: para a ingestão e deixa só os jobs em voo terminarem. */
	private stopping = false;
	/** Links cuja participação em thread já foi conferida neste processo (join é REST). */
	private readonly threadsChecked = new Set<number>();
	/** Refresh de resumo de reações, agrupado por mensagem de origem. */
	private readonly footerTimers = new Map<
		string,
		{
			args: { linkId: number; source: 'papo' | 'discord'; sourceMessageId: string; targetChannelId: string };
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(
		private cfg: Config,
		private store: Store,
		private outbox: Outbox,
		private api: PapoApi,
		private ws: PapoWs,
		private discord: DiscordBridge,
		private media: MediaStore,
		/**
		 * Pool de webhooks do bridge no Papo (modo webhook Discord → Papo). Ausente = as
		 * cópias do Papo continuam pelo cartão do bot (mesma queda do lado Discord).
		 */
		private papoWebhooks?: PapoWebhooks
	) {
		this.log = scoped('bridge');
		this.identity = new PapoIdentity(api, store, media, cfg.bridge.mediaBaseUrl);
		this.emojis = new EmojiBridge(api, store, { autoImport: cfg.bridge.emojiAutoImport });
	}

	// ── ciclo de vida ──────────────────────────────────────

	async start(): Promise<void> {
		await this.api.ensureSession();
		const me = await this.api.whoami();
		this.papoUserId = me.id;
		this.log.info({ user: me.username, id: me.id }, 'sessão Papo ativa');

		await this.discord.login();
		this.ws.connect();

		// modo webhook Discord → Papo: as linhas de webhook com credencial morta são descartadas
		// antes da primeira cópia, e a indisponibilidade fica registrada no log em vez de aparecer
		// só quando uma mensagem cai para o cartão do bot.
		if (this.papoWebhooks) {
			const state = await this.papoWebhooks.reconcile();
			if (state) this.log.info(state, 'webhooks do bridge no Papo ativos');
			else this.log.warn('gestão de webhooks do Papo indisponível: cópias Discord → Papo podem sair pelo cartão do bot');
		}

		if (this.cfg.papo.backfillOnStart) await this.backfill();
		await this.drain();
	}

	/**
	 * Encerra em camadas: para a ingestão, fecha as conexões e aguarda os workers em voo.
	 * Quem chama pode então fechar o banco sem cortar um envio pela metade.
	 */
	async stop(): Promise<void> {
		this.stopping = true;
		this.flushFooterTimers();
		this.ws.close();
		await this.discord.destroy();
		const inFlight = [...this.running.values()];
		if (!inFlight.length) return;
		this.log.info({ workers: inFlight.length }, 'aguardando workers do bridge');
		await Promise.race([Promise.allSettled(inFlight), sleep(SHUTDOWN_DRAIN_TIMEOUT_MS)]);
	}

	/** Retoma jobs deixados em `in_flight` por um crash. */
	async drain(): Promise<void> {
		const requeued = this.outbox.requeueStale(30_000);
		if (requeued) this.log.warn({ requeued }, 'jobs em in_flight devolvidos à fila');
		const pruned = this.store.pruneSelfReactions(SELF_REACTION_TTL_SECONDS * 10);
		if (pruned) this.log.debug({ pruned }, 'registro de reações próprias expirado');
		const stale = this.store.pruneDeferredEvents(6 * 3600);
		if (stale) this.log.warn({ stale }, 'eventos adiados sem bridge descartados');
		const tombstones = this.store.pruneTombstones(24 * 3600);
		if (tombstones) this.log.debug({ tombstones }, 'tombstones de exclusão expirados');
		for (const link of this.store.listChannelLinks()) this.scheduleLink(link.id);
		await this.syncThreads();
	}

	/**
	 * Thread linkada: o Discord só entrega as mensagens de uma thread a quem é membro dela.
	 * Cada link é conferido uma vez por processo (join é chamada REST).
	 */
	private async syncThreads(): Promise<void> {
		for (const link of this.store.listChannelLinks()) {
			if (this.threadsChecked.has(link.id)) continue;
			this.threadsChecked.add(link.id);
			// melhor esforço: o drain não pode parar por causa de thread
			const joined = await this.discord.ensureThreadMembership?.(link.discord_channel_id);
			if (joined === undefined) continue;
			if (joined) this.log.info({ linkId: link.id, thread: link.discord_channel_id }, 'bridge entrou na thread linkada');
			else this.log.warn({ linkId: link.id, thread: link.discord_channel_id }, 'thread linkada sem acesso: mensagens não chegam');
		}
	}

	private async backfill(): Promise<void> {
		for (const link of this.store.listChannelLinks()) {
			try {
				// A fila começa no instante em que o link foi criado (cursor semeado por
				// `upsertChannelLink`): sem cursor não se busca histórico nenhum.
				const since = this.store.getPapoCursor(link.id) ?? this.store.seedPapoCursor(link.id);
				const messages = await this.api.listAllMessages(link.papo_channel_id, since, 2);
				const fresh = messages.filter((m) => this.store.findMapByPapo(m.id).length === 0);
				if (fresh.length) this.log.info({ linkId: link.id, total: messages.length, fresh: fresh.length }, 'backfill');
				for (const m of fresh) {
					await this.onPapoMessage(m);
					if (m.created_at) this.store.setPapoCursor(link.id, m.created_at);
				}
			} catch (err) {
				this.log.error({ err, linkId: link.id }, 'backfill falhou');
			}
		}
	}

	// ── eventos Papo ───────────────────────────────────────

	onPapoEvent(event: PapoWsEvent): void {
		if (this.stopping) return; // encerrando: nada novo entra
		void this.handlePapoEvent(event).catch((err) => this.log.error({ err, type: event.type }, 'evento Papo falhou'));
	}

	private async handlePapoEvent(event: PapoWsEvent): Promise<void> {
		switch (event.type) {
			case 'message':
				return this.onPapoMessage(event as PapoWsMessageEvent);
			case 'message_edit':
				return this.onPapoEdit(event as PapoWsEditEvent);
			case 'message_delete':
				return this.onPapoDelete(event as PapoWsDeleteEvent);
			case 'message_embeds_update':
				return this.onPapoEmbeds(event as PapoWsEmbedsEvent);
			case 'react_update':
				return this.onPapoReaction(event as PapoWsReactEvent);
			case 'avatar_update':
				return this.onAvatarUpdate(event as PapoWsAvatarEvent);
			case 'attachment_moderation_update':
				return this.onPapoModeration(event as PapoWsModerationEvent);
			case 'message_pin':
				return this.onPapoPin(event as PapoWsPinEvent);
			case 'presence_update': {
				const e = event as PapoWsPresenceEvent;
				this.store.setPresence('papo', e.user_id, e.status);
				return;
			}
			case 'presence_sync': {
				const e = event as PapoWsPresenceSyncEvent;
				for (const m of e.members ?? []) this.store.setPresence('papo', m.user_id, m.status);
				return;
			}
			default:
				return;
		}
	}

	private linkForPapoChannel(channelId: string): ChannelLink | undefined {
		const link = this.store.getChannelLinkByPapo(channelId);
		if (!link || link.paused || link.mode === 'to_papo') return undefined;
		return link;
	}

	private linkForDiscordChannel(channelId: string): ChannelLink | undefined {
		const link = this.store.getChannelLinkByDiscord(channelId);
		if (!link || link.paused || link.mode === 'to_discord') return undefined;
		return link;
	}

	/** O env é o interruptor global; o flag do link liga a propagação naquele canal. */
	private propagatesMentions(link?: ChannelLink): boolean {
		return this.cfg.bridge.propagateMentions || (link?.propagate_mentions ?? 0) === 1;
	}

	private resolvers(link?: ChannelLink): TranslateResolvers {
		return {
			propagateMentions: this.propagatesMentions(link),
			timezone: this.cfg.bridge.timezone,
			papoUserLabel: (id) => {
				const u = this.store.getPapoUser(id);
				return u ? authorLabel(u.nickname, u.username) : undefined;
			},
			discordUserIdForPapo: (id) => this.store.getLinkByPapoUser(id)?.discord_user_id,
			discordUserLabel: (id) => {
				const u = this.store.getDiscordUser(id);
				return u?.display_name ?? u?.username ?? undefined;
			},
			papoUserIdForDiscord: (id) => this.store.getLinkByDiscordUser(id)?.papo_user_id,
			// resolução por nome (item 28): só tem efeito quando `propagateMentions` liga
			papoUserIdForName: (name) => this.resolvePapoByName(name),
			discordUserIdForName: (name) => this.discord.memberByName?.(name)?.id,
			discordChannelLabel: (id) => this.discord.channelName(id),
			discordRoleLabel: (id) => this.discord.roleName(id),
			discordEmoji: (name) => ({
				token: this.emojis.tokenForDiscord(name, this.guildEmojis, this.appEmojis)
			}),
			papoEmojiName: (name) => this.emojis.papoNameForDiscord(name)
		};
	}

	/** Emoji do guild: o primeiro lugar procurado (qualquer usuário do servidor pode usá-lo). */
	private get guildEmojis(): GuildEmojiResolver {
		return { findByName: (name) => this.discord.findGuildEmoji?.(name) };
	}

	/**
	 * Emoji da aplicação (`ApplicationEmojiManager`): fallback quando o guild não tem o nome.
	 * Renderiza em qualquer canal e não ocupa slot do servidor, mas só o app que o criou pode
	 * usá-lo — e toda cópia que o bridge escreve no Discord é do app (cartão ou webhook).
	 */
	private get appEmojis(): ApplicationEmojiResolver {
		return {
			findByName: (name) => this.discord.findApplicationEmoji?.(name),
			count: () => this.discord.applicationEmojiCount?.() ?? 0,
			load: () => this.discord.loadApplicationEmojis?.() ?? Promise.resolve(),
			create: async (name, image) => await this.discord.createApplicationEmoji?.(name, image)
		};
	}

	/**
	 * Pré-resolve os emojis custom do texto que vai para o Discord: garante o equivalente
	 * (emoji do guild, emoji da aplicação já existente, ou emoji da aplicação criado a partir
	 * da imagem do emoji no Papo) antes de o tradutor rodar — assim a primeira mensagem já
	 * sai renderizada. Falha de criação não derruba a ponte: o texto segue com `:nome:`.
	 */
	private async warmDiscordEmojis(...texts: (string | null | undefined)[]): Promise<void> {
		const names = new Set<string>();
		for (const text of texts) for (const name of papoEmojiNames(text ?? '')) names.add(name);
		for (const name of names) await this.emojis.ensureDiscordToken(name, this.guildEmojis, this.appEmojis);
	}

	/** Importa emojis custom do Discord ausentes no Papo antes da tradução da mensagem. */
	private async warmPapoEmojis(...texts: (string | null | undefined)[]): Promise<void> {
		const seen = new Set<string>();
		for (const text of texts) {
			for (const match of (text ?? '').matchAll(/<(a?):([A-Za-z0-9_]+):(\d+)>/g)) {
				const [, animatedFlag, name, id] = match;
				if (!name || !id || seen.has(name.toLowerCase())) continue;
				seen.add(name.toLowerCase());
				try {
					await this.emojis.shortcodeForPapo(name, id, animatedFlag === 'a', this.guildEmojis);
				} catch (err) {
					this.log.debug({ err, emoji: name }, 'emoji Discord não pôde ser importado para o Papo');
				}
			}
		}
	}

	private sourceRefs(msg: PapoMessage | PapoWsMessageEvent): SourceRef[] {
		return (msg.attachments ?? []).map((a) => ({
			side: 'papo',
			id: a.id,
			name: a.original_file_name,
			mime: a.mime_type,
			sizeBytes: a.size_bytes,
			url: `${this.cfg.papo.baseUrl}/attachments/${a.id}`,
			moderationStatus: a.moderation_status
		}));
	}

	/**
	 * Cópia bridgeada da mensagem que está sendo respondida. Sem cópia (mensagem anterior
	 * ao link, ou apagada) o reply simplesmente não é propagado: não existe id de destino.
	 * A linha é o que dá o id **e** o autor da nota de reply (`de @autor`).
	 */
	private replyCopy(papoMessageId?: string | null): MessageMapRow | undefined {
		if (!papoMessageId) return undefined;
		return this.store.findMapByPapo(papoMessageId).find((r) => !r.deleted && r.discord_message_id);
	}

	private copyForPapoMessage(papoMessageId?: string | null): string | undefined {
		return this.replyCopy(papoMessageId)?.discord_message_id ?? undefined;
	}

	private copyForDiscordMessage(discordMessageId?: string | null): string | undefined {
		if (!discordMessageId) return undefined;
		return this.store.findMapByDiscord(discordMessageId).find((r) => !r.deleted && r.papo_message_id)?.papo_message_id ?? undefined;
	}

	private async onPapoMessage(msg: PapoWsMessageEvent | PapoMessage): Promise<void> {
		if (msg.author_id === this.papoUserId) return; // anti-loop
		// Cópia criada pelo webhook do bridge: o autor não é o bot (mensagem de webhook tem
		// `author_id` vazio). O registro de posse em `papo_webhooks` é o que distingue o eco
		// de um webhook de terceiro no canal — webhook alheio continua sendo ponteado.
		if (this.papoWebhooks?.owns(msg.webhook_id)) return; // anti-loop
		if (this.store.findMapByPapo(msg.id).length) return; // idempotência

		//se for um comando ja despachamos logo
		if (!msg.webhook_id && await handlePapoCommand(
		{ id: msg.id, channelId: msg.channel_id, authorId: msg.author_id, content: msg.content || "", createdAt: msg.created_at },
		{api: this.api,bridge: this,outbox: this.outbox,store: this.store},           
		{client: this.discord.client, reply: async (text) => {await this.api.sendMessage({channelId: msg.channel_id, content: text})} }
		)) return;
		const link = this.linkForPapoChannel(msg.channel_id);
		if (!link) return;

		// webhook de terceiro no canal: não é usuário do Papo e não tem perfil — a identidade de
		// exibição é a que o próprio webhook declara. Sem `authorId` a cópia sai pelo cartão do bot.
		const author: AuthorInfo = msg.webhook_id
			? { userId: '', name: msg.external_author?.name || 'Webhook', username: msg.external_author?.name || 'Webhook' }
			: await this.identity.author(msg.author_id);
		await this.warmPapoMentions(msg.content ?? '');
		if (this.propagatesMentions(link) && /@/.test(msg.content ?? '')) await this.discord.ensureMemberIndex?.();
		const preview = await this.papoPreview(msg);
		await this.warmDiscordEmojis(preview.text);
		const translated = papoToDiscordContent(preview.text, this.resolvers(link));
		const chunks = chunkText(translated, EMBED_CHUNK_CHARS);
		const sources = link.bridge_attachments ? this.sourceRefs(msg) : [];
		if (!chunks.length && !sources.length && !preview.embed) return;

		const total = Math.max(chunks.length, 1);
		for (let i = 0; i < total; i++) {
			const description = chunks[i] ?? '';
			const job: ToDiscordMessageJob = {
				kind: 'message',
				linkId: link.id,
				papoChannelId: msg.channel_id,
				discordChannelId: link.discord_channel_id,
				papoMessageId: msg.id,
				chunkIndex: i,
				chunkTotal: total,
				description,
				authorId: author.userId,
				authorName: author.name,
				authorIconSha: author.avatarSha,
				colorHex: link.color ?? undefined,
				timestamp: msg.created_at,
				notes: [],
				sources: i === 0 ? sources : [],
				linkEmbeds: i === 0 && preview.embed ? [preview.embed] : [],
				replyRefPapoId: i === 0 ? (msg.reply_to ?? undefined) : undefined
			};
			let embed = buildDiscordBridgeEmbed({
				authorName: author.name,
				authorIconUrl: author.avatarUrl,
				description,
				footerText: `🕒 ${formatDate(msg.created_at, this.cfg.bridge.timezone)} · Papo${chunkLabel(i, total)}`,
				colorHex: link.color ?? undefined
			});
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_discord',
				kind: 'message',
				dedupeKey: `papo:${msg.id}:to_discord:${i}`,
				payload: { job, embed } satisfies Envelope
			});
		}
		this.store.setPapoCursor(link.id, msg.created_at);
		this.scheduleLink(link.id);
	}

	/**
	 * Preview que acompanha o cartão da ponte no Discord.
	 *
	 * O backend é responsável por descobrir GIFs e gerar os embeds. O bridge só consome
	 * `msg.embeds` quando disponíveis e encaminha o texto/URLs sem resolver marcadores
	 * específicos de provedor.
	 */
	private async papoPreview(msg: { content?: string | null; embeds?: PapoEmbed[] | null }): Promise<{
		text: string;
		embed?: DiscordEmbedPayload;
	}> {
		const content = msg.content ?? '';
		if (msg.embeds?.length) {
			const embed = await this.papoPreviewEmbed(msg.embeds);
			if (embed) return { text: content, embed };
		}
		return { text: content };
	}

	/** Primeiro preview do Papo convertido para o Discord, com a mídia materializada. */
	private async papoPreviewEmbed(embeds: PapoEmbed[] | null | undefined): Promise<DiscordEmbedPayload | undefined> {
		if (!embeds?.length) return undefined;
		const media = await this.previewMediaFor(embeds);
		return firstPapoPreview(embeds, { mediaFor: (embed) => (embed.id ? media.get(embed.id) : undefined) });
	}

	/**
	 * Rótulos das menções do Papo: batch de perfil (`POST /users/user_summary_batch`) antes de
	 * traduzir. Busca que falha não derruba a ponte de texto — o tradutor cai em `@usuário`.
	 */
	private async warmPapoMentions(content: string): Promise<void> {
		const ids = papoMentionIds(content);
		if (!ids.length) return;
		await this.identity.warm(ids).catch((err) => this.log.debug({ err }, 'perfil de mencionado não resolvido'));
	}

	/** Índice nome→uuid dos usuários do Papo (resolução de `@nome`, item 28); TTL curto. */
	private papoNameIndex = { at: 0, byUsername: new Map<string, string>(), byNickname: new Map<string, string | null>() };
	private static readonly PAPO_NAME_INDEX_TTL_MS = 10 * 60_000;

	private async ensurePapoNameIndex(): Promise<void> {
		if (this.papoNameIndex.at && Date.now() - this.papoNameIndex.at < Bridge.PAPO_NAME_INDEX_TTL_MS) return;
		try {
			const users = await this.api.listAllUsers();
			const byUsername = new Map<string, string>();
			const byNickname = new Map<string, string | null>();
			for (const u of users) {
				const username = u.username?.trim().toLowerCase();
				if (username) byUsername.set(username, u.id);
				const nickname = u.nickname?.trim().toLowerCase();
				if (!nickname) continue;
				if (byNickname.get(nickname) === null) continue; // já ambíguo
				if (byNickname.has(nickname)) {
					byNickname.set(nickname, null);
					continue;
				}
				byNickname.set(nickname, u.id);
			}
			this.papoNameIndex = { at: Date.now(), byUsername, byNickname };
		} catch (err) {
			this.log.debug({ err }, 'falha ao carregar o índice de usuários do Papo');
		}
	}

	/** Usuário do Papo por username/nickname; username tem prioridade. `undefined` sem match único. */
	private resolvePapoByName(name: string): string | undefined {
		const wanted = name.trim().toLowerCase();
		if (!wanted) return undefined;
		const byUsername = this.papoNameIndex.byUsername.get(wanted);
		if (byUsername) return byUsername;
		return this.papoNameIndex.byNickname.get(wanted) ?? undefined;
	}

	private async onPapoEdit(e: PapoWsEditEvent): Promise<void> {
		const link = this.linkForPapoChannel(e.channel_id);
		if (!link || !link.bridge_edits) return;
		const maps = this.store.findMapByPapo(e.id);
		if (this.allCopiesHere(maps, 'papo')) {
			// eco: foi o próprio bridge que reescreveu o embed da cópia (resumo de reação).
			// A mensagem do Discord é de outro autor e o Discord recusa a edição (50005).
			this.log.debug({ messageId: e.id }, 'edição de cópia do bot no Papo: eco ignorado');
			return;
		}
		await this.warmPapoMentions(e.content ?? '');
		if (this.propagatesMentions(link) && /@/.test(e.content ?? '')) await this.discord.ensureMemberIndex?.();
		const preview = await this.papoPreview(e);
		await this.warmDiscordEmojis(preview.text);
		const chunks = chunkText(papoToDiscordContent(preview.text, this.resolvers(link)), EMBED_CHUNK_CHARS);
		// sem mapeamento a mensagem ainda está na fila de bridge: o job re-tenta até ela aparecer
		const targets = maps.length
			? maps
					.filter((m) => m.discord_message_id && m.direction === 'papo_to_discord')
					.map((m) => ({ chunkIndex: m.chunk_index, chunkTotal: Math.max(chunks.length, m.chunk_total) }))
			: chunks.map((_, i) => ({ chunkIndex: i, chunkTotal: chunks.length }));
		if (!targets.length && preview.embed) targets.push({ chunkIndex: 0, chunkTotal: 1 });
		const revision = e.edited_at ?? new Date().toISOString();
		for (const target of targets) {
			const job: EditJob = {
				kind: 'edit',
				side: 'papo',
				linkId: link.id,
				sourceMessageId: e.id,
				targetChannelId: link.discord_channel_id,
				chunkIndex: target.chunkIndex,
				chunkTotal: target.chunkTotal,
				text: chunks[target.chunkIndex] ?? '',
				revision
			};
			// chave por mensagem/chunk, sem timestamp: a edição mais nova substitui a que
			// ainda não saiu, em vez de virar um segundo job na fila
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_discord',
				kind: 'edit',
				dedupeKey: `papo-edit:${e.id}:${target.chunkIndex}`,
				revision,
				payload: { job } satisfies Envelope
			});
			// preview é estado separado do texto: tem chave e revisão próprias
			if (preview.embed) this.enqueueDiscordPreview(link, e.id, target, preview.embed, revision);
		}
		this.scheduleLink(link.id);
	}

	private enqueueDiscordPreview(
		link: ChannelLink,
		sourceMessageId: string,
		target: { chunkIndex: number; chunkTotal: number },
		embed: DiscordEmbedPayload,
		revision: string
	): void {
		const job: EditJob = {
			kind: 'edit',
			side: 'papo',
			linkId: link.id,
			sourceMessageId,
			targetChannelId: link.discord_channel_id,
			chunkIndex: target.chunkIndex,
			chunkTotal: target.chunkTotal,
			text: '',
			revision
		};
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'edit',
			dedupeKey: `papo-embeds:${sourceMessageId}:${target.chunkIndex}`,
			revision,
			payload: { job, embedsOnly: true, embeds: [embed] } satisfies Envelope
		});
	}

	private async onPapoDelete(e: PapoWsDeleteEvent): Promise<void> {
		const link = this.store.getChannelLinkByPapo(e.channel_id);
		if (!link || !link.bridge_deletes) return;
		// tombstone primeiro: é o que reconcilia um delete chegado antes do mapeamento —
		// o job de criação é suprimido em vez de criar uma cópia órfã
		this.store.tombstoneMessage('papo', e.id);
		const maps = this.store.findMapByPapo(e.id);
		if (this.allCopiesHere(maps, 'papo')) {
			// A cópia do bot no Papo sumiu (eco de deleção nascida no Discord, ou moderação):
			// o mapa não vale mais, mas a mensagem original do Discord é de outro autor e
			// não pode ser apagada por reflexo.
			this.store.markMapDeleted(e.id);
			this.log.debug({ messageId: e.id }, 'deleção de cópia do bot no Papo: original do Discord preservado');
			return;
		}
		this.store.markMapDeleted(e.id);
		if (!maps.length) {
			// a mensagem ainda está na fila de bridge: o tombstone já cancela a criação e o
			// job de delete só entra quando houver cópia a apagar
			this.log.debug({ messageId: e.id }, 'delete sem mapeamento: criação da cópia suprimida');
			return;
		}
		const job: DeleteJob = { kind: 'delete', side: 'papo', linkId: link.id, sourceMessageId: e.id };
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'delete',
			dedupeKey: `papo-delete:${e.id}`,
			payload: { job } satisfies Envelope
		});
		this.scheduleLink(link.id);
	}

	/**
	 * `true` quando existe mapeamento e todas as linhas apontam para uma cópia criada pelo
	 * bot naquele lado — o evento é eco do que o próprio bridge fez, não ação de um usuário.
	 */
	private allCopiesHere(maps: MessageMapRow[], side: 'papo' | 'discord'): boolean {
		if (!maps.length) return false;
		const copyDirection = side === 'papo' ? 'discord_to_papo' : 'papo_to_discord';
		return maps.every((m) => m.direction === copyDirection);
	}

	/**
	 * `message_embeds_update` do Papo: o preview de link da mensagem.
	 *
	 * A revisão é capturada na **chegada** do evento, antes de qualquer espera: buscar a
	 * imagem do preview é assíncrono, e uma atualização antiga que demorasse mais seria
	 * enfileirada depois da mais recente. A conversão acontece na execução do job, então a
	 * fila (serializada por link) decide a ordem — e a revisão decide qual estado vence.
	 */
	private async onPapoEmbeds(e: PapoWsEmbedsEvent): Promise<void> {
		const link = this.linkForPapoChannel(e.channel_id);
		if (!link || !link.bridge_embeds) return;
		const revision = new Date().toISOString();
		const maps = this.store.findMapByPapo(e.message_id);
		if (!maps.length) {
			// o preview chegou antes da cópia: fica adiado e é enfileirado pelo flush que
			// acompanha a criação do mapeamento
			this.store.deferEvent({ source: 'papo', sourceMessageId: e.message_id, kind: 'embeds', payload: e });
			this.log.debug({ messageId: e.message_id }, 'preview adiado: mensagem ainda não bridgeada');
			return;
		}
		this.enqueuePapoEmbeds(link, maps, e, revision);
		this.scheduleLink(link.id);
	}

	/** Enfileira o preview de uma mensagem Papo para cada cópia Discord. Sincrono: cabe no flush transacional. */
	private enqueuePapoEmbeds(link: ChannelLink, maps: MessageMapRow[], e: PapoWsEmbedsEvent, revision: string): number {
		let enqueued = 0;
		for (const map of maps) {
			if (!map.discord_message_id || map.direction !== 'papo_to_discord') continue;
			const job: EditJob = {
				kind: 'edit',
				side: 'papo',
				linkId: link.id,
				sourceMessageId: e.message_id,
				targetChannelId: link.discord_channel_id,
				chunkIndex: map.chunk_index,
				chunkTotal: map.chunk_total,
				text: '',
				revision
			};
			// chave por mensagem/chunk, com revisão: conteúdo diferente é estado novo da
			// mesma chave, e o mais recente substitui o que ainda não saiu
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_discord',
				kind: 'edit',
				dedupeKey: `papo-embeds:${e.message_id}:${map.chunk_index}`,
				revision,
				payload: { job, embedsOnly: true, papoEmbeds: e.embeds ?? [] } satisfies Envelope
			});
			enqueued += 1;
		}
		return enqueued;
	}

	/**
	 * Mídia do preview de link, materializada no cache do bridge.
	 *
	 * Imagem: o payload do Papo não traz URL — só mime/medidas; os bytes vêm de
	 * `GET /embeds/{id}` (`image_data`). Com media server público a thumbnail vira URL
	 * absoluta; sem ele vira anexo da mensagem (`attachment://`), que o Discord resolve com o
	 * arquivo reenviado em cada edit.
	 * Vídeo: o Discord não grava `video` em embed criado por bot — o arquivo é baixado e
	 * anexado à mensagem, e é o anexo que faz o preview do Twitter/Instagram virar player.
	 */
	private async previewMediaFor(embeds: PapoEmbed[]): Promise<Map<string, PreviewMedia>> {
		const out = new Map<string, PreviewMedia>();
		for (const embed of embeds) {
			if (!embed.id) continue;
			const media: PreviewMedia = {};
			const image = await this.embedImageMedia(embed);
			if (image) {
				const publicUrl = this.media.urlFor(image.sha, this.cfg.bridge.mediaBaseUrl);
				if (publicUrl) media.thumbnailUrl = publicUrl;
				else {
					const name = mediaAttachmentName(image.sha, image.ext);
					media.thumbnailUrl = attachmentRef(name);
					(media.refs ??= []).push({ name, sha: image.sha });
				}
			}
			const video = await this.embedVideoMedia(embed);
			if (video) (media.refs ??= []).push({ name: mediaAttachmentName(video.sha, video.ext), sha: video.sha });
			if (media.thumbnailUrl || media.refs?.length) out.set(embed.id, media);
		}
		return out;
	}

	/** Bytes da imagem do embed do Papo (`GET /embeds/{id}`), salvos no cache de mídia. */
	private async embedImageMedia(embed: PapoEmbed): Promise<{ sha: string; ext: string } | undefined> {
		if (!embed.id || embed.thumbnail?.url || embed.image?.url) return undefined;
		if (!embed.thumbnail && !embed.image) return undefined;
		try {
			const full = await this.api.getEmbed(embed.id);
			if (!full.image_data) return undefined;
			const data = Buffer.from(full.image_data, 'base64');
			if (!data.length) return undefined;
			const mime = embed.thumbnail?.mime_type ?? embed.image?.mime_type ?? 'image/webp';
			const saved = this.media.save(data, mime, `embed:${embed.id}`);
			return { sha: saved.sha256, ext: saved.ext };
		} catch (err) {
			this.log.debug({ err, embedId: embed.id }, 'imagem do embed não pôde ser re-hospedada');
			return undefined;
		}
	}

	/**
	 * Bytes do vídeo do preview: o `video.url` do embed do Papo é o arquivo direto
	 * (CDN do Twitter, offload do Instagram). Página de player (o `/embed/` do YouTube) não é
	 * arquivo e fica de fora. Não cabe no limite de upload do Discord? O preview segue só com
	 * a thumbnail — baixar um vídeo que não pode ser reenviado não serve para nada.
	 */
	private async embedVideoMedia(embed: PapoEmbed): Promise<{ sha: string; ext: string } | undefined> {
		const url = embed.video?.url;
		if (!url) return undefined;
		const mime = embed.video?.mime_type ?? mimeFromUrl(url);
		if (!PAPO_VIDEO_MIMES.includes(mime)) return undefined;
		const max = this.cfg.discord.maxFileBytes;
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (!res.ok) {
				this.log.debug({ embedId: embed.id, status: res.status }, 'vídeo do preview: origem recusou');
				return undefined;
			}
			const declared = Number(res.headers.get('content-length') ?? 0);
			if (declared > max) {
				this.log.debug({ embedId: embed.id, bytes: declared }, 'vídeo do preview excede o limite do Discord');
				return undefined;
			}
			const data = Buffer.from(await res.arrayBuffer());
			if (!data.length || data.length > max) {
				this.log.debug({ embedId: embed.id, bytes: data.length }, 'vídeo do preview excede o limite do Discord');
				return undefined;
			}
			const saved = this.media.save(data, mime, `embed-video:${embed.id}`);
			return { sha: saved.sha256, ext: saved.ext };
		} catch (err) {
			this.log.debug({ err, embedId: embed.id }, 'vídeo do preview não pôde ser baixado');
			return undefined;
		}
	}

	private async onPapoReaction(e: PapoWsReactEvent): Promise<void> {
		const map = this.store.findMapByPapo(e.message_id)[0];
		if (!map) {
			// `react_update` não traz o canal: sem mapeamento não sabemos para qual link enviar.
			this.store.deferEvent({ source: 'papo', sourceMessageId: e.message_id, kind: 'reaction', payload: e });
			this.log.debug({ messageId: e.message_id }, 'reação adiada: mensagem ainda não bridgeada');
			return;
		}
		const link = this.store.getChannelLinkById(map.link_id);
		if (!link || !link.bridge_reactions) return;
		this.enqueuePapoReaction(link, e);
		this.scheduleLink(link.id);
	}

	private async onAvatarUpdate(e: PapoWsAvatarEvent): Promise<void> {
		this.identity.invalidate(e.user_id);
	}

	/**
	 * Enfileira a reação do Papo. A conversão do emoji para o formato do Discord acontece na
	 * execução do job, quando o guild está acessível — não aqui.
	 */
	private enqueuePapoReaction(link: ChannelLink, e: PapoWsReactEvent): void {
		const key = papoReactionKey(e);
		// eco da reação que nós mesmos aplicamos no Papo: o marcador é consumido aqui, para
		// que uma reação legítima igual à nossa não fique suprimida até a janela expirar
		if (
			this.store.consumeSelfReaction({
				linkId: link.id,
				destinationMessageId: e.message_id,
				emoji: key,
				withinSeconds: SELF_REACTION_TTL_SECONDS
			})
		) {
			this.log.debug({ messageId: e.message_id }, 'eco de reação própria: não propagada');
			return;
		}

		/**
		 * O espelho do bridge pode estar na mensagem observada **dos dois lados**: uma reação
		 * nascida no Discord é espelhada na cópia do Papo, e uma nascida no Discord original
		 * também pode ter sido espelhada na mensagem do Papo que o bridge criou. O que define
		 * o desconto é o registro em `mirror_reactions` para este lado, esta mensagem e este
		 * emoji — não a direção original do `message_map`.
		 */
		const mirrored = this.store.hasMirrorReaction({
			linkId: link.id,
			side: 'papo',
			destinationMessageId: e.message_id,
			emoji: key
		});
		const count = Math.max(0, e.count - (mirrored ? 1 : 0));

		const job: ReactionJob = {
			kind: 'reaction',
			side: 'papo',
			linkId: link.id,
			sourceMessageId: e.message_id,
			targetChannelId: link.discord_channel_id,
			emojiId: e.emoji_id ?? undefined,
			unicode: e.unicode ?? undefined,
			count,
			add: count > 0
		};
		// chave sem a contagem: `1 → 0 → 1` é a mesma chave, e o estado mais recente
		// substitui o job pendente em vez de ser descartado
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'reaction',
			dedupeKey: `papo-react:${e.message_id}:${e.emoji_id ?? e.unicode}`,
			payload: { job } satisfies Envelope
		});
		this.queueFooterRefresh(link.id, 'papo', e.message_id, link.discord_channel_id);
	}

	/**
	 * Re-rendera o embed da cópia com o resumo atual de reações. As mudanças da mesma
	 * mensagem são agrupadas num único refresh, agendado depois da última mudança — não
	 * dentro de uma janela fixa em que a última alteração se perde.
	 */
	private queueFooterRefresh(
		linkId: number,
		source: 'papo' | 'discord',
		sourceMessageId: string,
		targetChannelId: string
	): void {
		const key = `${source}:${sourceMessageId}`;
		const pending = this.footerTimers.get(key);
		if (pending) clearTimeout(pending.timer);
		const args = { linkId, source, sourceMessageId, targetChannelId };
		this.footerTimers.set(key, { args, timer: setTimeout(() => this.fireFooterRefresh(key), FOOTER_DEBOUNCE_MS) });
	}

	private fireFooterRefresh(key: string): void {
		const entry = this.footerTimers.get(key);
		if (!entry) return;
		this.footerTimers.delete(key);
		const { linkId, source, sourceMessageId, targetChannelId } = entry.args;
		const job: EditJob = {
			kind: 'edit',
			side: source,
			linkId,
			sourceMessageId,
			targetChannelId,
			chunkIndex: 0,
			chunkTotal: 1,
			text: ''
		};
		this.outbox.enqueue({
			linkId,
			direction: source === 'papo' ? 'to_discord' : 'to_papo',
			kind: 'edit',
			dedupeKey: `footer:${source}:${sourceMessageId}`,
			payload: { job, footerOnly: true } satisfies Envelope
		});
		this.scheduleLink(linkId);
	}

	/** Encerramento: o que estava sendo agrupado entra na fila em vez de se perder. */
	private flushFooterTimers(): void {
		for (const key of [...this.footerTimers.keys()]) this.fireFooterRefresh(key);
	}

	private async onPapoModeration(e: PapoWsModerationEvent): Promise<void> {
		this.log.warn({ event: e }, 'moderação de attachment');
		if (e.status !== 'blocked') return;
		const maps = this.store.findMapByPapo(e.message_id);
		const link = maps[0] ? this.store.getChannelLinkById(maps[0].link_id) : undefined;
		if (!link) return;
		const job: DeleteJob = { kind: 'delete', side: 'papo', linkId: link.id, sourceMessageId: e.message_id };
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'delete',
			dedupeKey: `papo-moderation:${e.message_id}:${e.attachment_id}`,
			payload: { job } satisfies Envelope
		});
		this.scheduleLink(link.id);
	}

	private async onPapoPin(e: PapoWsPinEvent): Promise<void> {
		const map = this.store.findMapByPapo(e.message_id)[0];
		if (!map) {
			// `message_pin` também não traz o canal: adia até a mensagem ser bridgeada
			this.store.deferEvent({ source: 'papo', sourceMessageId: e.message_id, kind: 'pin', payload: e });
			this.log.debug({ messageId: e.message_id }, 'pino adiado: mensagem ainda não bridgeada');
			return;
		}
		const link = this.store.getChannelLinkById(map.link_id);
		if (!link || !link.bridge_pins) return;
		this.enqueuePapoPin(link, e);
		this.scheduleLink(link.id);
	}

	private enqueuePapoPin(link: ChannelLink, e: PapoWsPinEvent): void {
		const job: PinJob = {
			kind: 'pin',
			side: 'papo',
			linkId: link.id,
			sourceMessageId: e.message_id,
			targetChannelId: link.discord_channel_id,
			pinned: e.is_pinned
		};
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'pin',
			dedupeKey: `papo-pin:${e.message_id}`,
			payload: { job } satisfies Envelope
		});
	}

	/**
	 * Eventos que chegaram antes de a mensagem de origem estar bridgeada são enfileirados
	 * agora, na fila do link que acabou de criar o mapeamento.
	 */
	private flushDeferred(source: 'papo' | 'discord', sourceMessageId: string, linkId: number): void {
		const link = this.store.getChannelLinkById(linkId);
		if (!link) return;
		let flushed = 0;
		// apagar os eventos adiados e criar os jobs na mesma transação: se o processo cair
		// no meio, nada foi removido e os eventos voltam no próximo flush
		this.store.withTransaction(() => {
			for (const row of this.store.takeDeferredEvents(source, sourceMessageId)) {
				if (row.kind === 'embeds' && link.bridge_embeds) {
					// a revisão é o instante em que o evento chegou: um preview adiado não
					// pode vencer uma atualização mais recente que já entrou na fila
					flushed +=
						source === 'papo'
							? this.enqueuePapoEmbeds(
									link,
									this.store.findMapByPapo(sourceMessageId),
									JSON.parse(row.payload) as PapoWsEmbedsEvent,
									row.created_at
								)
							: this.enqueuePapoPreview(
									link,
									this.store.findMapByDiscord(sourceMessageId),
									sourceMessageId,
									(JSON.parse(row.payload) as DiscordPreviewDeferred).embed,
									row.created_at
								);
				} else if (source === 'papo' && row.kind === 'reaction' && link.bridge_reactions) {
					this.enqueuePapoReaction(link, JSON.parse(row.payload) as PapoWsReactEvent);
					flushed += 1;
				} else if (source === 'papo' && row.kind === 'pin' && link.bridge_pins) {
					this.enqueuePapoPin(link, JSON.parse(row.payload) as PapoWsPinEvent);
					flushed += 1;
				} else {
					this.log.debug({ kind: row.kind, sourceMessageId }, 'evento adiado descartado: desligado no link');
				}
			}
		});
		if (flushed) {
			this.log.debug({ sourceMessageId, flushed }, 'eventos adiados enfileirados');
			this.scheduleLink(linkId);
		}
	}

	// ── eventos Discord ────────────────────────────────────

	/**
	 * Thread criada no servidor. Se ela já está linkada a um canal do Papo, o bridge entra
	 * nela: sem ser membro, o Discord não entrega as mensagens e a ponte fica muda.
	 */
	async onDiscordThreadCreate(threadId: string, parentId: string, name: string): Promise<void> {
		if (this.stopping) return;
		const link = this.linkForDiscordChannel(threadId);
		if (!link) return;
		const joined = await this.discord.ensureThreadMembership(threadId);
		if (joined) this.log.info({ linkId: link.id, threadId, parentId, name }, 'thread linkada: bridge entrou na thread');
		else this.log.warn({ linkId: link.id, threadId, parentId, name }, 'thread linkada sem acesso: mensagens não chegam');
	}

	/**
	 * Thread arquivada para de receber mensagens: a cópia no Papo continua existindo, mas nada
	 * mais chega. Registrar ajuda a explicar o silêncio.
	 */
	onDiscordThreadUpdate(threadId: string, parentId: string, name: string, archived: boolean): void {
		if (!archived) return;
		const link = this.linkForDiscordChannel(threadId);
		if (!link) return;
		this.store.audit('warn', 'thread-linkada-arquivada', { linkId: link.id, threadId, parentId, name });
		this.log.warn({ linkId: link.id, threadId, name }, 'thread linkada arquivada: a ponte para de receber mensagens');
	}

	/**
	 * Mencionados entram no cache de usuários Discord antes de traduzir. Sem rótulo a menção
	 * atravessaria como snowflake (`<@206…>`), que o Papo não sabe renderizar — e o mencionado
	 * costuma não estar no cache porque nunca autorou uma mensagem ponte. O payload do Discord
	 * traz nome/avatar de cada um; o que faltar é buscado uma vez e cacheado.
	 */
	private async cacheMentionedDiscordUsers(m: DiscordMessage): Promise<void> {
		for (const user of m.mentions?.users?.values() ?? []) {
			// o payload não traz apelido de guild: não serve para estragar um cache mais rico
			if (this.store.getDiscordUser(user.id)) continue;
			this.store.upsertDiscordUser({
				id: user.id,
				username: user.username,
				display_name: user.displayName ?? user.username,
				avatar_hash: user.avatar
			});
		}
		// por cima: apelido do guild é o que quem lê o canal reconhece
		for (const member of m.mentions?.members?.values() ?? []) {
			const user = member.user;
			if (!user) continue;
			this.store.upsertDiscordUser({
				id: user.id,
				username: user.username,
				display_name: member.displayName ?? user.displayName ?? user.username,
				avatar_hash: user.avatar
			});
		}
		// menção que o payload não trouxe (mensagem parcial, conta de fora do guild). O teto
		// evita busca em massa atrás de id inventado em mensagem de spam.
		const unknown = discordUserMentionIds(m.content ?? '').filter((id) => !this.store.getDiscordUser(id));
		for (const id of unknown.slice(0, MENTION_LOOKUP_LIMIT)) {
			const username = await this.discord.username(id);
			if (username) this.store.upsertDiscordUser({ id, username, display_name: username });
		}
		if (unknown.length > MENTION_LOOKUP_LIMIT) {
			this.log.debug({ messageId: m.id, missing: unknown.length }, 'menções sem rótulo: limite de busca');
		}
	}

	/**
	 * Mensagem do Discord criada pelo bridge: pelo bot ou pelo webhook do bridge
	 * (mensagem de webhook tem author = webhook; o identificador é o webhook_id).
	 * Chamada opcional: fakes de teste sem suporte a webhook caem no check do bot.
	 */
	private async isSelfDiscordMessage(m: DiscordMessage | PartialDiscordMessage): Promise<boolean> {
		const viaBridge = await this.discord.isSelfMessage?.(m);
		return viaBridge ?? this.discord.isSelf(m.author?.id);
	}

	private discordAttachmentSignature(message: DiscordMessage | PartialDiscordMessage): string {
		return message.attachments
			.map((attachment) => [attachment.id, attachment.name ?? '', attachment.size, attachment.contentType ?? '', attachment.url].join(':'))
			.sort()
			.join('\n');
	}

	private rememberDiscordAttachmentSignature(messageId: string, signature: string): void {
		this.discordAttachmentSignatures.set(messageId, signature);
		// Bound memory use in long-running bridge processes.
		if (this.discordAttachmentSignatures.size > 5_000) {
			const oldest = this.discordAttachmentSignatures.keys().next().value;
			if (oldest) this.discordAttachmentSignatures.delete(oldest);
		}
	}

	async onDiscordMessage(m: DiscordMessage): Promise<void> {
		if (this.stopping) return;
		if (await this.isSelfDiscordMessage(m)) return; // anti-loop
		const link = this.linkForDiscordChannel(m.channelId);
		if (!link) return;
		this.rememberDiscordAttachmentSignature(m.id, this.discordAttachmentSignature(m));
		if (this.store.findMapByDiscord(m.id).length) return;

		const displayName = m.member?.displayName ?? m.author.displayName ?? m.author.username;
		this.store.upsertDiscordUser({
			id: m.author.id,
			username: m.author.username,
			display_name: displayName,
			avatar_hash: m.author.avatar
		});
		await this.cacheMentionedDiscordUsers(m);
		if (this.propagatesMentions(link) && /@/.test(m.content ?? '')) await this.ensurePapoNameIndex();

		const bridgeFiles = Boolean(link.bridge_attachments);
		const rawEmbeds = rawDiscordEmbeds(m.embeds as APIEmbed[]);
		const convertCustomEmbeds = shouldConvertCustomDiscordEmbeds(m);
		const nativePreviewUrl = link.bridge_embeds && !convertCustomEmbeds ? firstDiscordLinkUrl(rawEmbeds) : undefined;
		const injectNativePreviewUrl = Boolean(nativePreviewUrl && !hasHyperlinkInContent(m.content ?? ''));
		const gifSourceUrl = gifSourceUrlIn(m.content ?? '', rawEmbeds);
		// O crawler do backend examina content. Se o Discord trouxe somente o link-preview,
		// copie a URL da página (não a URL proxy da imagem), sem reescrevê-la.
		await this.warmPapoEmojis(m.content ?? '');
		const translated = discordToPapoContent(m.content ?? '', this.resolvers(link));
		const crawlerText = !convertCustomEmbeds && gifSourceUrl
			? withGifSourceUrl(translated, gifSourceUrl)
			: injectNativePreviewUrl
				? withContentUrl(translated, nativePreviewUrl!)
				: translated;
		// Os links do CDN do Discord continuam passando pelo pipeline de anexos existente.
		const content = bridgeFiles ? stripDiscordMediaLinks(crawlerText) : crawlerText;
		const chunks = chunkText(content, PAPO_EMBED_CHUNK_CHARS);
		const sources: SourceRef[] = bridgeFiles
			? m.attachments.map((a) => ({
					side: 'discord',
					id: a.id,
					name: a.name ?? 'arquivo',
					mime: a.contentType ?? undefined,
					sizeBytes: a.size,
					url: a.url
				}))
			: [];
		const attachmentUrls = m.attachments.map((a) => a.url);
		// só o primeiro preview compatível: o cartão da ponte já ocupa um embed, e a URL que
		// já sai como anexo não precisa de um segundo embed igual
		const preview = link.bridge_embeds && convertCustomEmbeds
			? firstDiscordPreview(rawEmbeds, attachmentUrls, { rehostDiscordMedia: bridgeFiles })
			: undefined;
		// mídia que o Discord hospeda (`cdn.discordapp.com`, `media.discordapp.net`) é volátil:
		// expira junto com a mensagem original e o hotlink é bloqueado. Ela vira anexo baixado
		// e re-enviado, nunca URL dentro de embed.
		const hosted = new Set(attachmentUrls.map(mediaKey).filter(Boolean) as string[]);
		if (bridgeFiles && link.bridge_embeds) {
			this.addDiscordMediaSources(m.id, discordHostedMedia(rawEmbeds), sources, hosted);
		}
		if (bridgeFiles) {
			// link colado no texto: quem manda `https://cdn.discordapp.com/attachments/…` quer a
			// mídia, e o backend do Papo não consegue re-servir essa URL depois
			this.addDiscordMediaSources(
				m.id,
				discordMediaLinksInContent(m.content).map((url) => ({ url, mime: mimeFromUrl(url) })),
				sources,
				hosted
			);
		}
		// GIF de preview: o Papo re-encode a imagem do embed como thumbnail estática, então
		// animação só sobrevive como arquivo da mensagem.
		const previewGif = preview && !preview.video && preview.thumbnail?.mime_type === 'image/gif' ? preview.thumbnail.url : undefined;
		if (preview && previewGif && bridgeFiles) {
			const key = mediaKey(previewGif);
			if (!key || !hosted.has(key)) {
				if (key) hosted.add(key);
				sources.push({
					side: 'discord',
					id: `${m.id}:preview`,
					name: this.previewFileName(previewGif, 'preview.gif'),
					mime: 'image/gif',
					sizeBytes: 0,
					url: previewGif
				});
			}
			preview.thumbnail = undefined;
		}
		const linkEmbeds = preview ? [preview] : [];

		if (!chunks.length && !sources.length && !linkEmbeds.length) return;
		const total = Math.max(chunks.length, 1);
		const avatarUrl = m.author.displayAvatarURL({ extension: 'png', size: 256 });

		for (let i = 0; i < total; i++) {
			// sem texto mas com anexo/embed o card já mostra a mídia: não precisa de marcador
			const fallback = sources.length || linkEmbeds.length ? '' : '[mensagem sem texto]';
			const chunkContent = chunks[i] ?? (i === 0 ? fallback : '');
			const job: ToPapoMessageJob = {
				kind: 'message',
				linkId: link.id,
				papoChannelId: link.papo_channel_id,
				discordChannelId: m.channelId,
				discordMessageId: m.id,
				chunkIndex: i,
				chunkTotal: total,
				authorName: displayName,
				// identidade do autor Discord: é ela que fixa o webhook do bridge no Papo
				authorId: m.author.id,
				authorUsername: m.author.username,
				authorAvatarHash: m.author.avatar ?? undefined,
				authorAvatarUrl: avatarUrl,
				content: chunkContent,
				contentMode: Boolean(!convertCustomEmbeds && (gifSourceUrl || (link.bridge_embeds && (hasHyperlinkInContent(m.content ?? '') || injectNativePreviewUrl)))),
				footerBase: `🕒 ${formatDate(m.createdAt.toISOString(), this.cfg.bridge.timezone)} · Discord${chunkLabel(i, total)}`,
				notes: [],
				sources: i === 0 ? sources : [],
				linkEmbeds: i === 0 ? linkEmbeds : [],
				timestamp: m.createdAt.toISOString(),
				replyRefDiscordId: i === 0 ? (m.reference?.messageId ?? undefined) : undefined
			};
			const bridgeEmbed = buildPapoBridgeEmbed({
				authorName: displayName,
				authorIconUrl: avatarUrl,
				description: '',
				footerText: job.footerBase,
				colorHex: link.color ?? '#5865F2'
			});
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_papo',
				kind: 'message',
				dedupeKey: `discord:${m.id}:to_papo:${i}`,
				payload: { job, embed: bridgeEmbed as DiscordEmbedPayload } satisfies Envelope
			});
		}
		this.scheduleLink(link.id);
	}

	async onDiscordEdit(before: DiscordMessage | PartialDiscordMessage, after: DiscordMessage | PartialDiscordMessage): Promise<void> {
		if (this.stopping) return;
		const link = this.linkForDiscordChannel(after.channelId);
		if (!link || (!link.bridge_edits && !link.bridge_embeds)) return;
		// mensagem parcial (não estava no cache): só temos id e canal, o conteúdo precisa ser buscado
		const fresh = after.partial ? await this.discord.fetchMessage(after.channelId, after.id) : (after as DiscordMessage);
		if (!fresh) {
			this.log.debug({ messageId: after.id }, 'edição do Discord sem conteúdo acessível');
			return;
		}
		if (await this.isSelfDiscordMessage(fresh)) {
			// eco: foi o próprio bridge que reescreveu o embed (resumo de reação).
			this.log.debug({ messageId: fresh.id }, 'edição de embed ponte: eco ignorado');
			return;
		}
		const previousAttachmentSignature = this.discordAttachmentSignatures.get(fresh.id) ?? this.discordAttachmentSignature(before);
		const currentAttachmentSignature = this.discordAttachmentSignature(fresh);
		this.rememberDiscordAttachmentSignature(fresh.id, currentAttachmentSignature);
		const maps = this.store.findMapByDiscord(fresh.id);
		if (!maps.length && Date.now() - fresh.createdTimestamp > EDIT_MAP_GRACE_MS) {
			// mensagem antiga que nunca foi ponte: não há destino a atualizar
			this.log.debug({ messageId: fresh.id }, 'edição sem mapeamento: mensagem não ponte');
			return;
		}
		await this.cacheMentionedDiscordUsers(fresh);
		if (this.propagatesMentions(link) && /@/.test(fresh.content ?? '')) await this.ensurePapoNameIndex();
		const previewEmbeds = rawDiscordEmbeds(fresh.embeds as APIEmbed[]);
		const convertCustomEmbeds = shouldConvertCustomDiscordEmbeds(fresh);
		const nativePreviewUrl = link.bridge_embeds && !convertCustomEmbeds ? firstDiscordLinkUrl(previewEmbeds) : undefined;
		const injectNativePreviewUrl = Boolean(nativePreviewUrl && !hasHyperlinkInContent(fresh.content ?? ''));
		const gifSourceUrl = gifSourceUrlIn(fresh.content ?? '', previewEmbeds);
		const contentMode = maps.some((map) => Boolean(map.content_mode)) || Boolean(!convertCustomEmbeds && (gifSourceUrl || (link.bridge_embeds && (hasHyperlinkInContent(fresh.content ?? '') || injectNativePreviewUrl))));
		await this.warmPapoEmojis(fresh.content ?? '');
		const translated = discordToPapoContent(fresh.content ?? '', this.resolvers(link));
		const edited = !convertCustomEmbeds && gifSourceUrl
			? withGifSourceUrl(translated, gifSourceUrl)
			: injectNativePreviewUrl
				? withContentUrl(translated, nativePreviewUrl!)
				: translated;
		const chunks = chunkText(link.bridge_attachments ? stripDiscordMediaLinks(edited) : edited, PAPO_EMBED_CHUNK_CHARS);
		// sem mapeamento a mensagem ainda está na fila de bridge: o job re-tenta até ela aparecer
		const targets = maps.length
			? maps
					.filter((m) => m.papo_message_id)
					.map((m) => ({ chunkIndex: m.chunk_index, chunkTotal: Math.max(chunks.length, m.chunk_total) }))
			: chunks.map((_, i) => ({ chunkIndex: i, chunkTotal: chunks.length }));
		const revision = fresh.editedTimestamp ? new Date(fresh.editedTimestamp).toISOString() : new Date().toISOString();
		const attachmentsChanged = Boolean(link.bridge_attachments && link.bridge_edits) &&
			previousAttachmentSignature !== currentAttachmentSignature;
		if (attachmentsChanged) {
			const sources: SourceRef[] = fresh.attachments.map((attachment) => ({
				side: 'discord',
				id: attachment.id,
				name: attachment.name ?? 'arquivo',
				mime: attachment.contentType ?? undefined,
				sizeBytes: attachment.size,
				url: attachment.url
			}));
			const hosted = new Set(fresh.attachments.map((attachment) => mediaKey(attachment.url)).filter(Boolean) as string[]);
			if (link.bridge_embeds) this.addDiscordMediaSources(fresh.id, discordHostedMedia(previewEmbeds), sources, hosted);
			this.addDiscordMediaSources(
				fresh.id,
				discordMediaLinksInContent(fresh.content ?? '').map((url) => ({ url, mime: mimeFromUrl(url) })),
				sources,
				hosted
			);
			const attachmentJob: EditJob = {
				kind: 'edit',
				side: 'discord',
				linkId: link.id,
				sourceMessageId: fresh.id,
				targetChannelId: link.papo_channel_id,
				chunkIndex: 0,
				chunkTotal: Math.max(1, chunks.length),
				text: chunks[0] ?? '',
				revision,
				contentMode,
				refreshAttachments: true,
				sources,
				replyRefDiscordId: fresh.reference?.messageId ?? undefined
			};
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_papo',
				kind: 'edit',
				dedupeKey: `discord-attachment-edit:${fresh.id}`,
				revision,
				payload: { job: attachmentJob } satisfies Envelope
			});
		}
		// o Discord anexa o preview de link depois de criar a mensagem: é por aqui que ele chega,
		// e sem isso o cartão do Papo fica só com a URL escrita
		const preview = link.bridge_embeds && convertCustomEmbeds && !contentMode
			? firstDiscordPreview(previewEmbeds, fresh.attachments.map((a) => a.url), { rehostDiscordMedia: true })
			: undefined;
		if (preview && link.bridge_attachments) {
			const attachmentKeys = new Set(fresh.attachments.map((a) => mediaKey(a.url)).filter(Boolean));
			const stripped = discordHostedMedia(previewEmbeds).filter((m) => !attachmentKeys.has(mediaKey(discordMediaSourceUrl(m)) ?? ''));
			if (stripped.length) {
				// o preview chegou tarde e o Papo não aceita anexo em edição: a mídia do CDN do
				// Discord fica fora do cartão em vez de virar um link que quebra
				this.log.debug({ messageId: fresh.id, count: stripped.length }, 'mídia do Discord fora do preview: edição não anexa');
			}
		}
		if (preview) {
			if (maps.length) this.enqueuePapoPreview(link, maps, fresh.id, preview, revision);
			else {
				// a cópia ainda está na fila de bridge: o preview espera o mapeamento em vez de
				// queimar as tentativas de um job que não tem para onde ir
				this.store.deferEvent({
					source: 'discord',
					sourceMessageId: fresh.id,
					kind: 'embeds',
					payload: { embed: preview } satisfies DiscordPreviewDeferred
				});
				this.log.debug({ messageId: fresh.id }, 'preview adiado: mensagem ainda não bridgeada');
			}
		}
		for (const target of targets) {
			// A dedicated job replaces the main copy and all attachment continuation messages.
			if (attachmentsChanged && (target.chunkIndex === 0 || target.chunkIndex >= EXTRA_CHUNK_BASE)) continue;
			if (link.bridge_edits || injectNativePreviewUrl) {
				const job: EditJob = {
					kind: 'edit',
					side: 'discord',
					linkId: link.id,
					sourceMessageId: fresh.id,
					targetChannelId: link.papo_channel_id,
					chunkIndex: target.chunkIndex,
					chunkTotal: target.chunkTotal,
					text: chunks[target.chunkIndex] ?? '',
					revision,
					contentMode: contentMode && target.chunkIndex < EXTRA_CHUNK_BASE
				};
				this.outbox.enqueue({
					linkId: link.id,
					direction: 'to_papo',
					kind: 'edit',
					dedupeKey: `discord-edit:${fresh.id}:${target.chunkIndex}`,
					revision,
					payload: { job } satisfies Envelope
				});
			}
		}
		this.scheduleLink(link.id);
	}

	/** Enfileira um embed personalizado convertido do Discord para cada cópia do Papo. */
	private enqueuePapoPreview(
		link: ChannelLink,
		maps: MessageMapRow[],
		sourceMessageId: string,
		embed: PapoEmbedInput,
		revision: string
	): number {
		let enqueued = 0;
		for (const map of maps) {
			if (!map.papo_message_id || map.direction !== 'discord_to_papo') continue;
			const job: EditJob = {
				kind: 'edit',
				side: 'discord',
				linkId: link.id,
				sourceMessageId,
				targetChannelId: link.papo_channel_id,
				chunkIndex: map.chunk_index,
				chunkTotal: map.chunk_total,
				text: '',
				revision
			};
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_papo',
				kind: 'edit',
				dedupeKey: `discord-embeds:${sourceMessageId}:${map.chunk_index}`,
				revision,
				payload: { job, embedsOnly: true, papoPreviews: [embed] } satisfies Envelope
			});
			enqueued += 1;
		}
		return enqueued;
	}

	async onDiscordDelete(m: DiscordMessage | PartialDiscordMessage): Promise<void> {
		if (this.stopping) return;
		const link = this.store.getChannelLinkByDiscord(m.channelId);
		if (!link || !link.bridge_deletes) return;
		if (!m.partial && await this.isSelfDiscordMessage(m)) {
			// eco: o bridge apagou a própria cópia (deleção nascida no Papo).
			this.log.debug({ messageId: m.id }, 'deleção de embed ponte: eco ignorado');
			return;
		}
		const maps = this.store.findMapByDiscord(m.id);
		// tombstone: reconcilia o delete com o job de criação que ainda não rodou
		this.store.tombstoneMessage('discord', m.id);
		if (!m.partial && !maps.length && Date.now() - m.createdTimestamp > EDIT_MAP_GRACE_MS) {
			// mensagem antiga que nunca foi ponte: não há destino a apagar
			this.log.debug({ messageId: m.id }, 'deleção sem mapeamento: mensagem não ponte');
			return;
		}
		this.store.markMapDeleted(undefined, m.id);
		if (!maps.length) {
			this.log.debug({ messageId: m.id }, 'delete sem mapeamento: criação da cópia suprimida');
			return;
		}
		const job: DeleteJob = { kind: 'delete', side: 'discord', linkId: link.id, sourceMessageId: m.id };
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_papo',
			kind: 'delete',
			dedupeKey: `discord-delete:${m.id}`,
			payload: { job } satisfies Envelope
		});
		this.scheduleLink(link.id);
	}

	async onDiscordReaction(
		messageId: string,
		channelId: string,
		emojiName: string,
		emojiId: string | null,
		animated = false,
		add = true,
		count = 0
	): Promise<void> {
		if (this.stopping) return;
		const link = this.store.getChannelLinkByDiscord(channelId);
		if (!link || !link.bridge_reactions) return;

		const custom = Boolean(emojiId);
		const key = mirrorEmojiKey(emojiId, emojiName);
		// a contagem observada é a desta mensagem do Discord; o espelho do bridge conta nela
		// sempre que estiver registrado aqui — não só quando o Discord é a cópia
		const mirrored = this.store.hasMirrorReaction({
			linkId: link.id,
			side: 'discord',
			destinationMessageId: messageId,
			emoji: key
		});
		const human = Math.max(0, count - (mirrored ? 1 : 0));
		// estado desejado reconciliado pela contagem absoluta, não pela ação individual:
		// uma pessoa removendo a reação não derruba o espelho enquanto outras ainda reagiram
		const present = human > 0 || (add && count === 0);

		const job: ReactionJob = {
			kind: 'reaction',
			side: 'discord',
			linkId: link.id,
			sourceMessageId: messageId,
			targetChannelId: link.papo_channel_id,
			emojiId: emojiId ?? undefined,
			emojiName: custom ? emojiName : undefined,
			animated,
			unicode: custom ? undefined : emojiName,
			count: human,
			add: present
		};
		// sem mapeamento ainda, o job re-tenta: a mensagem pode estar na fila de bridge
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_papo',
			kind: 'reaction',
			dedupeKey: `discord-react:${messageId}:${emojiName}`,
			payload: { job } satisfies Envelope
		});
		this.queueFooterRefresh(link.id, 'discord', messageId, link.papo_channel_id);
		this.scheduleLink(link.id);
	}

	onDiscordPresence(userId: string, status: string): void {
		this.store.setPresence('discord', userId, DISCORD_STATUS_TO_PAPO[status] ?? status);
	}

	// ── execução dos jobs ──────────────────────────────────

	private scheduleLink(linkId: number): void {
		if (this.stopping) return;
		if (this.running.has(linkId)) {
			// o worker encerra e re-checa a fila (ver `rerun` no finally)
			this.rerun.add(linkId);
			return;
		}
		const run = this.runLink(linkId).finally(() => {
			this.running.delete(linkId);
			// enqueue que chegou enquanto o worker era o ativo: o `claimNext` final dele
			// pode ter rodado antes do enqueue; reagenda em vez de deixar o job órfão
			if (!this.stopping && this.rerun.delete(linkId)) this.scheduleLink(linkId);
		});
		this.running.set(linkId, run);
	}

	private async runLink(linkId: number): Promise<void> {
		let sent = 0;
		for (;;) {
			// encerramento: o job em voo termina, mas nenhum outro é reivindicado
			if (this.stopping) return;
			const row = this.outbox.claimNext(linkId);
			if (!row) return;
			try {
				await this.execute(row);
				this.outbox.complete(row.id);
			} catch (err) {
				const permanent = err instanceof PermanentError || isPapoPermanent(err);
				const transient =
					!permanent &&
					(err instanceof RetryableError || isDiscordTransient(err) || (err instanceof PapoApiError && err.transient));
				this.outbox.fail(row.id, (err as Error).message ?? String(err), !transient);
				const ctx = { err, jobId: row.id, kind: row.kind, linkId, permanent };
				if (transient) this.log.warn(ctx, 'job adiado para nova tentativa');
				else this.log.error(ctx, 'job falhou');
				if (row.kind === 'reaction') this.requeueFooter(row);
				if (!transient) continue;
				await sleep(500);
			}
			sent += 1;
			if (sent % this.cfg.discord.maxMessagesPer5s === 0) await sleep(1200);
		}
	}

	/**
	 * Reação que falhou deixa o resumo do embed defasado: reagenda o refresh para depois da
	 * nova tentativa, senão o embed fica com a contagem anterior até o próximo evento.
	 */
	private requeueFooter(row: OutboxRow): void {
		let job: ReactionJob | undefined;
		try {
			const env = JSON.parse(row.payload) as Envelope;
			if (env.job.kind === 'reaction') job = env.job as ReactionJob;
		} catch {
			return;
		}
		if (!job) return;
		this.queueFooterRefresh(job.linkId, job.side, job.sourceMessageId, job.targetChannelId);
	}

	private async execute(row: OutboxRow): Promise<void> {
		const env = JSON.parse(row.payload) as Envelope;
		switch (env.job.kind) {
			case 'message': {
				const job = env.job as ToDiscordMessageJob | ToPapoMessageJob;
				// Uma tentativa remota anterior é o que distingue "saiu e o resultado é incerto"
				// de "nunca saiu". A marcação acontece imediatamente antes da chamada de envio,
				// não antes de preparar os anexos: falhar na preparação não pode empurrar a
				// próxima execução para a reconciliação atrás de uma cópia que nunca existiu.
				const uncertain = this.outbox.remoteAttempts(row.id) > 0;
				const markAttempt = (): void => this.outbox.markRemoteAttempt(row.id);
				if ('description' in job) return this.sendToDiscord(job as ToDiscordMessageJob, env.embed, uncertain, markAttempt);
				return this.sendToPapo(job as ToPapoMessageJob, env.embed, uncertain, markAttempt);
			}
			case 'edit':
				return this.applyEdit(env);
			case 'delete':
				return this.applyDelete(env.job as DeleteJob);
			case 'reaction':
				return this.applyReaction(env.job as ReactionJob);
			case 'pin':
				return this.applyPin(env.job as PinJob);
		}
	}

	private sourcesToAttachments(sources: SourceRef[]): SourceAttachment[] {
		return sources.map((s) => ({
			id: s.id,
			name: s.name,
			mime: s.mime,
			sizeBytes: s.sizeBytes,
			directUrl: s.url,
			moderationStatus: s.moderationStatus,
			download: async () => {
				if (s.side === 'papo') return this.api.downloadAttachment(s.id);
				return this.downloadDiscordFile(s);
			}
		}));
	}

	/**
	 * Baixa um arquivo do CDN do Discord. O link é assinado (`?ex=&is=&hm=`) e vence em ~24h,
	 * então 404 não quer dizer "arquivo morto": quase sempre quer dizer "link vencido". O bridge
	 * renova a assinatura e tenta de novo antes de declarar a mídia perdida. Link já vencido é
	 * renovado antes da primeira tentativa — bater no 404 certo seria só desperdiçar uma ida à rede.
	 */
	private async downloadDiscordFile(source: SourceRef): Promise<Buffer> {
		const url = source.url;
		if (!url) throw new PermanentError(`attachment ${source.id} sem URL de origem`);
		const stale = discordLinkIsStale(url);
		const tried = new Set<string>();
		for (const candidate of stale ? [await this.refreshDiscordUrl(url), url] : [url]) {
			if (!candidate || tried.has(candidate)) continue;
			tried.add(candidate);
			const data = await this.fetchDiscordFile(candidate);
			if (data) return data;
		}
		// recusado com assinatura válida: o arquivo pode estar vivo e o link, não
		if (!stale) {
			const refreshed = await this.refreshDiscordUrl(url);
			if (refreshed && !tried.has(refreshed)) {
				const data = await this.fetchDiscordFile(refreshed);
				if (data) return data;
			}
		}
		throw new SourceGoneError(`download ${url} → indisponível na origem`);
	}

	/** `undefined` = o CDN recusou o link (4xx): quem chama decide entre renovar ou desistir. */
	private async fetchDiscordFile(url: string): Promise<Buffer | undefined> {
		let res: Response;
		try {
			res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
		} catch (err) {
			// rede instável não é motivo para matar a mensagem: volta para a fila
			throw new RetryableError(`download ${url}: ${(err as Error).message}`);
		}
		if (!res.ok) {
			if (res.status === 429 || res.status >= 500) throw new RetryableError(`download ${url} → HTTP ${res.status}`);
			return undefined;
		}
		return Buffer.from(await res.arrayBuffer());
	}

	/**
	 * Assinatura renovada, indexada pelo caminho do CDN. O mesmo GIF de favorito é enviado por
	 * muita gente e o embed sempre aponta para o caminho original: sem cache cada mensagem pagaria
	 * uma chamada de refresh pelo mesmo arquivo.
	 */
	private refreshedMedia = new Map<string, { url: string; expiresAt: number }>();
	/** Renovação em andamento, para um burst do mesmo arquivo não pagar uma chamada cada. */
	private refreshing = new Map<string, Promise<string | undefined>>();

	private async refreshDiscordUrl(url: string): Promise<string | undefined> {
		const key = mediaKey(url);
		if (!key) return undefined;
		const cached = this.refreshedMedia.get(key);
		if (cached && cached.expiresAt > Date.now()) return cached.url;
		const inflight = this.refreshing.get(key);
		if (inflight) return inflight;
		const promise = this.refreshDiscordMedia(url, key);
		this.refreshing.set(key, promise);
		try {
			return await promise;
		} finally {
			this.refreshing.delete(key);
		}
	}

	private async refreshDiscordMedia(url: string, key: string): Promise<string | undefined> {
		const refreshed = await this.discord.refreshMediaUrl?.(url);
		if (!refreshed) return undefined;
		if (this.refreshedMedia.size > 500) this.refreshedMedia.clear();
		const expiry = discordSignatureExpiry(refreshed);
		// sem `ex` legível na resposta o cache vale pouco: o suficiente para não repetir a chamada
		this.refreshedMedia.set(key, { url: refreshed, expiresAt: expiry ? expiry * 1000 : Date.now() + 60_000 });
		return refreshed;
	}

	/** Nome de arquivo para mídia de preview que só existe como URL (o destino quer um nome). */
	private previewFileName(url: string, fallback: string): string {
		try {
			const parts = new URL(url).pathname.split('/').filter(Boolean);
			return sanitizeName(parts.slice(-2).join('-') || fallback);
		} catch {
			return fallback;
		}
	}

	/**
	 * Mídia hospedada pelo Discord (embed, preview ou link colado no texto) vira anexo da
	 * mensagem no Papo: o bridge baixa o arquivo e re-envia, porque a URL do CDN expira junto
	 * com a mensagem original e o hotlink é bloqueado.
	 * `seen` carrega os caminhos já cobertos por anexo do Discord — a mesma mídia servida por
	 * outro host (`media.discordapp.net` no embed) não é baixada duas vezes.
	 */
	private addDiscordMediaSources(messageId: string, media: DiscordMedia[], sources: SourceRef[], seen: Set<string>): void {
		for (const m of media) {
			const url = discordMediaSourceUrl(m);
			const key = mediaKey(url);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			sources.push({
				side: 'discord',
				id: `${messageId}:media:${sources.length}`,
				name: this.discordMediaFileName(url),
				mime: m.mime || mimeFromUrl(url) || undefined,
				sizeBytes: 0,
				url
			});
		}
	}

	/** Nome original do arquivo: no CDN do Discord o último segmento do caminho é o nome. */
	private discordMediaFileName(url: string): string {
		try {
			const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
			return sanitizeName(name) || 'midia-do-discord';
		} catch {
			return 'midia-do-discord';
		}
	}

	/**
	 * Emoji custom na forma canônica do banco (`:nome:`) → token renderizável do destino.
	 * Custom emoji só renderiza no `description` do embed: no Discord como `<:nome:id>`,
	 * no Papo como shortcode resolvido pelo renderizador do card. Footer de embed mostra
	 * o texto cru nos dois lados.
	 */
	private emojiTokenFor(dest: 'papo' | 'discord', emoji: string): string {
		if (dest === 'papo') return emoji;
		const name = /^:([A-Za-z0-9_]{1,32}):$/.exec(emoji)?.[1];
		if (!name) return emoji;
		return this.emojis.tokenForDiscord(name, this.guildEmojis, this.appEmojis);
	}

	/**
	 * Resumo de reações no dialeto de emoji do destino: `👍 3 · <:papu:123> 2`.
	 * No Discord os nomes são pré-resolvidos (guild → emoji da aplicação → criação): sem o
	 * equivalente o resumo sai com `:nome:` cru.
	 */
	private async reactionSummaryFor(
		dest: 'papo' | 'discord',
		rows: { emoji: string; count: number }[]
	): Promise<string> {
		if (dest === 'discord') await this.warmDiscordEmojis(...rows.map((r) => r.emoji));
		return reactionSummaryText(rows, 8, (emoji) => this.emojiTokenFor(dest, emoji));
	}

	/**
	 * Resumo de reações de uma mensagem já bridgeada: mescla as contagens dos dois lados do
	 * par (o eco da nossa própria reação conta 1 e nunca supera a contagem real).
	 */
	private async reactionSummaryForMap(map: MessageMapRow, dest: 'papo' | 'discord'): Promise<string> {
		const sides: ReactionDisplay[][] = [];
		if (map.papo_message_id) sides.push(this.store.listReactions(map.link_id, 'papo', map.papo_message_id));
		if (map.discord_message_id) sides.push(this.store.listReactions(map.link_id, 'discord', map.discord_message_id));
		return this.reactionSummaryFor(dest, mergeReactionCounts(sides));
	}

	/**
	 * Descrição da mensagem bridgeada: texto + linha de reações. O resumo mora no
	 * `description` porque nem o footer do Discord nem o do Papo renderizam emoji custom.
	 */
	private withReactionSummary(text: string, summary: string, max: number): string {
		if (!summary) return clampText(text, max);
		const line = `${REACTION_MARK}${summary}`;
		const room = Math.max(1, max - Array.from(line).length - 2);
		const clamped = clampText(text, room);
		return clamped ? `${clamped}\n\n${line}` : line;
	}

	/**
	 * `content` da cópia de webhook: nota de reply no topo, resumo de reações no fim. O
	 * orçamento do texto é o que sobra depois dos dois — o link que carrega a referência do
	 * reply não pode ser cortado no meio.
	 */
	private webhookCopyContent(note: string, text: string, summary: string, max: number): string {
		if (!note) return this.withReactionSummary(text, summary, max);
		const room = Math.max(1, max - Array.from(note).length - 2);
		const body = this.withReactionSummary(text, summary, room);
		return body ? `${note}\n\n${body}` : note;
	}

	/** Rodapé base, preservando o selo de edição já aplicado ao embed. */
	private footerText(map: MessageMapRow, embed: { footer?: { text?: string } }, max: number): string {
		const base = map.footer_base ?? '';
		const mark = base && embed.footer?.text?.startsWith(EDIT_MARK) ? EDIT_MARK : '';
		return clampText(`${mark}${base}`, max);
	}

	/**
	 * Avatar do autor Discord já baixado neste processo (`hash` → bytes/sha). O hash é a chave:
	 * avatar novo é baixado uma vez; falha tem janela de re-tentativa para não martelar o CDN.
	 */
	private discordAttachmentSignatures = new Map<string, string>();
	private readonly discordAvatars = new Map<
		string,
		{ hash: string; sha?: string; buffer?: Buffer; format?: string; at: number }
	>();
	private static readonly AVATAR_RETRY_MS = 10 * 60_000;

	/**
	 * Bytes do avatar do autor Discord no cache de mídia, para fixar no webhook do bridge no
	 * Papo (o webhook carrega o avatar; a mensagem não). Falha de download não derruba a
	 * mensagem: o webhook fica só com o nome.
	 */
	private async discordAvatarFor(job: ToPapoMessageJob): Promise<{ sha: string; buffer: Buffer; format: string } | undefined> {
		const userId = job.authorId;
		const url = job.authorAvatarUrl;
		const hash = job.authorAvatarHash;
		if (!userId || !url || !hash) return undefined;

		const cached = this.discordAvatars.get(userId);
		if (cached?.hash === hash) {
			if (cached.sha && cached.buffer) return { sha: cached.sha, buffer: cached.buffer, format: cached.format ?? 'PNG' };
			// falha recente: não se martela o CDN por um avatar
			if (Date.now() - cached.at < Bridge.AVATAR_RETRY_MS) return undefined;
		}
		try {
			// marca antes do download: a falha também respeita a janela
			this.discordAvatars.set(userId, { hash, at: Date.now() });
			const buffer = await this.fetchDiscordFile(url);
			const info = buffer ? this.media.sniffImage(buffer) : null;
			if (!buffer || !info) return undefined;
			const { sha256 } = this.media.save(buffer, info.mime, 'discord-avatar');
			const format = info.ext.toUpperCase();
			this.discordAvatars.set(userId, { hash, sha: sha256, buffer, format, at: Date.now() });
			return { sha: sha256, buffer, format };
		} catch (err) {
			// avatar é identidade, não conteúdo: download ou cache de mídia não derrubam a mensagem
			this.log.debug({ err, userId }, 'avatar do autor Discord indisponível');
			return undefined;
		}
	}

	/**
	 * Avatar do autor do Papo como anexo da mensagem. Sem media server público o
	 * Discord não tem URL absoluta para `author.icon_url`, e `attachment://` é a
	 * forma de entregar o avatar sem hospedar nada fora do bot (o anexo referenciado
	 * pelo embed não aparece como arquivo separado).
	 */
	private avatarAttachment(
		sha: string | undefined,
		existingIconUrl?: string
	): { name: string; buffer: Buffer } | undefined {
		if (!sha || existingIconUrl) return undefined;
		const buffer = this.media.readFor(sha);
		if (!buffer) return undefined;
		return { name: avatarAttachmentName(sha, this.media.extFor(sha)), buffer };
	}

	/**
	 * Arquivos que os embeds salvos referenciam por `attachment://`: um edit precisa reenviá-los.
	 * O nome enviado é o nome referenciado — o Discord resolve `attachment://<nome>` pelo
	 * arquivo com esse nome na mensagem, e a mídia de preview (`media-<sha>`) tem nome próprio.
	 */
	private filesForEmbedRefs(embeds: DiscordEmbedPayload[]): { name: string; buffer: Buffer }[] {
		const out: { name: string; buffer: Buffer }[] = [];
		const seen = new Set<string>();
		const push = (name: string, sha: string): void => {
			if (seen.has(sha)) return;
			const buffer = this.media.readFor(sha);
			if (!buffer) return;
			seen.add(sha);
			out.push({ name, buffer });
		};
		for (const e of embeds) {
			for (const url of [e.author?.icon_url, e.footer?.icon_url, e.thumbnail?.url, e.image?.url]) {
				const sha = shaFromAttachmentRef(url);
				if (!sha) continue;
				push(attachmentRefName(url) ?? avatarAttachmentName(sha, this.media.extFor(sha)), sha);
			}
			for (const ref of e.media_refs ?? []) push(ref.name, ref.sha);
		}
		return out;
	}

	/** Embeds prontos para a API do Discord: sem os campos que só o bridge usa. */
	private discordApiEmbeds(embeds: DiscordEmbedPayload[]): APIEmbed[] {
		return embeds.map((e) => discordApiEmbed(e) as APIEmbed);
	}

	private async sendToDiscord(
		job: ToDiscordMessageJob,
		embed?: DiscordEmbedPayload,
		uncertain = false,
		markAttempt: () => void = () => {}
	): Promise<void> {
		// a origem já foi apagada: criar a cópia agora deixaria uma mensagem órfã no Discord
		if (this.store.isTombstoned('papo', job.papoMessageId)) {
			this.log.debug({ papoMessageId: job.papoMessageId }, 'criação suprimida: mensagem de origem já excluída');
			return;
		}

		// modo webhook: cada usuário Papo tem um webhook próprio no canal, com nick +
		// avatar fixos no webhook. O Discord agrupa mensagens consecutivas por autor +
		// username — num webhook compartilhado, cópias de usuários diferentes nunca
		// agrupariam. Sem webhook (limite do canal, sem Manage Webhooks) o envio continua
		// pelo cartão do bot. Webhook não responde mensagens: a referência do reply vira
		// link no texto.
		const webhook = job.authorId
			? await this.discord.userWebhook?.(job.discordChannelId, {
					userId: job.authorId,
					displayName: job.authorName,
					username: this.store.getPapoUser(job.authorId)?.username ?? job.authorName,
					avatarSha: job.authorIconSha,
					avatarBuffer: job.authorIconSha ? this.media.readFor(job.authorIconSha) : undefined
				})
			: undefined;
		const webhookMode = Boolean(webhook);
		// Webhook não responde mensagem (limitação da API do Discord): a referência de um reply
		// chega como link no topo do `content`, com o autor da mensagem respondida. Guardar a
		// nota em `message_map.reply_note` é o que permite reescrevê-la em toda reescrita do
		// content (edição, resumo de reação).
		const replyCopy = this.replyCopy(job.replyRefPapoId);
		const replyTarget = replyCopy?.discord_message_id ?? undefined;
		const replyNote = webhookMode
			? replyNoteFor(replyTarget && this.discord.messageLink(job.discordChannelId, replyTarget), replyCopy?.author_label)
			: '';

		const avatar = webhookMode ? undefined : this.avatarAttachment(job.authorIconSha, embed?.author?.icon_url);
		// embeds **da origem Papo** (preview de link, GIF do picker): já vêm em `job.linkEmbeds`.
		// O `embed` do envelope é o cartão pré-construído no enqueue — no modo webhook o bridge
		// não gera cartão, então ele é ignorado e os únicos embeds são os previews da origem
		const previewEmbeds = webhookMode ? [...(job.linkEmbeds ?? [])] : [];
		// avatar e mídia do preview ocupam anexos da mensagem: o orçamento dos anexos da
		// origem é o que sobra
		const reservedFiles =
			(avatar ? 1 : 0) + this.filesForEmbedRefs(webhookMode ? previewEmbeds : (job.linkEmbeds ?? [])).length;
		const plan = await prepareAttachments(this.sourcesToAttachments(job.sources), {
			maxFileBytes: this.cfg.discord.maxFileBytes,
			maxFilesPerMessage: Math.max(1, DISCORD_LIMITS.attachmentsPerMessage - reservedFiles)
		});

		const notes = [...job.notes, ...plan.notes];
		const description = notes.length
			? `${job.description}${job.description ? '\n\n' : ''}${notes.map((n) => `> ${n}`).join('\n')}`.trim()
			: job.description;

		const groups = plan.groups.length ? plan.groups : [[]];
		// selo determinístico por grupo: é a assinatura que permite reconhecer a cópia já
		// criada quando o resultado de um envio anterior é incerto
		const signatures = copySignatures('papo', job.papoMessageId, job.chunkIndex, groups.length);
		const summary = await this.reactionSummaryFor('discord', this.store.listReactions(job.linkId, 'papo', job.papoMessageId));

		// modo webhook: `content` = conteúdo do Papo (nota de reply no topo, linha de reações no
		// fim), embeds = só os previews que vieram do Papo. Sem cartão, sem rodapé, sem embed de
		// continuação — a identidade e a data já são do próprio webhook/mensagem.
		const webhookContent = this.webhookCopyContent(replyNote, description, summary, DISCORD_LIMITS.contentMax);
		const webhookPreviews = webhookMode ? fitEmbedBudget(previewEmbeds, DISCORD_LIMITS.embedTotalChars) : [];

		let footerBase = '';
		let built: DiscordEmbedPayload | undefined;
		let cardEmbeds: DiscordEmbedPayload[] = [];
		let footers: string[] = [];
		if (!webhookMode) {
			const stamp = formatDate(job.timestamp, this.cfg.bridge.timezone);
			footerBase = signedFooter(
				`🕒 ${stamp} · Papo${chunkLabel(job.chunkIndex, job.chunkTotal)}`,
				signatures[0]!,
				DISCORD_LIMITS.embedFooterMax
			);
			footers = groups.map((_, g) =>
				g === 0
					? footerBase
					: signedFooter(`🕒 ${stamp} · Papo · 📎 ${g + 1}/${groups.length}`, signatures[g]!, DISCORD_LIMITS.embedFooterMax)
			);
			built =
				embed ??
				buildDiscordBridgeEmbed({
					authorName: job.authorName,
					authorIconUrl: (job.authorIconSha && this.cfg.bridge.mediaBaseUrl && this.cfg.bridge.mediaBaseUrl?.length > 0) ? this.media.urlFor(job.authorIconSha, this.cfg.bridge.mediaBaseUrl) : undefined,
					description,
					footerText: footerBase,
					colorHex: job.colorHex
				});
			built.description = this.withReactionSummary(description, summary, DISCORD_LIMITS.embedDescriptionMax);
			built.footer = { text: footerBase };
			if (avatar && !built.author?.icon_url) {
				built.author = {
					name: built.author?.name ?? job.authorName,
					...(built.author?.url ? { url: built.author.url } : {}),
					icon_url: attachmentRef(avatar.name)
				};
			}
			// o preview de link entra como embed extra, atrás do cartão
			cardEmbeds = fitEmbedBudget([built, ...(job.linkEmbeds ?? [])], DISCORD_LIMITS.embedTotalChars);
		}

		// reconhecimento da cópia no envio incerto: cartão é achado pela assinatura do rodapé;
		// cópia de webhook é achada pelo `content` (grupo 0) ou pelos nomes de anexo (grupos de
		// arquivos, que no modo webhook saem sem embed)
		const expectations = groups.map((files, g) => ({
			signature: signatures[g]!,
			...(webhookMode
				? g === 0
					? { contents: [webhookContent, clampText(description, DISCORD_LIMITS.contentMax)] }
					: { files: files.map((f) => f.name) }
				: {})
		}));
		const existing = uncertain ? await this.findDiscordCopies(job.discordChannelId, expectations, job.timestamp) : new Map<string, string>();
		if (existing.size) {
			this.log.warn(
				{ papoMessageId: job.papoMessageId, found: existing.size },
				'cópia já criada no Discord: envio não repetido'
			);
		}

		let lastDiscordId: string | undefined;

		for (let g = 0; g < groups.length; g++) {
			const extra = g > 0;
			const already = existing.get(signatures[g]!);
			if (already) {
				lastDiscordId = already;
				this.mapDiscordCopy(job, already, g, extra, description, built, footerBase, webhookMode, webhookPreviews, replyNote);
				continue;
			}
			const files = groups[g]!.map((f) => ({ name: f.name, buffer: f.data }));
			let embeds: APIEmbed[] = [];
			if (webhookMode) {
				if (g === 0) {
					// a mídia que os previews referenciam por `attachment://` precisa ir junto
					files.unshift(...this.filesForEmbedRefs(webhookPreviews));
					embeds = this.discordApiEmbeds(webhookPreviews);
				}
				if (!extra && !webhookContent && !embeds.length && !files.length) {
					this.log.debug({ papoMessageId: job.papoMessageId }, 'mensagem sem conteúdo, embed ou anexo: nada a enviar');
					continue;
				}
			} else {
				// avatar e mídia do preview vão na mensagem do cartão, cada um uma única vez: o
				// Discord mostra no corpo todo arquivo que nenhum embed consumiu, então reenviar o
				// avatar que o cartão já referencia por `attachment://` faz dele uma foto grande
				if (g === 0) {
					const refs = this.filesForEmbedRefs(cardEmbeds);
					if (avatar && !refs.some((f) => f.name === avatar.name) && built?.author?.icon_url === attachmentRef(avatar.name))
						refs.unshift(avatar);
					files.unshift(...refs);
				}
				embeds = extra
					? [
							buildDiscordBridgeEmbed({
								authorName: job.authorName,
								description: `📎 continuação de anexos (${g + 1}/${groups.length})`,
								footerText: footers[g]!,
								colorHex: job.colorHex
							}) as APIEmbed
						]
					: this.discordApiEmbeds(cardEmbeds);
			}
			markAttempt();
			const viaWebhook =
				webhook && job.authorId
					? await this.discord.sendAsWebhook?.(job.discordChannelId, job.authorId, {
							...(g === 0 ? { content: webhookContent } : {}),
							embeds,
							files
						})
					: undefined;
			if (viaWebhook === null)
				// webhook morto no envio (apagado por fora, sem permissão): nada foi entregue.
				// O job re-tenta; a resolução recria o webhook ou cai para o cartão do bot.
				throw new RetryableError('webhook do usuário indisponível no envio');
			const sent =
				viaWebhook ??
				(await this.discord.send(job.discordChannelId, {
					embeds,
					files,
					replyTo: extra ? lastDiscordId : replyTarget
				}));
			lastDiscordId = sent.id;
			this.mapDiscordCopy(job, sent.id, g, extra, description, built, footerBase, webhookMode, webhookPreviews, replyNote);
		}
		this.flushDeferred('papo', job.papoMessageId, job.linkId);
		// o delete chegou enquanto o envio estava em voo: a cópia recém-criada não sobrevive
		if (this.store.isTombstoned('papo', job.papoMessageId)) {
			await this.applyDelete({ kind: 'delete', side: 'papo', linkId: job.linkId, sourceMessageId: job.papoMessageId });
		}
	}

	private mapDiscordCopy(
		job: ToDiscordMessageJob,
		discordMessageId: string,
		group: number,
		extra: boolean,
		description: string,
		built: DiscordEmbedPayload | undefined,
		footerBase: string,
		webhookCopy = false,
		webhookPreviews: DiscordEmbedPayload[] = [],
		replyNote = ''
	): void {
		this.store.mapMessage({
			link_id: job.linkId,
			direction: 'papo_to_discord',
			papo_message_id: job.papoMessageId,
			discord_message_id: discordMessageId,
			// grupos extras de arquivos recebem índice fora do intervalo dos chunks de texto
			chunk_index: extra ? EXTRA_CHUNK_BASE + group : job.chunkIndex,
			chunk_total: job.chunkTotal,
			rendered: extra ? null : description,
			// cópia de webhook não tem cartão: NULL de verdade, para o refresh de rodapé não
			// tomar a linha como cartão
			bridge_embed: extra || built === undefined ? undefined : built,
			footer_base: extra || webhookCopy ? null : footerBase,
			// no modo webhook o snapshot dos embeds da cópia são os previews da origem
			link_embeds: extra ? null : webhookCopy ? webhookPreviews : (job.linkEmbeds ?? []),
			// só o grupo 0 tem `content`: os grupos de arquivo não repetem a nota
			reply_note: extra ? null : replyNote || null,
			// autor da origem: rótulo do "de @autor" da nota, e o que identifica a cópia numa
			// reconciliação manual
			author_label: job.authorName || null,
			webhook_copy: webhookCopy
		});
	}

	/**
	 * Reconcilia um envio de resultado incerto: procura no destino a cópia que o bridge já
	 * criou, reconhecida pela **assinatura** do rodapé (cartão), pelo `content` exato (cópia
	 * de webhook) ou pelos nomes de anexo (grupos de arquivos sem embed), e por ser posterior
	 * à mensagem de origem. O rodapé com data ao minuto não bastava: duas mensagens do mesmo
	 * minuto têm o mesmo rodapé, e a cópia antiga seria tomada pela nova.
	 */
	private async findDiscordCopies(
		channelId: string,
		expectations: { signature: string; contents?: string[]; files?: string[] }[],
		sourceTimestamp: string
	): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const selfId = this.discord.selfId;
		if (!selfId || !expectations.length) return out;
		const recent = await this.discord.recentByAuthor(channelId, selfId, 50).catch(() => undefined);
		if (!recent) return out;
		const after = Date.parse(sourceTimestamp) || 0;
		for (const exp of expectations) {
			const wanted = exp.files && exp.files.length ? [...exp.files].sort().join('\n') : undefined;
			const hit = recent.find(
				(m) =>
					m.createdAt >= after &&
					(m.footers.some((f) => f.includes(exp.signature)) ||
						(exp.contents?.some((c) => c !== '' && m.content === c) ?? false) ||
						(wanted !== undefined && Array.from(m.files ?? []).sort().join('\n') === wanted))
			);
			if (hit) out.set(exp.signature, hit.id);
		}
		return out;
	}

	private async sendToPapo(
		job: ToPapoMessageJob,
		embed?: DiscordEmbedPayload,
		uncertain = false,
		markAttempt: () => void = () => {}
	): Promise<void> {
		// a origem já foi apagada: criar a cópia agora deixaria uma mensagem órfã no Papo
		if (this.store.isTombstoned('discord', job.discordMessageId)) {
			this.log.debug({ discordMessageId: job.discordMessageId }, 'criação suprimida: mensagem de origem já excluída');
			return;
		}

		// modo webhook (espelho do modo webhook do Discord): cada usuário Discord tem um webhook
		// próprio no canal Papo, com nick + avatar fixos no webhook. `content` = texto do Discord;
		// links ficam para o crawler nativo e embeds personalizados de bots/webhooks são enviados
		// explicitamente. Sem pool de webhooks (bot sem `manage_webhooks`) o envio continua pelo
		// cartão do bot — e o avatar nem chega a ser baixado.
		const avatar = this.papoWebhooks && job.authorId ? await this.discordAvatarFor(job) : undefined;
		const webhook =
			this.papoWebhooks && job.authorId
				? await this.papoWebhooks.userWebhook(job.papoChannelId, {
						userId: job.authorId,
						displayName: job.authorName,
						username: job.authorUsername ?? job.authorName,
						avatarSha: avatar?.sha,
						avatarBuffer: avatar?.buffer,
						avatarFormat: avatar?.format
					})
				: undefined;
		const webhookMode = Boolean(webhook);

		const plan = await prepareAttachments(this.sourcesToAttachments(job.sources), {
			maxFileBytes: PAPO_LIMITS.attachmentMaxBytes,
			maxFilesPerMessage: PAPO_LIMITS.attachmentsPerMessage
		});

		// modo webhook: o texto vai no `content` da mensagem (o teto é o da mensagem). Sem
		// webhook o texto vai no `description` do embed, que é o card da mensagem.
		const notes = [...job.notes, ...plan.notes];
		const text = clampText(
			notes.length
				? `${job.content}${job.content ? '\n\n' : ''}${notes.map((n) => `> ${n}`).join('\n')}`.trim()
				: job.content,
			webhookMode || job.contentMode ? PAPO_LIMITS.contentMax : PAPO_LIMITS.embedDescriptionMax
		);

		const groups = plan.groups.length ? plan.groups : [[]];
		const signatures = copySignatures('discord', job.discordMessageId, job.chunkIndex, groups.length);
		const summary = await this.reactionSummaryFor('papo', this.store.listReactions(job.linkId, 'discord', job.discordMessageId));

		// modo webhook: `content` = texto do Discord com a linha de reações no fim. Diferente do
		// Discord, o webhook do Papo responde mensagem: a referência do reply é nativa e não
		// precisa virar nota no texto. Sem cartão, sem rodapé, sem embed de continuação.
		//
		// O preview de link é nativo: o `content` carrega a URL e o backend faz o crawl em
		// background. `job.linkEmbeds` só contém embeds personalizados convertidos; converter
		// também o preview de hyperlink duplicaria o mesmo link, pois o crawler não deduplica embeds.
		const webhookContent = this.webhookCopyContent('', text, summary, PAPO_LIMITS.contentMax);

		const signedBase = signedFooter(job.footerBase, signatures[0]!, PAPO_LIMITS.embedFooterMax);
		const footers = groups.map((_, g) =>
			g === 0
				? signedBase
				: signedFooter(`${job.footerBase} · 📎 ${g + 1}/${groups.length}`, signatures[g]!, PAPO_LIMITS.embedFooterMax)
		);
		// cópia de webhook não tem rodapé assinado para reconhecer: a reconciliação de um envio
		// incerto é a chave de idempotência do envio (`external_message_id`)
		const existing =
			uncertain && !webhookMode
				? await this.findPapoCopies(job.papoChannelId, signatures, job.timestamp)
				: new Map<string, string>();
		if (existing.size) {
			this.log.warn({ discordMessageId: job.discordMessageId, found: existing.size }, 'cópia já criada no Papo: envio não repetido');
		}
		let lastPapoId: string | undefined;

		for (let g = 0; g < groups.length; g++) {
			const attachments = groups[g]!.map((f) => ({ name: f.name, data: f.data, mime: f.mime }));
			const extra = g > 0;

			if (webhook && webhookMode) {
				if (!extra && !webhookContent && !attachments.length && !job.linkEmbeds?.length) {
					this.log.debug({ discordMessageId: job.discordMessageId }, 'mensagem sem conteúdo ou anexo: nada a enviar');
					continue;
				}
				markAttempt();
				const created = await this.sendWebhookSafe(webhook, job, g, extra, lastPapoId, {
					...(extra ? {} : { content: webhookContent }),
					...(extra ? {} : { embeds: job.linkEmbeds ?? [] }),
					attachments
				});
				if (!created)
					// webhook morto no envio (revogado, apagado por fora): nada foi entregue. O job
					// re-tenta; a resolução recria o webhook ou cai para o cartão do bot.
					throw new RetryableError('webhook do autor indisponível no Papo');
				lastPapoId = created.id;
				this.mapPapoCopy(job, created.id, g, extra, text, undefined, '', {
					webhookCopy: true,
					webhookId: webhook.webhookId
				});
				continue;
			}

			const embeds = extra
				? [
						buildPapoBridgeEmbed({
							authorName: job.authorName,
							description: `📎 continuação de anexos (${g + 1}/${groups.length})`,
							footerText: footers[g]!,
							colorHex: '#5865F2'
						})
					]
				: [embed, ...(job.linkEmbeds ?? [])].filter(Boolean);

			const mainEmbed = extra ? undefined : embeds[0];
			if (mainEmbed) {
				mainEmbed.description = this.withReactionSummary(job.contentMode ? '' : text, summary, PAPO_LIMITS.embedDescriptionMax);
				mainEmbed.footer = { text: footers[g]! };
			}
			if (!text && !attachments.length && !embeds.length) return;

			const already = existing.get(signatures[g]!);
			if (already) {
				lastPapoId = already;
				this.mapPapoCopy(job, already, g, extra, text, mainEmbed, signedBase);
				continue;
			}

			markAttempt();
			const created = await this.sendToPapoSafe({
				channelId: job.papoChannelId,
				content: job.contentMode && g === 0 ? text : undefined,
				replyTo: extra ? lastPapoId : this.copyForDiscordMessage(job.replyRefDiscordId),
				attachments,
				embeds: embeds.length ? (embeds as ToPapoMessageJob['linkEmbeds']) : undefined
			});
			lastPapoId = created.id;
			this.mapPapoCopy(job, created.id, g, extra, text, mainEmbed, signedBase);
		}
		this.flushDeferred('discord', job.discordMessageId, job.linkId);
		// o delete chegou enquanto o envio estava em voo: a cópia recém-criada não sobrevive
		if (this.store.isTombstoned('discord', job.discordMessageId)) {
			await this.applyDelete({ kind: 'delete', side: 'discord', linkId: job.linkId, sourceMessageId: job.discordMessageId });
		}
	}

	/**
	 * Envio pelo webhook do autor, com a mesma tolerância de `sendToPapoSafe`: `reply_to` de
	 * mensagem já apagada dá 404 e a mensagem não pode se perder por causa da referência.
	 * A chave de idempotência é determinística — re-tentar o mesmo job não duplica a cópia.
	 */
	private async sendWebhookSafe(
		webhook: PapoWebhookRef,
		job: ToPapoMessageJob,
		group: number,
		extra: boolean,
		lastPapoId: string | undefined,
		options: { content?: string; embeds?: PapoEmbedInput[]; attachments: { name: string; data: Buffer; mime?: string }[] }
	): Promise<PapoMessage | null> {
		const replyTo = extra ? lastPapoId : this.copyForDiscordMessage(job.replyRefDiscordId);
		const externalMessageId = `discord:${job.discordMessageId}:${job.chunkIndex}:${group}`;
		const send = (reference?: string) =>
			this.papoWebhooks!.send(webhook, job.papoChannelId, {
				...options,
				...(reference ? { replyTo: reference } : {}),
				externalMessageId
			});
		try {
			return await send(replyTo);
		} catch (err) {
			if (err instanceof PapoApiError && err.status === 404 && replyTo) {
				this.log.warn({ replyTo }, 'reply_to aponta para mensagem apagada; enviando sem referência');
				return send(undefined);
			}
			throw err;
		}
	}

	private mapPapoCopy(
		job: ToPapoMessageJob,
		papoMessageId: string,
		group: number,
		extra: boolean,
		text: string,
		mainEmbed: unknown,
		footerBase: string,
		opts: { webhookCopy?: boolean; webhookId?: string } = {}
	): void {
		const webhookCopy = Boolean(opts.webhookCopy);
		this.store.mapMessage({
			link_id: job.linkId,
			direction: 'discord_to_papo',
			papo_message_id: papoMessageId,
			discord_message_id: job.discordMessageId,
			chunk_index: extra ? EXTRA_CHUNK_BASE + group : job.chunkIndex,
			chunk_total: job.chunkTotal,
			rendered: extra ? null : text,
			content_mode: Boolean(!extra && job.contentMode && !webhookCopy),
			// cópia de webhook não tem cartão: `undefined` é o NULL de verdade (o JSON "null"
			// seria lido como cartão pelo refresh de rodapé)
			bridge_embed: extra || webhookCopy || mainEmbed == null ? undefined : mainEmbed,
			footer_base: extra || webhookCopy ? null : footerBase,
			// Cópias de webhook não têm cartão do bridge, mas guardam embeds personalizados
			// convertidos para que atualizações posteriores também sejam espelhadas.
			link_embeds: extra ? null : (job.linkEmbeds ?? []),
			// autor Discord de origem: é ele que a nota de reply de uma cópia aponta
			author_label: job.authorName || null,
			webhook_copy: webhookCopy,
			// credencial que precisa ser usada para editar/apagar esta cópia
			webhook_id: webhookCopy ? opts.webhookId ?? null : null
		});
	}

	/**
	 * Reconcilia envio incerto no Papo: a cópia é reconhecida pela assinatura do rodapé e por
	 * ser posterior à mensagem de origem. Sem a assinatura, qualquer mensagem antiga do bot
	 * com o mesmo rodapé do minuto servia — e o job se ligava à cópia errada.
	 */
	private async findPapoCopies(
		channelId: string,
		signatures: string[],
		sourceTimestamp: string
	): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		if (!this.papoUserId || !signatures.length) return out;
		const since = new Date(Date.now() - 3600_000).toISOString();
		const list = await this.api.listMessages(channelId, { since, order: 'desc' }).catch(() => undefined);
		const mine = (list?.messages ?? []).filter((m) => m.author_id === this.papoUserId);
		const after = Date.parse(sourceTimestamp) || 0;
		for (const signature of signatures) {
			const hit = mine.find(
				(m) =>
					(m.created_at ? (Date.parse(m.created_at) || 0) >= after : true) &&
					(m.embeds ?? []).some((e) => e.footer?.text?.includes(signature))
			);
			if (hit) out.set(signature, hit.id);
		}
		return out;
	}

	/**
	 * `reply_to` de mensagem já apagada dá 404 no Papo ("reply_to referencia uma
	 * mensagem inexistente"). A mensagem não pode se perder por causa da referência:
	 * reenvia sem `reply_to`.
	 */
	private async sendToPapoSafe(input: SendMessageInput): Promise<PapoMessage> {
		try {
			return await this.api.sendMessage(input);
		} catch (err) {
			if (err instanceof PapoApiError && err.status === 404 && input.replyTo) {
				this.log.warn({ replyTo: input.replyTo }, 'reply_to aponta para mensagem apagada; enviando sem referência');
				return this.api.sendMessage({ ...input, replyTo: undefined });
			}
			throw err;
		}
	}

	private async applyEdit(env: Envelope): Promise<void> {
		const job = env.job as EditJob;
		if (env.footerOnly) return this.refreshFooter(job);
		const maps =
			job.side === 'papo' ? this.store.findMapByPapo(job.sourceMessageId) : this.store.findMapByDiscord(job.sourceMessageId);
		const map = maps.find((m) => m.chunk_index === job.chunkIndex) ?? maps[0];
		if (!map) throw new RetryableError('mensagem de destino ainda não mapeada');
		// preview e texto são estados separados da mesma cópia: cada um tem sua revisão
		if (env.embedsOnly) return this.applyPreviewEdit(env, job, map);
		// a fila serializa a execução, não a cronologia da origem: uma edição mais antiga,
		// enfileirada depois, não pode sobrescrever o estado mais recente já aplicado
		if (job.revision && map.edit_revision && job.revision <= map.edit_revision) {
			this.log.debug(
				{ sourceMessageId: job.sourceMessageId, revision: job.revision },
				'edição obsoleta ignorada: estado mais recente já aplicado'
			);
			return;
		}

		if (job.refreshAttachments) {
			if (job.side !== 'discord') return;
			const sourceMaps = this.store.findMapByDiscord(job.sourceMessageId);
			const primary = sourceMaps.find((entry) => entry.chunk_index === 0) ?? map;
			return this.replaceDiscordCopyAttachments(job, sourceMaps, primary);
		}

		if (job.side === 'papo') {
			// direction discord_to_papo: a mensagem do Papo é cópia nossa e a do Discord é de
			// outro autor — o Discord recusa a edição (50005).
			if (map.direction !== 'papo_to_discord') {
				this.log.debug({ papoMessageId: job.sourceMessageId }, 'edição ignorada: cópia do bot no Papo');
				return;
			}
			if (!map.discord_message_id) throw new RetryableError('sem mensagem do Discord mapeada');
			if (map.webhook_copy) {
				// cópia de webhook: o texto mora no `content`; o edit reescreve o content e o
				// Discord já marca a mensagem como editada. Previews, anexos e a nota de reply
				// ficam intactos.
				const content = this.webhookCopyContent(
					map.reply_note ?? '',
					job.text,
					await this.reactionSummaryForMap(map, 'discord'),
					DISCORD_LIMITS.contentMax
				);
				await this.discord.edit(job.targetChannelId, map.discord_message_id, { content });
				this.store.updateMapSnapshot(map.id, { rendered: job.text, edit_revision: job.revision ?? null });
				return;
			}
			const embed = await this.discordCopyEmbed(map, job);
			const embeds = fitEmbedBudget([embed, ...this.mapPreviews<DiscordEmbedPayload>(map)], DISCORD_LIMITS.embedTotalChars);
			await this.discord.edit(job.targetChannelId, map.discord_message_id, {
				embeds: this.discordApiEmbeds(embeds),
				files: this.filesForEmbedRefs(embeds)
			});
			this.store.updateMapSnapshot(map.id, { rendered: job.text, bridge_embed: embed, edit_revision: job.revision ?? null });
			return;
		}

		if (!map.papo_message_id) throw new RetryableError('sem mensagem do Papo mapeada');
		// bridge papo→discord: a mensagem do Papo é a original, de outro autor. O
		// backend recusa edição de terceiros (403), e o lado Papo já é a fonte.
		if (map.direction !== 'discord_to_papo') {
			this.log.debug({ papoMessageId: map.papo_message_id }, 'edição ignorada: mensagem do Papo não é do bot');
			return;
		}
		if (map.webhook_copy) {
			// cópia de webhook: o texto mora no `content`, e só a credencial do webhook alcança
			// a mensagem. Previews e anexos ficam intactos — o edit manda só o texto novo.
			const content = this.webhookCopyContent(
				'',
				job.text,
				await this.reactionSummaryForMap(map, 'papo'),
				PAPO_LIMITS.contentMax
			);
			if (await this.editPapoWebhookCopy(map, content))
				this.store.updateMapSnapshot(map.id, { rendered: job.text, edit_revision: job.revision ?? null });
			return;
		}
		if (map.content_mode || job.contentMode) {
			const embed = await this.papoCopyEmbed(map, '');
			const content = clampText(job.text, PAPO_LIMITS.contentMax);
			await this.api.editMessage(map.papo_message_id, content, [embed, ...this.mapPreviews<PapoEmbedInput>(map)]);
			this.store.updateMapSnapshot(map.id, {
				rendered: content,
				bridge_embed: embed,
				content_mode: true,
				edit_revision: job.revision ?? null
			});
			return;
		}
		const embed = await this.papoCopyEmbed(map, job.text);
		await this.api.editMessage(map.papo_message_id, '', [embed, ...this.mapPreviews<PapoEmbedInput>(map)]);
		this.store.updateMapSnapshot(map.id, { rendered: job.text, bridge_embed: embed, edit_revision: job.revision ?? null });
	}


	/**
	 * O endpoint de edição do Papo aceita texto/embeds, mas não substitui anexos.
	 * Quando a origem Discord troca os arquivos, recria a cópia com os anexos atuais,
	 * reaponta os mapas e remove as mensagens anteriores/continuações que sobraram.
	 */
	private async replaceDiscordCopyAttachments(job: EditJob, maps: MessageMapRow[], mainMap: MessageMapRow): Promise<void> {
		if (!mainMap.papo_message_id || mainMap.chunk_index !== 0) throw new RetryableError('cópia principal do Papo ainda não mapeada');
		if (mainMap.direction !== 'discord_to_papo') return;

		const webhookMode = Boolean(mainMap.webhook_copy);
		const webhook = webhookMode ? this.papoWebhooks?.refFor(mainMap.webhook_id) : null;
		if (webhookMode && !webhook) {
			this.log.warn({ sourceMessageId: job.sourceMessageId, webhookId: mainMap.webhook_id }, 'anexos da cópia não atualizados: credencial do webhook indisponível');
			return;
		}

		const plan = await prepareAttachments(this.sourcesToAttachments(job.sources ?? []), {
			maxFileBytes: PAPO_LIMITS.attachmentMaxBytes,
			maxFilesPerMessage: PAPO_LIMITS.attachmentsPerMessage
		});
		const groups = plan.groups.length ? plan.groups : [[]];
		const refreshedText = plan.notes.length
			? `${job.text}${job.text ? '\n\n' : ''}${plan.notes.map((note) => `> ${note}`).join('\n')}`.trim()
			: job.text;
		const previousIds = new Map(maps.filter((entry) => entry.papo_message_id).map((entry) => [entry.id, entry.papo_message_id!]));
		const created: { group: number; messageId: string; embed?: PapoEmbedInput }[] = [];
		let mainEmbed: PapoEmbedInput | undefined;
		let previousId: string | undefined;
		const summary = await this.reactionSummaryForMap(mainMap, 'papo');
		const content = this.webhookCopyContent(
			mainMap.reply_note ?? '',
			refreshedText,
			summary,
			PAPO_LIMITS.contentMax
		);

		try {
			for (let group = 0; group < groups.length; group++) {
				const attachments = groups[group]!.map((file) => ({ name: file.name, data: file.data, mime: file.mime }));
				let message: PapoMessage;
				let embed: PapoEmbedInput | undefined;
				if (group === 0 && !webhookMode) {
					embed = await this.papoCopyEmbed(mainMap, mainMap.content_mode || job.contentMode ? '' : refreshedText);
					mainEmbed = embed;
					const embeds = [embed, ...this.mapPreviews<PapoEmbedInput>(mainMap)];
					message = await this.sendToPapoSafe({
						channelId: job.targetChannelId,
						content: mainMap.content_mode || job.contentMode ? clampText(refreshedText, PAPO_LIMITS.contentMax) : undefined,
						replyTo: this.copyForDiscordMessage(job.replyRefDiscordId),
						attachments,
						embeds
					});
				} else if (group === 0) {
					const sent = await this.papoWebhooks!.send(webhook!, job.targetChannelId, {
						content,
						...(job.replyRefDiscordId ? { replyTo: this.copyForDiscordMessage(job.replyRefDiscordId) } : {}),
						attachments,
						externalMessageId: `discord:${job.sourceMessageId}:attachment-refresh:${job.revision ?? Date.now()}:${group}`
					});
					if (!sent) throw new RetryableError('webhook do Papo não aceitou a substituição dos anexos');
					message = sent;
				} else if (webhookMode) {
					const sent = await this.papoWebhooks!.send(webhook!, job.targetChannelId, {
						...(previousId ? { replyTo: previousId } : {}),
						attachments,
						externalMessageId: `discord:${job.sourceMessageId}:attachment-refresh:${job.revision ?? Date.now()}:${group}`
					});
					if (!sent) throw new RetryableError('webhook do Papo não aceitou a continuação dos anexos');
					message = sent;
				} else {
					embed = buildPapoBridgeEmbed({
						authorName: mainMap.author_label || 'Discord',
						description: `📎 continuação de anexos (${group + 1}/${groups.length})`,
						footerText: clampText(`${mainMap.footer_base ?? 'Discord'} · 📎 ${group + 1}/${groups.length}`, PAPO_LIMITS.embedFooterMax),
						colorHex: '#5865F2'
					});
					message = await this.sendToPapoSafe({
						channelId: job.targetChannelId,
						replyTo: previousId,
						attachments,
						embeds: [embed]
					});
				}
				previousId = message.id;
				created.push({ group, messageId: message.id, ...(embed ? { embed } : {}) });
			}
		} catch (err) {
			await Promise.allSettled(created.map(async (item) => {
				if (webhookMode && webhook) await this.papoWebhooks!.delete(webhook, item.messageId);
				else await this.api.deleteMessage(item.messageId);
			}));
			throw err;
		}

		const mappedIds = new Set<number>();
		const newIdByMapId = new Map<number, string>();
		for (const item of created) {
			const chunkIndex = item.group === 0 ? 0 : EXTRA_CHUNK_BASE + item.group;
			let row = maps.find((entry) => entry.chunk_index === chunkIndex);
			if (row) {
				mappedIds.add(row.id);
				newIdByMapId.set(row.id, item.messageId);
				this.store.updateMapDestination(row.id, 'papo', item.messageId);
				this.store.updateMapSnapshot(row.id, {
					rendered: item.group === 0 ? refreshedText : null,
					bridge_embed: webhookMode ? null : (item.group === 0 ? mainEmbed ?? null : item.embed ?? null),
					footer_base: item.group === 0 ? mainMap.footer_base : null,
					...(item.group === 0 ? {} : { link_embeds: null }),
					edit_revision: job.revision ?? null,
					content_mode: item.group === 0 && !webhookMode ? Boolean(mainMap.content_mode || job.contentMode) : false
				});
			} else {
				this.store.mapMessage({
					link_id: mainMap.link_id,
					direction: 'discord_to_papo',
					papo_message_id: item.messageId,
					discord_message_id: mainMap.discord_message_id,
					chunk_index: chunkIndex,
					chunk_total: mainMap.chunk_total,
					rendered: null,
					bridge_embed: webhookMode ? undefined : item.embed,
					footer_base: null,
					link_embeds: null,
					author_label: mainMap.author_label,
					webhook_copy: webhookMode,
					webhook_id: webhookMode ? mainMap.webhook_id : null
				});
				const inserted = this.store.findMapByPapo(item.messageId)[0];
				if (inserted) mappedIds.add(inserted.id);
			}
		}

		const obsolete = maps.filter((entry) => entry.id !== mainMap.id && entry.chunk_index >= EXTRA_CHUNK_BASE && !mappedIds.has(entry.id));
		for (const entry of obsolete) {
			if (entry.papo_message_id) {
				try {
					if (webhookMode && webhook) await this.papoWebhooks!.delete(webhook, entry.papo_message_id);
					else await this.api.deleteMessage(entry.papo_message_id);
				} catch (err) {
					this.log.debug({ err, papoMessageId: entry.papo_message_id }, 'continuação antiga não pôde ser removida');
				}
			}
			this.store.deleteMap(entry.id);
		}

		for (const [id, oldMessageId] of previousIds) {
			const row = maps.find((entry) => entry.id === id);
			const newMessageId = newIdByMapId.get(id);
			if (!row || !newMessageId || oldMessageId === newMessageId) continue;
			try {
				if (webhookMode && webhook) await this.papoWebhooks!.delete(webhook, oldMessageId);
				else await this.api.deleteMessage(oldMessageId);
			} catch (err) {
				this.log.debug({ err, papoMessageId: oldMessageId }, 'mensagem substituída não pôde ser removida');
			}
		}
		this.log.debug({ sourceMessageId: job.sourceMessageId, attachments: job.sources?.length ?? 0 }, 'anexos editados sincronizados com o Papo');
	}

	/**
	 * Aplica o preview de link à cópia: o cartão da ponte (autor, avatar, texto) continua
	 * primeiro e o preview entra como embed extra atrás dele. Remover o preview reescreve a
	 * cópia só com o cartão — o cartão e o resumo de reações nunca são tocados pelo preview.
	 *
	 * A cópia editável é sempre a que o bot criou: preview nascido no Papo vai para o Discord;
	 * preview nascido no Discord — o link-preview que chega atrasado por `MESSAGE_UPDATE` — vai
	 * para o Papo.
	 */
	private async applyPreviewEdit(env: Envelope, job: EditJob, map: MessageMapRow): Promise<void> {
		if (job.side === 'discord') return this.applyPapoPreviewEdit(env, job, map);
		if (map.direction !== 'papo_to_discord') {
			this.log.debug({ sourceMessageId: job.sourceMessageId }, 'preview ignorado: a cópia editável não está no Discord');
			return;
		}
		if (!map.discord_message_id) throw new RetryableError('sem mensagem do Discord mapeada');
		// só uma revisão **anterior** é descartada. Duas atualizações do mesmo milissegundo têm
		// a mesma revisão; a ordem da fila (chegada) é o que as distingue, e a última chegada é
		// a mais recente — descartar por igualdade perderia o preview novo.
		if (job.revision && map.embed_revision && job.revision < map.embed_revision) {
			this.log.debug(
				{ sourceMessageId: job.sourceMessageId, revision: job.revision },
				'preview obsoleto ignorado: estado mais recente já aplicado'
			);
			return;
		}
		const previews = await this.previewFromEnvelope(env);
		const card = map.bridge_embed ? (JSON.parse(map.bridge_embed) as DiscordEmbedPayload) : undefined;
		if (card) {
			card.description = this.withReactionSummary(
				map.rendered ?? '',
				await this.reactionSummaryForMap(map, 'discord'),
				DISCORD_LIMITS.embedDescriptionMax
			);
		}
		const embeds = fitEmbedBudget([...(card ? [card] : []), ...previews], DISCORD_LIMITS.embedTotalChars);
		// cópia de webhook não tem cartão: sem previews o edit vazio é o que os remove
		if (!embeds.length && !map.webhook_copy) return;
		await this.discord.edit(job.targetChannelId, map.discord_message_id, {
			embeds: this.discordApiEmbeds(embeds),
			files: this.filesForEmbedRefs(embeds)
		});
		this.store.updateMapSnapshot(map.id, { link_embeds: previews, embed_revision: job.revision ?? null });
	}

	/** Aplica um embed personalizado convertido do Discord à cópia do Papo. */
	private async applyPapoPreviewEdit(env: Envelope, job: EditJob, map: MessageMapRow): Promise<void> {
		if (map.direction !== 'discord_to_papo') {
			this.log.debug({ sourceMessageId: job.sourceMessageId }, 'preview ignorado: a cópia editável não está no Papo');
			return;
		}
		if (!map.papo_message_id) throw new RetryableError('sem mensagem do Papo mapeada');
		if (job.revision && map.embed_revision && job.revision < map.embed_revision) {
			this.log.debug(
				{ sourceMessageId: job.sourceMessageId, revision: job.revision },
				'preview obsoleto ignorado: estado mais recente já aplicado'
			);
			return;
		}
		const previews = env.papoPreviews ?? [];
		if (map.webhook_copy) {
			// Previews nativos não chegam aqui; quando chega um embed personalizado convertido,
			// atualize-o com o token do webhook sem tocar no conteúdo nem no resumo de reações.
			const content = this.webhookCopyContent(
				'',
				map.rendered ?? '',
				await this.reactionSummaryForMap(map, 'papo'),
				PAPO_LIMITS.contentMax
			);
			if (await this.editPapoWebhookCopy(map, content, previews)) {
				this.store.updateMapSnapshot(map.id, { link_embeds: previews, embed_revision: job.revision ?? null });
			}
			return;
		}
		const card = map.bridge_embed ? (JSON.parse(map.bridge_embed) as PapoEmbedInput) : undefined;
		if (card) {
			card.description = this.withReactionSummary(
				map.rendered ?? '',
				await this.reactionSummaryForMap(map, 'papo'),
				PAPO_LIMITS.embedDescriptionMax
			);
		}
		const embeds = fitEmbedBudget([...(card ? [card] : []), ...previews], PAPO_LIMITS.embedTotalChars);
		if (!embeds.length) return;
		await this.api.editMessage(map.papo_message_id, '', embeds);
		this.store.updateMapSnapshot(map.id, { link_embeds: previews, embed_revision: job.revision ?? null });
	}

	/** Preview pronto para aplicar: já convertido, ou convertido agora a partir da origem. */
	private async previewFromEnvelope(env: Envelope): Promise<DiscordEmbedPayload[]> {
		if (env.embeds?.length) return env.embeds.slice(0, 1);
		if (env.papoEmbeds !== undefined) {
			const preview = await this.papoPreviewEmbed(env.papoEmbeds);
			return preview ? [preview] : [];
		}
		return [];
	}

	/** Embeds extra guardados no mapa: o preview que acompanha o cartão daquela cópia. */
	private mapPreviews<T>(map: MessageMapRow): T[] {
		if (!map.link_embeds) return [];
		try {
			const parsed = JSON.parse(map.link_embeds) as T[];
			return Array.isArray(parsed) ? parsed.slice(0, 1) : [];
		} catch {
			return [];
		}
	}

	/**
	 * Embed da cópia Discord: snapshot salvo em `message_map` com o texto novo no
	 * `description`. Reconstruir o embed do zero perdia o autor/avatar do card e deixava o
	 * anexo de avatar solto na mensagem — o Discord desenha como imagem quem nenhum embed
	 * referencia, e o card virava só o avatar do autor.
	 */
	private async discordCopyEmbed(map: MessageMapRow, job: EditJob): Promise<DiscordEmbedPayload> {
		const embed: DiscordEmbedPayload = map.bridge_embed
			? (JSON.parse(map.bridge_embed) as DiscordEmbedPayload)
			: { author: { name: 'Papo' } };
		embed.description = this.withReactionSummary(
			job.text,
			await this.reactionSummaryForMap(map, 'discord'),
			DISCORD_LIMITS.embedDescriptionMax
		);
		const base = map.footer_base ?? `Papo${chunkLabel(job.chunkIndex, job.chunkTotal)}`;
		embed.footer = { ...embed.footer, text: clampText(`${EDIT_MARK}${base}`, DISCORD_LIMITS.embedFooterMax) };
		return embed;
	}

	/**
	 * Embed da cópia Papo: snapshot salvo em `message_map` com o texto novo no
	 * `description` (a mensagem bridgeada não usa `content` no Papo).
	 */
	private async papoCopyEmbed(map: MessageMapRow, text: string): Promise<PapoEmbedInput> {
		const embed: PapoEmbedInput = map.bridge_embed
			? (JSON.parse(map.bridge_embed) as PapoEmbedInput)
			: { author: { name: 'Discord' } };
		embed.description = this.withReactionSummary(
			text,
			await this.reactionSummaryForMap(map, 'papo'),
			PAPO_LIMITS.embedDescriptionMax
		);
		const base = map.footer_base ?? 'Discord';
		embed.footer = { ...embed.footer, text: clampText(`${EDIT_MARK}${base}`, PAPO_LIMITS.embedFooterMax) };
		if (!embed.site_name) embed.site_name = 'Discord';
		return embed;
	}

	/**
	 * Edita uma cópia do Papo criada por webhook. A posse é do webhook: o backend recusa que
	 * o JWT do bot — mesmo ele tendo criado o webhook — mexa em mensagem de webhook, então
	 * a edição sai pela credencial salva em `papo_webhooks`.
	 *
	 * `embeds` ausente preserva os embeds da mensagem (edição só de texto); enviar `[]`
	 * substitui os customizados por nada. `content` nunca é omitido: sem ele o backend limpa
	 * o texto, e no modo webhook o texto é a mensagem.
	 *
	 * `false` quando a credencial se perdeu (webhook revogado, linha apagada): a cópia existe,
	 * mas não há como o bridge mexer nela — registrar e seguir, não queimar as tentativas do job.
	 */
	private async editPapoWebhookCopy(map: MessageMapRow, content: string, embeds?: PapoEmbedInput[]): Promise<boolean> {
		if (!map.papo_message_id) return false;
		const ref = this.papoWebhooks?.refFor(map.webhook_id);
		if (!ref) {
			this.log.warn(
				{ papoMessageId: map.papo_message_id, webhookId: map.webhook_id },
				'cópia de webhook sem credencial: edição impossível no Papo'
			);
			return false;
		}
		return this.papoWebhooks!.edit(ref, map.papo_message_id, content, embeds);
	}

	/**
	 * Re-rendera o embed salvo em `message_map` com o resumo atual de reações (linha no
	 * `description`: footer não renderiza emoji custom em nenhum dos lados).
	 * O destino é a cópia que o bot criou (definida por `map.direction`): a mensagem original
	 * do outro lado é de outro autor — Discord recusa edição (50005) e o backend do Papo também
	 * (403), além de já mostrar as próprias reações.
	 */
	private async refreshFooter(job: EditJob): Promise<void> {
		const maps =
			job.side === 'papo' ? this.store.findMapByPapo(job.sourceMessageId) : this.store.findMapByDiscord(job.sourceMessageId);
		const targets = maps.filter((m) => (m.bridge_embed || m.webhook_copy) && !m.deleted);
		if (!targets.length) {
			// mensagem ponte antiga (sem snapshot) ou sem embed: nada a atualizar
			this.log.debug({ sourceMessageId: job.sourceMessageId }, 'embed sem snapshot: resumo de reações ignorado');
			return;
		}
		const link = this.store.getChannelLinkById(job.linkId);
		if (!link) throw new PermanentError('link removido');

		for (const map of targets) {
			if (map.direction === 'papo_to_discord') {
				if (!map.discord_message_id) continue;
				if (map.webhook_copy) {
					// cópia de webhook: o resumo de reações é anexado ao `content` (não há
					// cartão), e a nota de reply continua no topo — a re-escrita substitui o
					// content inteiro
					const content = this.webhookCopyContent(
						map.reply_note ?? '',
						map.rendered ?? '',
						await this.reactionSummaryForMap(map, 'discord'),
						DISCORD_LIMITS.contentMax
					);
					await this.discord.edit(link.discord_channel_id, map.discord_message_id, { content });
					continue;
				}
				const embed = JSON.parse(map.bridge_embed!) as DiscordEmbedPayload;
				embed.description = this.withReactionSummary(
					map.rendered ?? '',
					await this.reactionSummaryForMap(map, 'discord'),
					DISCORD_LIMITS.embedDescriptionMax
				);
				embed.footer = { text: this.footerText(map, embed, DISCORD_LIMITS.embedFooterMax) };
				// o preview é parte do estado da cópia: reescrever o cartão por causa de uma
				// reação não pode apagá-lo
				const embeds = fitEmbedBudget([embed, ...this.mapPreviews<DiscordEmbedPayload>(map)], DISCORD_LIMITS.embedTotalChars);
				await this.discord.edit(link.discord_channel_id, map.discord_message_id, {
					embeds: this.discordApiEmbeds(embeds),
					files: this.filesForEmbedRefs(embeds)
				});
				continue;
			}
			// a cópia editável está no Papo: sem webhook o texto mora no embed, `content` fica limpo
			if (!map.papo_message_id) continue;
			if (map.webhook_copy) {
				// cópia de webhook: o resumo de reações é anexado ao `content` (não há cartão)
				const content = this.webhookCopyContent(
					'',
					map.rendered ?? '',
					await this.reactionSummaryForMap(map, 'papo'),
					PAPO_LIMITS.contentMax
				);
				await this.editPapoWebhookCopy(map, content);
				continue;
			}
			const embed = JSON.parse(map.bridge_embed!) as PapoEmbedInput;
			embed.description = this.withReactionSummary(
				map.content_mode ? '' : (map.rendered ?? ''),
				await this.reactionSummaryForMap(map, 'papo'),
				PAPO_LIMITS.embedDescriptionMax
			);
			embed.footer = { text: this.footerText(map, embed, PAPO_LIMITS.embedFooterMax) };
			await this.api.editMessage(map.papo_message_id, map.content_mode ? (map.rendered ?? '') : '', [embed, ...this.mapPreviews<PapoEmbedInput>(map)]);
		}
	}

	private async applyDelete(job: DeleteJob): Promise<void> {
		const maps =
			job.side === 'papo' ? this.store.findMapByPapo(job.sourceMessageId) : this.store.findMapByDiscord(job.sourceMessageId);
		if (!maps.length) {
			// o delete chegou antes do mapeamento: o tombstone já suprimiu a criação, então
			// não há cópia a apagar — isto não é uma falha permanente do job
			if (this.store.isTombstoned(job.side, job.sourceMessageId)) {
				this.log.debug({ sourceMessageId: job.sourceMessageId }, 'delete sem cópia: origem já excluída');
				return;
			}
			throw new PermanentError('sem mapeamento para deleção');
		}
		const link = this.store.getChannelLinkById(job.linkId);
		if (!link) throw new PermanentError('link removido');

		for (const map of maps) {
			try {
				if (job.side === 'papo' && map.discord_message_id) {
					// bridge discord→papo: a mensagem do Discord é a original, de outro autor.
					if (map.direction !== 'papo_to_discord') continue;
					await this.discord.delete(link.discord_channel_id, map.discord_message_id);
				} else if (job.side === 'discord' && map.papo_message_id) {
					// bridge papo→discord: a mensagem do Papo é a original, de outro autor
					// (o backend recusa: 403). A cópia do Discord já sumiu por si só.
					if (map.direction !== 'discord_to_papo') continue;
					if (map.webhook_copy) {
						// cópia de webhook: só a credencial do webhook apaga a mensagem. Sem ela a
						// cópia fica órfã no Papo — não há como recuperá-la, então o map é encerrado
						// mesmo assim (re-tentar não muda nada).
						const ref = this.papoWebhooks?.refFor(map.webhook_id);
						if (!ref) {
							this.log.warn(
								{ papoMessageId: map.papo_message_id, webhookId: map.webhook_id },
								'cópia de webhook sem credencial: exclusão impossível no Papo'
							);
							continue;
						}
						await this.papoWebhooks!.delete(ref, map.papo_message_id);
						continue;
					}
					await this.api.deleteMessage(map.papo_message_id);
				}
			} catch (err) {
				const status = (err as { status?: number }).status;
				if (status === 404) continue; // já removida
				throw err;
			}
		}
		this.store.markMapDeleted(
			job.side === 'papo' ? job.sourceMessageId : undefined,
			job.side === 'discord' ? job.sourceMessageId : undefined
		);
	}

	private async applyReaction(job: ReactionJob): Promise<void> {
		const maps =
			job.side === 'papo' ? this.store.findMapByPapo(job.sourceMessageId) : this.store.findMapByDiscord(job.sourceMessageId);
		const map = maps[0];
		if (!map) throw new RetryableError('mensagem de destino ainda não mapeada');
		const link = this.store.getChannelLinkById(job.linkId);
		if (!link) throw new PermanentError('link removido');

		if (job.side === 'papo') return this.applyPapoReaction(job, map, link);
		return this.applyDiscordReaction(job, map, link);
	}

	/** Reação nascida no Papo: registra a contagem e reflete no Discord quando o emoji existe lá. */
	private async applyPapoReaction(job: ReactionJob, map: MessageMapRow, link: ChannelLink): Promise<void> {
		const name = job.emojiName ?? (job.emojiId ? (await this.emojis.papoById(job.emojiId))?.name : undefined);
		// forma canônica no banco: unicode literal, ou `:nome:` (o dialeto do destino é
		// aplicado na hora de renderizar o resumo)
		const display = job.unicode ?? (name ? `:${name}:` : undefined);
		if (!display) return;
		this.store.setReaction({
			linkId: link.id,
			source: 'papo',
			sourceMessageId: job.sourceMessageId,
			emoji: display,
			count: job.count
		});

		if (!map.discord_message_id) throw new RetryableError('sem mensagem do Discord mapeada');

		let native = job.unicode;
		if (!native) {
			if (!name) return;
			// guild → emoji da aplicação (existente ou criado): o Discord aceita reação do app
			// com um emoji que o próprio app criou
			const token = await this.emojis.ensureDiscordToken(name, this.guildEmojis, this.appEmojis);
			if (token.startsWith('<')) native = token;
			else if (!this.discord.guildsCached()) throw new RetryableError('guilds ainda sem emojis no cache');
			else {
				this.log.debug({ emoji: display, messageId: job.sourceMessageId }, 'reação sem equivalente no Discord: só o resumo de reações');
				return;
			}
		}

		// estado já sincronizado: repetir a chamada é redundante. No Discord é só um pedido a
		// mais; no Papo é o que deixa um marcador de eco pendente, pronto para consumir a
		// próxima reação legítima igual à nossa.
		const mirror = {
			linkId: link.id,
			side: 'discord' as const,
			destinationMessageId: map.discord_message_id,
			emoji: discordMirrorKey(native)
		};
		if (this.store.hasMirrorReaction(mirror) === job.add) {
			this.log.debug({ messageId: job.sourceMessageId, emoji: display }, 'espelho do Discord já sincronizado: chamada evitada');
			return;
		}
		// Marca ANTES de aplicar: um evento humano do Discord que chegue enquanto a chamada
		// está em voo já desconta o espelho na contagem observada. Marcando só depois, a
		// reação do bot era contada como humana e disparava um espelho redundante no Papo.
		this.trackMirrorReaction({ ...mirror, present: job.add });
		try {
			await this.reactOnDiscord(job, link.discord_channel_id, map.discord_message_id, native);
		} catch (err) {
			if (!isUnknownEmoji(err)) {
				this.trackMirrorReaction({ ...mirror, present: !job.add });
				throw err;
			}
			// o cache do gateway ainda traz o emoji, mas o Discord o recusa (apagado ou
			// `available: false`): re-carrega a lista de indisponíveis e tenta o equivalente.
			this.trackMirrorReaction({ ...mirror, present: false });
			await this.discord.loadUnavailableEmojis();
			const retry = name ? this.emojis.tokenForDiscord(name, this.guildEmojis, this.appEmojis) : undefined;
			if (!retry?.startsWith('<') || retry === native) {
				this.log.warn(
					{ emoji: display, messageId: job.sourceMessageId },
					'reação com emoji indisponível no guild: só o resumo de reações'
				);
				return;
			}
			native = retry;
			const retryMirror = { ...mirror, emoji: discordMirrorKey(native) };
			this.trackMirrorReaction({ ...retryMirror, present: job.add });
			try {
				await this.reactOnDiscord(job, link.discord_channel_id, map.discord_message_id, native);
			} catch (err2) {
				this.trackMirrorReaction({ ...retryMirror, present: !job.add });
				throw err2;
			}
			return;
		}
		// o espelho vive no Discord: registrar é o que permite descontar a reação do bot
		// quando uma contagem observada naquela mensagem a incluir. A chave é o emoji
		// realmente aplicado (o retry pode ter trocado de token).
		this.trackMirrorReaction({
			linkId: link.id,
			side: 'discord',
			destinationMessageId: map.discord_message_id,
			emoji: discordMirrorKey(native),
			present: job.add
		});
	}

	private async reactOnDiscord(job: ReactionJob, channelId: string, messageId: string, emoji: string): Promise<void> {
		if (job.add) await this.discord.react(channelId, messageId, emoji);
		else await this.discord.unreact(channelId, messageId, emoji);
	}

	/** Reação nascida no Discord: registra a contagem e reflete no Papo (importando o emoji se preciso). */
	private async applyDiscordReaction(job: ReactionJob, map: MessageMapRow, link: ChannelLink): Promise<void> {
		const custom = Boolean(job.emojiId);
		const shortcode = custom
			? await this.emojis.shortcodeForPapo(job.emojiName ?? '', job.emojiId!, Boolean(job.animated))
			: undefined;
		const display = custom ? shortcode ?? `:${(job.emojiName ?? '').slice(0, PAPO_LIMITS.emojiNameMax)}:` : job.unicode;
		if (!display) return;
		this.store.setReaction({
			linkId: link.id,
			source: 'discord',
			sourceMessageId: job.sourceMessageId,
			emoji: display,
			count: job.count
		});

		if (!map.papo_message_id) throw new RetryableError('sem mensagem do Papo mapeada');
		const papoEmoji = custom ? await this.emojis.papoByName(display.replace(/:/g, '')) : undefined;
		const args = papoEmoji ? { emojiId: papoEmoji.id } : { unicode: display };
		const selfKey = papoEmoji ? `e:${papoEmoji.id}` : `u:${display}`;
		// Estado já sincronizado: um add/remove redundante pode não gerar `react_update` no
		// Papo, e o marcador de eco ficaria pendente — a próxima reação legítima igual à
		// nossa seria consumida como eco. Não chamar quando não há nada a mudar.
		const mirror = {
			linkId: link.id,
			side: 'papo' as const,
			destinationMessageId: map.papo_message_id,
			emoji: selfKey
		};
		if (this.store.hasMirrorReaction(mirror) === job.add) {
			this.log.debug({ messageId: job.sourceMessageId, emoji: display }, 'espelho do Papo já sincronizado: chamada evitada');
			return;
		}
		// Marca ANTES de aplicar: o Papo transmite o `react_update` antes de devolver o
		// HTTP, então o eco chega enquanto a chamada ainda está em voo. Marcando depois,
		// o eco não era reconhecido e a reação voltava ao Discord como duplicada. O
		// espelho entra junto pelo mesmo motivo: a contagem observada que chegar nesse
		// intervalo já desconta a reação do bot.
		this.store.markSelfReaction(mirror);
		this.trackMirrorReaction({ ...mirror, present: job.add });
		try {
			if (job.add) await this.api.addReaction(link.papo_channel_id, map.papo_message_id, args);
			else await this.api.removeReaction(link.papo_channel_id, map.papo_message_id, args);
		} catch (err) {
			this.store.clearSelfReaction(mirror);
			this.trackMirrorReaction({ ...mirror, present: !job.add });
			throw err;
		}
	}

	/**
	 * Registra (ou desregistra) o espelho que o bridge mantém no destino. É a contagem do
	 * próprio bot: descontá-la é o que impede uma reação do bridge de parecer humana.
	 */
	private trackMirrorReaction(r: {
		linkId: number;
		side: 'papo' | 'discord';
		destinationMessageId: string;
		emoji: string;
		present: boolean;
	}): void {
		const args = { linkId: r.linkId, side: r.side, destinationMessageId: r.destinationMessageId, emoji: r.emoji };
		if (r.present) this.store.markMirrorReaction(args);
		else this.store.clearMirrorReaction(args);
	}

	private async applyPin(job: PinJob): Promise<void> {
		const link = this.store.getChannelLinkById(job.linkId);
		if (!link) throw new PermanentError('link removido');

		if (job.side === 'papo') {
			// o pino nasceu no Papo: reflete no Discord
			const map = this.store.findMapByPapo(job.sourceMessageId)[0];
			if (!map?.discord_message_id) throw new PermanentError('mensagem de destino não mapeada');
			await this.discord.setPin(link.discord_channel_id, map.discord_message_id, job.pinned);
			return;
		}

		// o pino nasceu no Discord: reflete no Papo
		const map = this.store.findMapByDiscord(job.sourceMessageId)[0];
		if (!map?.papo_message_id) throw new PermanentError('mensagem de destino não mapeada');
		await this.api.setPin(link.papo_channel_id, map.papo_message_id, job.pinned);
	}

	// ── presença (comando /online) ─────────────────────────

	papoOnline(): { id: string; name: string; status: string }[] {
		return this.store.listPresence('papo').map((r) => {
			const u = this.store.getPapoUser(r.user_id);
			return { id: r.user_id, name: u ? authorLabel(u.nickname, u.username) : r.user_id, status: r.status };
		});
	}

	discordOnline(): { id: string; name: string; status: string }[] {
		return this.store.listPresence('discord').map((r) => {
			const u = this.store.getDiscordUser(r.user_id);
			return { id: r.user_id, name: u?.display_name ?? u?.username ?? r.user_id, status: r.status };
		});
	}

	get selfPapoUserId(): string | undefined {
		return this.papoUserId;
	}
}
