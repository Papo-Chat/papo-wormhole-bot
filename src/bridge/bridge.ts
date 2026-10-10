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
import type {
	PapoEmbed,
	PapoEmbedInput,
	PapoMessage,
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
	papoMentionIds,
	papoToDiscordContent,
	type TranslateResolvers
} from './translator.js';
import {
	attachmentRef,
	avatarAttachmentName,
	buildDiscordBridgeEmbed,
	buildPapoBridgeEmbed,
	discordEmbedsToPapo,
	fitEmbedBudget,
	papoEmbedsToDiscord,
	shaFromAttachmentRef,
	type DiscordEmbedPayload
} from './embeds.js';
import { prepareAttachments, type SourceAttachment } from './attachments.js';
import { mergeReactionCounts, reactionSummaryText, type ReactionDisplay } from './reactions.js';
import { EMBED_CHUNK_CHARS, PAPO_LIMITS, PAPO_EMBED_CHUNK_CHARS, DISCORD_LIMITS, clampText } from './limits.js';
import { EmojiBridge } from './emoji.js';
import type { MediaStore } from './media.js';
import { PapoIdentity } from './identity.js';
import { EXTRA_CHUNK_BASE, type BridgeJob, type DeleteJob, type EditJob, type PinJob, type ReactionJob, type SourceRef, type ToDiscordMessageJob, type ToPapoMessageJob } from './jobs.js';

/** Erro permanente: retry não resolve (payload inválido, permissão, recurso sumido). */
class PermanentError extends Error {}

/** Erro transitório explícito: o job volta para a fila com backoff. */
class RetryableError extends Error {}

/** Janela em que uma reação vista no Papo é tratada como eco da nossa própria aplicação. */
const SELF_REACTION_TTL_SECONDS = 120;

/** Janela em que uma edição do Discord ainda pode estar esperando o mapeamento da ponte. */
const EDIT_MAP_GRACE_MS = 5 * 60_000;

/** Selo de edição no rodapé do embed re-renderido (o texto novo vai no `description`). */
const EDIT_MARK = '✏️ editado · ';

/** Selo da linha de reações no `description` (footer de embed não renderiza emoji custom). */
const REACTION_MARK = '↳ ';

/** Buscas no Discord por menção que o payload não trouxe, por mensagem. */
const MENTION_LOOKUP_LIMIT = 10;

/** Identidade de uma reação do Papo, estável entre o evento WS e a execução do job. */
const papoReactionKey = (e: { emoji_id: string | null; unicode: string | null }): string =>
	e.emoji_id ? `e:${e.emoji_id}` : `u:${e.unicode ?? ''}`;

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
	/** Re-rendera o embed da cópia com o resumo atual de reações (nome persistido no outbox). */
	footerOnly?: boolean;
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

export class Bridge {
	private readonly log: Logger;
	private papoUserId?: string;
	private readonly identity: PapoIdentity;
	private readonly emojis: EmojiBridge;
	/** Um worker serializado por canal-link (preserva a ordem da conversa). */
	private readonly running = new Map<number, Promise<void>>();

	constructor(
		private cfg: Config,
		private store: Store,
		private outbox: Outbox,
		private api: PapoApi,
		private ws: PapoWs,
		private discord: DiscordBridge,
		private media: MediaStore
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

		if (this.cfg.papo.backfillOnStart) await this.backfill();
		await this.drain();
	}

	stop(): Promise<void> {
		this.ws.close();
		return this.discord.destroy();
	}

	/** Retoma jobs deixados em `in_flight` por um crash. */
	async drain(): Promise<void> {
		const requeued = this.outbox.requeueStale(30_000);
		if (requeued) this.log.warn({ requeued }, 'jobs em in_flight devolvidos à fila');
		const pruned = this.store.pruneSelfReactions(SELF_REACTION_TTL_SECONDS * 10);
		if (pruned) this.log.debug({ pruned }, 'registro de reações próprias expirado');
		const stale = this.store.pruneDeferredEvents(6 * 3600);
		if (stale) this.log.warn({ stale }, 'eventos adiados sem bridge descartados');
		for (const link of this.store.listChannelLinks()) this.scheduleLink(link.id);
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

	private resolvers(link?: ChannelLink): TranslateResolvers {
		return {
			// O env é o interruptor global; o flag do link liga a propagação naquele canal.
			propagateMentions: this.cfg.bridge.propagateMentions || (link?.propagate_mentions ?? 0) === 1,
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
			discordChannelLabel: (id) => this.discord.channelName(id),
			discordRoleLabel: (id) => this.discord.roleName(id),
			discordEmoji: (name) => ({
				token: this.emojis.tokenForDiscord(name, { findByName: (n) => this.discord.findGuildEmoji(n) })
			})
		};
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
	 */
	private copyForPapoMessage(papoMessageId?: string | null): string | undefined {
		if (!papoMessageId) return undefined;
		return this.store.findMapByPapo(papoMessageId).find((r) => !r.deleted && r.discord_message_id)?.discord_message_id ?? undefined;
	}

	private copyForDiscordMessage(discordMessageId?: string | null): string | undefined {
		if (!discordMessageId) return undefined;
		return this.store.findMapByDiscord(discordMessageId).find((r) => !r.deleted && r.papo_message_id)?.papo_message_id ?? undefined;
	}

	private async onPapoMessage(msg: PapoWsMessageEvent | PapoMessage): Promise<void> {
		const link = this.linkForPapoChannel(msg.channel_id);
		if (!link) return;
		if (msg.author_id === this.papoUserId) return; // anti-loop
		if (this.store.findMapByPapo(msg.id).length) return; // idempotência

		const author = await this.identity.author(msg.author_id);
		await this.warmPapoMentions(msg.content ?? '');
		const translated = papoToDiscordContent(msg.content ?? '', this.resolvers(link));
		const chunks = chunkText(translated, EMBED_CHUNK_CHARS);
		const sources = link.bridge_attachments ? this.sourceRefs(msg) : [];
		if (!chunks.length && !sources.length) return;

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
				authorName: author.name,
				authorIconSha: author.avatarSha,
				colorHex: link.color ?? undefined,
				timestamp: msg.created_at,
				notes: [],
				sources: i === 0 ? sources : [],
				replyRefPapoId: i === 0 ? (msg.reply_to ?? undefined) : undefined
			};
			const embed = buildDiscordBridgeEmbed({
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
	 * Rótulos das menções do Papo: batch de perfil (`POST /users/user_summary_batch`) antes de
	 * traduzir. Busca que falha não derruba a ponte de texto — o tradutor cai em `@usuário`.
	 */
	private async warmPapoMentions(content: string): Promise<void> {
		const ids = papoMentionIds(content);
		if (!ids.length) return;
		await this.identity.warm(ids).catch((err) => this.log.debug({ err }, 'perfil de mencionado não resolvido'));
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
		const chunks = chunkText(papoToDiscordContent(e.content ?? '', this.resolvers(link)), EMBED_CHUNK_CHARS);
		// sem mapeamento a mensagem ainda está na fila de bridge: o job re-tenta até ela aparecer
		const targets = maps.length
			? maps
					.filter((m) => m.discord_message_id && m.direction === 'papo_to_discord')
					.map((m) => ({ chunkIndex: m.chunk_index, chunkTotal: Math.max(chunks.length, m.chunk_total) }))
			: chunks.map((_, i) => ({ chunkIndex: i, chunkTotal: chunks.length }));
		for (const target of targets) {
			const job: EditJob = {
				kind: 'edit',
				side: 'papo',
				linkId: link.id,
				sourceMessageId: e.id,
				targetChannelId: link.discord_channel_id,
				chunkIndex: target.chunkIndex,
				chunkTotal: target.chunkTotal,
				text: chunks[target.chunkIndex] ?? ''
			};
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_discord',
				kind: 'edit',
				dedupeKey: `papo-edit:${e.id}:${target.chunkIndex}:${e.edited_at}`,
				payload: { job } satisfies Envelope
			});
		}
		this.scheduleLink(link.id);
	}

	private async onPapoDelete(e: PapoWsDeleteEvent): Promise<void> {
		const link = this.store.getChannelLinkByPapo(e.channel_id);
		if (!link || !link.bridge_deletes) return;
		const maps = this.store.findMapByPapo(e.id);
		if (this.allCopiesHere(maps, 'papo')) {
			// A cópia do bot no Papo sumiu (eco de deleção nascida no Discord, ou moderação):
			// o mapa não vale mais, mas a mensagem original do Discord é de outro autor e
			// não pode ser apagada por reflexo.
			this.store.markMapDeleted(e.id);
			this.log.debug({ messageId: e.id }, 'deleção de cópia do bot no Papo: original do Discord preservado');
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
		this.store.markMapDeleted(e.id);
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

	private async onPapoEmbeds(e: PapoWsEmbedsEvent): Promise<void> {
		const link = this.linkForPapoChannel(e.channel_id);
		if (!link || !link.bridge_embeds) return;
		const maps = this.store.findMapByPapo(e.message_id);
		if (!maps.length) return;
		const mediaUrls = await this.embedMediaUrls(e.embeds ?? []);
		const embeds = papoEmbedsToDiscord(e.embeds ?? [], {
			thumbnailUrlFor: (embed) => (embed.id ? mediaUrls.get(embed.id) : undefined)
		});
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
				text: ''
			};
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_discord',
				kind: 'edit',
				dedupeKey: `papo-embeds:${e.message_id}:${map.chunk_index}:${embeds.length}`,
				payload: { job, embedsOnly: true, embeds } satisfies Envelope
			});
		}
		this.scheduleLink(link.id);
	}

	/**
	 * O payload do Papo não traz URL para a imagem do embed — só mime/medidas.
	 * Os bytes vêm de `GET /embeds/{id}` (`image_data`, base64): re-hospedamos no
	 * media server para o Discord poder exibir a thumbnail do preview.
	 */
	private async embedMediaUrls(embeds: PapoEmbed[]): Promise<Map<string, string>> {
		const out = new Map<string, string>();
		const base = this.cfg.bridge.mediaBaseUrl;
		if (!base) return out;
		for (const embed of embeds) {
			if (!embed.id || embed.thumbnail?.url || embed.image?.url) continue;
			if (!embed.thumbnail && !embed.image) continue;
			try {
				const full = await this.api.getEmbed(embed.id);
				if (!full.image_data) continue;
				const data = Buffer.from(full.image_data, 'base64');
				if (!data.length) continue;
				const mime = embed.thumbnail?.mime_type ?? embed.image?.mime_type ?? 'image/webp';
				const { sha256 } = this.media.save(data, mime, `embed:${embed.id}`);
				const url = this.media.urlFor(sha256, base);
				if (url) out.set(embed.id, url);
			} catch (err) {
				this.log.debug({ err, embedId: embed.id }, 'imagem do embed não pôde ser re-hospedada');
			}
		}
		return out;
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

	/**
	 * Enfileira a reação do Papo. A conversão do emoji para o formato do Discord acontece na
	 * execução do job, quando o guild está acessível — não aqui.
	 */
	private enqueuePapoReaction(link: ChannelLink, e: PapoWsReactEvent): void {
		// eco da reação que nós mesmos aplicamos no Papo: a contagem do Discord já foi registrada
		if (
			this.store.isSelfReaction({
				linkId: link.id,
				destinationMessageId: e.message_id,
				emoji: papoReactionKey(e),
				withinSeconds: SELF_REACTION_TTL_SECONDS
			})
		) {
			this.log.debug({ messageId: e.message_id }, 'eco de reação própria: não propagada');
			return;
		}

		const job: ReactionJob = {
			kind: 'reaction',
			side: 'papo',
			linkId: link.id,
			sourceMessageId: e.message_id,
			targetChannelId: link.discord_channel_id,
			emojiId: e.emoji_id ?? undefined,
			unicode: e.unicode ?? undefined,
			count: e.count,
			add: e.count > 0
		};
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'reaction',
			dedupeKey: `papo-react:${e.message_id}:${e.emoji_id ?? e.unicode}:${e.count}`,
			payload: { job } satisfies Envelope
		});
		this.queueFooterRefresh(link.id, 'papo', e.message_id, link.discord_channel_id);
	}

	/** Re-rendera o embed da cópia com o resumo atual de reações (máx. 1 a cada 3s). */
	private queueFooterRefresh(
		linkId: number,
		source: 'papo' | 'discord',
		sourceMessageId: string,
		targetChannelId: string
	): void {
		const bucket = Math.floor(Date.now() / 3000);
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
			dedupeKey: `footer:${source}:${sourceMessageId}:${bucket}`,
			payload: { job, footerOnly: true } satisfies Envelope
		});
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
			dedupeKey: `papo-pin:${e.message_id}:${e.is_pinned}`,
			payload: { job } satisfies Envelope
		});
	}

	/**
	 * Eventos que chegaram antes de a mensagem de origem estar bridgeada são enfileirados
	 * agora, na fila do link que acabou de criar o mapeamento.
	 */
	private flushDeferred(source: 'papo' | 'discord', sourceMessageId: string, linkId: number): void {
		if (source !== 'papo') return;
		const link = this.store.getChannelLinkById(linkId);
		if (!link) return;
		let flushed = 0;
		for (const row of this.store.takeDeferredEvents(source, sourceMessageId)) {
			const payload = JSON.parse(row.payload) as PapoWsReactEvent | PapoWsPinEvent;
			if (row.kind === 'reaction' && link.bridge_reactions) {
				this.enqueuePapoReaction(link, payload as PapoWsReactEvent);
				flushed += 1;
			} else if (row.kind === 'pin' && link.bridge_pins) {
				this.enqueuePapoPin(link, payload as PapoWsPinEvent);
				flushed += 1;
			} else {
				this.log.debug({ kind: row.kind, sourceMessageId }, 'evento adiado descartado: desligado no link');
			}
		}
		if (flushed) {
			this.log.debug({ sourceMessageId, flushed }, 'eventos adiados enfileirados');
			this.scheduleLink(linkId);
		}
	}

	// ── eventos Discord ────────────────────────────────────

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

	async onDiscordMessage(m: DiscordMessage): Promise<void> {
		if (this.discord.isSelf(m.author.id)) return; // anti-loop
		if (m.channel.isThread()) return; // v1: threads fora do escopo
		const link = this.linkForDiscordChannel(m.channelId);
		if (!link) return;
		if (this.store.findMapByDiscord(m.id).length) return;

		const displayName = m.member?.displayName ?? m.author.displayName ?? m.author.username;
		this.store.upsertDiscordUser({
			id: m.author.id,
			username: m.author.username,
			display_name: displayName,
			avatar_hash: m.author.avatar
		});
		await this.cacheMentionedDiscordUsers(m);

		const content = discordToPapoContent(m.content ?? '', this.resolvers(link));
		const chunks = chunkText(content, PAPO_EMBED_CHUNK_CHARS);
		const linkEmbeds = link.bridge_embeds ? discordEmbedsToPapo(m.embeds as APIEmbed[]) : [];
		const sources: SourceRef[] = link.bridge_attachments
			? m.attachments.map((a) => ({
					side: 'discord',
					id: a.id,
					name: a.name ?? 'arquivo',
					mime: a.contentType ?? undefined,
					sizeBytes: a.size,
					url: a.url
				}))
			: [];

		if (!chunks.length && !sources.length && !linkEmbeds.length) return;
		const total = Math.max(chunks.length, 1);
		const avatarUrl = m.author.displayAvatarURL({ extension: 'png', size: 256 });

		for (let i = 0; i < total; i++) {
			// sem texto mas com anexo/embed o card já mostra a mídia: não precisa de marcador
			const fallback = sources.length || linkEmbeds.length ? '' : '[mensagem sem texto]';
			const chunkContent = chunks[i] ?? (i === 0 ? (linkEmbeds[0]?.url ?? fallback) : '');
			const job: ToPapoMessageJob = {
				kind: 'message',
				linkId: link.id,
				papoChannelId: link.papo_channel_id,
				discordChannelId: m.channelId,
				discordMessageId: m.id,
				chunkIndex: i,
				chunkTotal: total,
				authorName: displayName,
				content: chunkContent,
				footerBase: `🕒 ${formatDate(m.createdAt.toISOString(), this.cfg.bridge.timezone)} · Discord${chunkLabel(i, total)}`,
				notes: [],
				sources: i === 0 ? sources : [],
				linkEmbeds,
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
		void before;
		const link = this.linkForDiscordChannel(after.channelId);
		if (!link || !link.bridge_edits) return;
		// mensagem parcial (não estava no cache): só temos id e canal, o conteúdo precisa ser buscado
		const fresh = after.partial ? await this.discord.fetchMessage(after.channelId, after.id) : (after as DiscordMessage);
		if (!fresh) {
			this.log.debug({ messageId: after.id }, 'edição do Discord sem conteúdo acessível');
			return;
		}
		if (this.discord.isSelf(fresh.author.id)) {
			// eco: foi o próprio bridge que reescreveu o embed (resumo de reação).
			this.log.debug({ messageId: fresh.id }, 'edição de embed ponte: eco ignorado');
			return;
		}
		const maps = this.store.findMapByDiscord(fresh.id);
		if (!maps.length && Date.now() - fresh.createdTimestamp > EDIT_MAP_GRACE_MS) {
			// mensagem antiga que nunca foi ponte: não há destino a atualizar
			this.log.debug({ messageId: fresh.id }, 'edição sem mapeamento: mensagem não ponte');
			return;
		}
		await this.cacheMentionedDiscordUsers(fresh);
		const chunks = chunkText(discordToPapoContent(fresh.content ?? '', this.resolvers(link)), PAPO_EMBED_CHUNK_CHARS);
		// sem mapeamento a mensagem ainda está na fila de bridge: o job re-tenta até ela aparecer
		const targets = maps.length
			? maps
					.filter((m) => m.papo_message_id)
					.map((m) => ({ chunkIndex: m.chunk_index, chunkTotal: Math.max(chunks.length, m.chunk_total) }))
			: chunks.map((_, i) => ({ chunkIndex: i, chunkTotal: chunks.length }));
		for (const target of targets) {
			const job: EditJob = {
				kind: 'edit',
				side: 'discord',
				linkId: link.id,
				sourceMessageId: fresh.id,
				targetChannelId: link.papo_channel_id,
				chunkIndex: target.chunkIndex,
				chunkTotal: target.chunkTotal,
				text: chunks[target.chunkIndex] ?? ''
			};
			this.outbox.enqueue({
				linkId: link.id,
				direction: 'to_papo',
				kind: 'edit',
				dedupeKey: `discord-edit:${fresh.id}:${target.chunkIndex}:${fresh.editedTimestamp ? new Date(fresh.editedTimestamp).toISOString() : Date.now()}`,
				payload: { job } satisfies Envelope
			});
		}
		this.scheduleLink(link.id);
	}

	async onDiscordDelete(m: DiscordMessage | PartialDiscordMessage): Promise<void> {
		const link = this.store.getChannelLinkByDiscord(m.channelId);
		if (!link || !link.bridge_deletes) return;
		if (!m.partial && this.discord.isSelf(m.author.id)) {
			// eco: o bridge apagou a própria cópia (deleção nascida no Papo).
			this.log.debug({ messageId: m.id }, 'deleção de embed ponte: eco ignorado');
			return;
		}
		if (!m.partial && !this.store.findMapByDiscord(m.id).length && Date.now() - m.createdTimestamp > EDIT_MAP_GRACE_MS) {
			// mensagem antiga que nunca foi ponte: não há destino a apagar
			this.log.debug({ messageId: m.id }, 'deleção sem mapeamento: mensagem não ponte');
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
		this.store.markMapDeleted(undefined, m.id);
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
		const link = this.store.getChannelLinkByDiscord(channelId);
		if (!link || !link.bridge_reactions) return;

		const custom = Boolean(emojiId);
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
			count,
			add
		};
		// sem mapeamento ainda, o job re-tenta: a mensagem pode estar na fila de bridge
		this.outbox.enqueue({
			linkId: link.id,
			direction: 'to_papo',
			kind: 'reaction',
			dedupeKey: `discord-react:${messageId}:${emojiName}:${add ? 'add' : 'remove'}:${count}`,
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
		if (this.running.has(linkId)) return;
		const run = this.runLink(linkId).finally(() => this.running.delete(linkId));
		this.running.set(linkId, run);
	}

	private async runLink(linkId: number): Promise<void> {
		let sent = 0;
		for (;;) {
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
				if (!transient) continue;
				await sleep(500);
			}
			sent += 1;
			if (sent % this.cfg.discord.maxMessagesPer5s === 0) await sleep(1200);
		}
	}

	private async execute(row: OutboxRow): Promise<void> {
		const env = JSON.parse(row.payload) as Envelope;
		switch (env.job.kind) {
			case 'message': {
				const job = env.job as ToDiscordMessageJob | ToPapoMessageJob;
				if ('description' in job) return this.sendToDiscord(job as ToDiscordMessageJob, env.embed);
				return this.sendToPapo(job as ToPapoMessageJob, env.embed);
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
				if (!s.url) throw new PermanentError(`attachment ${s.id} sem URL de origem`);
				const res = await fetch(s.url, { signal: AbortSignal.timeout(60_000) });
				if (!res.ok) throw new Error(`download ${s.url} → HTTP ${res.status}`);
				return Buffer.from(await res.arrayBuffer());
			}
		}));
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
		return this.emojis.tokenForDiscord(name, { findByName: (n) => this.discord.findGuildEmoji(n) });
	}

	/** Resumo de reações no dialeto de emoji do destino: `👍 3 · <:papu:123> 2`. */
	private reactionSummaryFor(
		dest: 'papo' | 'discord',
		rows: { emoji: string; count: number }[]
	): string {
		return reactionSummaryText(rows, 8, (emoji) => this.emojiTokenFor(dest, emoji));
	}

	/**
	 * Resumo de reações de uma mensagem já bridgeada: mescla as contagens dos dois lados do
	 * par (o eco da nossa própria reação conta 1 e nunca supera a contagem real).
	 */
	private reactionSummaryForMap(map: MessageMapRow, dest: 'papo' | 'discord'): string {
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

	/** Rodapé base, preservando o selo de edição já aplicado ao embed. */
	private footerText(map: MessageMapRow, embed: { footer?: { text?: string } }, max: number): string {
		const base = map.footer_base ?? '';
		const mark = base && embed.footer?.text?.startsWith(EDIT_MARK) ? EDIT_MARK : '';
		return clampText(`${mark}${base}`, max);
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

	/** Arquivos que os embeds salvos referenciam por `attachment://`: um edit precisa reenviá-los. */
	private filesForEmbedRefs(embeds: DiscordEmbedPayload[]): { name: string; buffer: Buffer }[] {
		const out: { name: string; buffer: Buffer }[] = [];
		const seen = new Set<string>();
		for (const e of embeds) {
			for (const url of [e.author?.icon_url, e.footer?.icon_url, e.thumbnail?.url, e.image?.url]) {
				const sha = shaFromAttachmentRef(url);
				if (!sha || seen.has(sha)) continue;
				const buffer = this.media.readFor(sha);
				if (!buffer) continue;
				seen.add(sha);
				out.push({ name: avatarAttachmentName(sha, this.media.extFor(sha)), buffer });
			}
		}
		return out;
	}

	private async sendToDiscord(job: ToDiscordMessageJob, embed?: DiscordEmbedPayload): Promise<void> {
		const avatar = this.avatarAttachment(job.authorIconSha, embed?.author?.icon_url);
		const plan = await prepareAttachments(this.sourcesToAttachments(job.sources), {
			maxFileBytes: this.cfg.discord.maxFileBytes,
			// o avatar anexado ocupa um dos dez anexos da mensagem
			maxFilesPerMessage: avatar ? DISCORD_LIMITS.attachmentsPerMessage - 1 : DISCORD_LIMITS.attachmentsPerMessage
		});

		const notes = [...job.notes, ...plan.notes];
		const description = notes.length
			? `${job.description}${job.description ? '\n\n' : ''}${notes.map((n) => `> ${n}`).join('\n')}`.trim()
			: job.description;

		const footerBase = `🕒 ${formatDate(job.timestamp, this.cfg.bridge.timezone)} · Papo${chunkLabel(job.chunkIndex, job.chunkTotal)}`;
		const built: DiscordEmbedPayload =
			embed ??
			buildDiscordBridgeEmbed({
				authorName: job.authorName,
				authorIconUrl: job.authorIconSha ? this.media.urlFor(job.authorIconSha, this.cfg.bridge.mediaBaseUrl) : undefined,
				description,
				footerText: footerBase,
				colorHex: job.colorHex
			});
		built.description = this.withReactionSummary(
			description,
			this.reactionSummaryFor('discord', this.store.listReactions(job.linkId, 'papo', job.papoMessageId)),
			DISCORD_LIMITS.embedDescriptionMax
		);
		built.footer = { text: clampText(footerBase, DISCORD_LIMITS.embedFooterMax) };
		if (avatar && !built.author?.icon_url) {
			built.author = {
				name: built.author?.name ?? job.authorName,
				...(built.author?.url ? { url: built.author.url } : {}),
				icon_url: attachmentRef(avatar.name)
			};
		}

		const groups = plan.groups.length ? plan.groups : [[]];
		let lastDiscordId: string | undefined;

		for (let g = 0; g < groups.length; g++) {
			const files = groups[g]!.map((f) => ({ name: f.name, buffer: f.data }));
			if (avatar && g === 0 && built.author?.icon_url === attachmentRef(avatar.name)) files.unshift(avatar);
			const extra = g > 0;
			const sent = await this.discord.send(job.discordChannelId, {
				embeds: extra
					? [
							buildDiscordBridgeEmbed({
								authorName: job.authorName,
								description: `📎 continuação de anexos (${g + 1}/${groups.length})`,
								footerText: `🕒 ${formatDate(job.timestamp, this.cfg.bridge.timezone)} · Papo`,
								colorHex: job.colorHex
							}) as APIEmbed
						]
					: [built as APIEmbed, ...((job.linkEmbeds ?? []) as APIEmbed[])],
				files,
				replyTo: extra ? lastDiscordId : this.copyForPapoMessage(job.replyRefPapoId)
			});
			lastDiscordId = sent.id;
			this.store.mapMessage({
				link_id: job.linkId,
				direction: 'papo_to_discord',
				papo_message_id: job.papoMessageId,
				discord_message_id: sent.id,
				// grupos extras de arquivos recebem índice fora do intervalo dos chunks de texto
				chunk_index: extra ? EXTRA_CHUNK_BASE + g : job.chunkIndex,
				chunk_total: job.chunkTotal,
				rendered: extra ? null : description,
				bridge_embed: extra ? null : built,
				footer_base: extra ? null : footerBase
			});
		}
		this.flushDeferred('papo', job.papoMessageId, job.linkId);
	}

	private async sendToPapo(job: ToPapoMessageJob, embed?: DiscordEmbedPayload): Promise<void> {
		const plan = await prepareAttachments(this.sourcesToAttachments(job.sources), {
			maxFileBytes: PAPO_LIMITS.attachmentMaxBytes,
			maxFilesPerMessage: PAPO_LIMITS.attachmentsPerMessage
		});

		// O texto vai todo no `description` do embed: a mensagem do Papo sai sem `content`
		// (o card é a mensagem). Notas de mídia entram no mesmo bloco.
		const notes = [...job.notes, ...plan.notes];
		const text = clampText(
			notes.length
				? `${job.content}${job.content ? '\n\n' : ''}${notes.map((n) => `> ${n}`).join('\n')}`.trim()
				: job.content,
			PAPO_LIMITS.embedDescriptionMax
		);

		const groups = plan.groups.length ? plan.groups : [[]];
		let lastPapoId: string | undefined;

		for (let g = 0; g < groups.length; g++) {
			const attachments = groups[g]!.map((f) => ({ name: f.name, data: f.data, mime: f.mime }));
			const extra = g > 0;

			const embeds = extra
				? [
						buildPapoBridgeEmbed({
							authorName: job.authorName,
							description: `📎 continuação de anexos (${g + 1}/${groups.length})`,
							footerText: job.footerBase,
							colorHex: '#5865F2'
						})
					]
				: [embed, ...(job.linkEmbeds ?? [])].filter(Boolean);

			const mainEmbed = extra ? undefined : embeds[0];
			if (mainEmbed) {
				mainEmbed.description = this.withReactionSummary(
					text,
					this.reactionSummaryFor('papo', this.store.listReactions(job.linkId, 'discord', job.discordMessageId)),
					PAPO_LIMITS.embedDescriptionMax
				);
				mainEmbed.footer = { text: clampText(job.footerBase, PAPO_LIMITS.embedFooterMax) };
			}
			if (!text && !attachments.length && !embeds.length) return;

			const created = await this.sendToPapoSafe({
				channelId: job.papoChannelId,
				content: undefined,
				replyTo: extra ? lastPapoId : this.copyForDiscordMessage(job.replyRefDiscordId),
				attachments,
				embeds: embeds.length ? (embeds as ToPapoMessageJob['linkEmbeds']) : undefined
			});
			lastPapoId = created.id;
			this.store.mapMessage({
				link_id: job.linkId,
				direction: 'discord_to_papo',
				papo_message_id: created.id,
				discord_message_id: job.discordMessageId,
				chunk_index: extra ? EXTRA_CHUNK_BASE + g : job.chunkIndex,
				chunk_total: job.chunkTotal,
				rendered: extra ? null : text,
				bridge_embed: extra ? null : mainEmbed ?? null,
				footer_base: extra ? null : job.footerBase
			});
		}
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

		if (job.side === 'papo') {
			// direction discord_to_papo: a mensagem do Papo é cópia nossa e a do Discord é de
			// outro autor — o Discord recusa a edição (50005).
			if (map.direction !== 'papo_to_discord') {
				this.log.debug({ papoMessageId: job.sourceMessageId }, 'edição ignorada: cópia do bot no Papo');
				return;
			}
			if (!map.discord_message_id) throw new RetryableError('sem mensagem do Discord mapeada');
			if (env.embedsOnly) {
				// preview de link do Papo: o card da ponte (texto/autor/avatar) continua primeiro,
				// os embeds do Papo vêm atrás.
				const card = map.bridge_embed ? (JSON.parse(map.bridge_embed) as DiscordEmbedPayload) : undefined;
				if (card)
					card.description = this.withReactionSummary(
						map.rendered ?? '',
						this.reactionSummaryForMap(map, 'discord'),
						DISCORD_LIMITS.embedDescriptionMax
					);
				const embeds = fitEmbedBudget(
					[...(card ? [card] : []), ...(env.embeds ?? [])],
					DISCORD_LIMITS.embedTotalChars
				);
				await this.discord.edit(job.targetChannelId, map.discord_message_id, {
					embeds: embeds as APIEmbed[],
					files: this.filesForEmbedRefs(embeds)
				});
				return;
			}
			const embed = this.discordCopyEmbed(map, job);
			await this.discord.edit(job.targetChannelId, map.discord_message_id, {
				embeds: [embed as APIEmbed],
				files: this.filesForEmbedRefs([embed])
			});
			this.store.updateMapSnapshot(map.id, { rendered: job.text, bridge_embed: embed });
			return;
		}

		if (!map.papo_message_id) throw new RetryableError('sem mensagem do Papo mapeada');
		// bridge papo→discord: a mensagem do Papo é a original, de outro autor. O
		// backend recusa edição de terceiros (403), e o lado Papo já é a fonte.
		if (map.direction !== 'discord_to_papo') {
			this.log.debug({ papoMessageId: map.papo_message_id }, 'edição ignorada: mensagem do Papo não é do bot');
			return;
		}
		const embed = this.papoCopyEmbed(map, job.text);
		await this.api.editMessage(map.papo_message_id, '', [embed]);
		this.store.updateMapSnapshot(map.id, { rendered: job.text, bridge_embed: embed });
	}

	/**
	 * Embed da cópia Discord: snapshot salvo em `message_map` com o texto novo no
	 * `description`. Reconstruir o embed do zero perdia o autor/avatar do card e deixava o
	 * anexo de avatar solto na mensagem — o Discord desenha como imagem quem nenhum embed
	 * referencia, e o card virava só o avatar do autor.
	 */
	private discordCopyEmbed(map: MessageMapRow, job: EditJob): DiscordEmbedPayload {
		const embed: DiscordEmbedPayload = map.bridge_embed
			? (JSON.parse(map.bridge_embed) as DiscordEmbedPayload)
			: { author: { name: 'Papo' } };
		embed.description = this.withReactionSummary(
			job.text,
			this.reactionSummaryForMap(map, 'discord'),
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
	private papoCopyEmbed(map: MessageMapRow, text: string): PapoEmbedInput {
		const embed: PapoEmbedInput = map.bridge_embed
			? (JSON.parse(map.bridge_embed) as PapoEmbedInput)
			: { author: { name: 'Discord' } };
		embed.description = this.withReactionSummary(
			text,
			this.reactionSummaryForMap(map, 'papo'),
			PAPO_LIMITS.embedDescriptionMax
		);
		const base = map.footer_base ?? 'Discord';
		embed.footer = { ...embed.footer, text: clampText(`${EDIT_MARK}${base}`, PAPO_LIMITS.embedFooterMax) };
		if (!embed.site_name) embed.site_name = 'Discord';
		return embed;
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
		const targets = maps.filter((m) => m.bridge_embed && !m.deleted);
		if (!targets.length) {
			// mensagem ponte antiga (sem snapshot) ou sem embed: nada a atualizar
			this.log.debug({ sourceMessageId: job.sourceMessageId }, 'embed sem snapshot: resumo de reações ignorado');
			return;
		}
		const link = this.store.getChannelLinkById(job.linkId);
		if (!link) throw new PermanentError('link removido');

		for (const map of targets) {
			if (map.direction === 'papo_to_discord') {
				// a cópia editável está no Discord
				if (!map.discord_message_id) continue;
				const embed = JSON.parse(map.bridge_embed!) as DiscordEmbedPayload;
				embed.description = this.withReactionSummary(
					map.rendered ?? '',
					this.reactionSummaryForMap(map, 'discord'),
					DISCORD_LIMITS.embedDescriptionMax
				);
				embed.footer = { text: this.footerText(map, embed, DISCORD_LIMITS.embedFooterMax) };
				await this.discord.edit(link.discord_channel_id, map.discord_message_id, {
					embeds: [embed as APIEmbed],
					files: this.filesForEmbedRefs([embed])
				});
				continue;
			}
			// a cópia editável está no Papo: o texto mora no embed, `content` fica limpo
			if (!map.papo_message_id) continue;
			const embed = JSON.parse(map.bridge_embed!) as PapoEmbedInput;
			embed.description = this.withReactionSummary(
				map.rendered ?? '',
				this.reactionSummaryForMap(map, 'papo'),
				PAPO_LIMITS.embedDescriptionMax
			);
			embed.footer = { text: this.footerText(map, embed, PAPO_LIMITS.embedFooterMax) };
			await this.api.editMessage(map.papo_message_id, '', [embed]);
		}
	}

	private async applyDelete(job: DeleteJob): Promise<void> {
		const maps =
			job.side === 'papo' ? this.store.findMapByPapo(job.sourceMessageId) : this.store.findMapByDiscord(job.sourceMessageId);
		if (!maps.length) throw new PermanentError('sem mapeamento para deleção');
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
					await this.api.deleteMessage(map.papo_message_id);
				}
			} catch (err) {
				const status = (err as { status?: number }).status;
				if (status === 404) continue; // já removida
				throw err;
			}
		}
		this.store.markMapDeleted(
			job.side === 'discord' ? job.sourceMessageId : undefined,
			job.side === 'papo' ? job.sourceMessageId : undefined
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
			const token = this.emojis.tokenForDiscord(name, { findByName: (n) => this.discord.findGuildEmoji(n) });
			if (token.startsWith('<')) native = token;
			else if (!this.discord.guildsCached()) throw new RetryableError('guilds ainda sem emojis no cache');
			else {
				this.log.debug({ emoji: display, messageId: job.sourceMessageId }, 'reação sem equivalente no guild: só o resumo de reações');
				return;
			}
		}

		try {
			await this.reactOnDiscord(job, link.discord_channel_id, map.discord_message_id, native);
		} catch (err) {
			if (!isUnknownEmoji(err)) throw err;
			// o cache do gateway ainda traz o emoji, mas o Discord o recusa (apagado ou
			// `available: false`): re-carrega a lista de indisponíveis e tenta o equivalente.
			await this.discord.loadUnavailableEmojis();
			const retry = name
				? this.emojis.tokenForDiscord(name, { findByName: (n) => this.discord.findGuildEmoji(n) })
				: undefined;
			if (!retry?.startsWith('<') || retry === native) {
				this.log.warn(
					{ emoji: display, messageId: job.sourceMessageId },
					'reação com emoji indisponível no guild: só o resumo de reações'
				);
				return;
			}
			await this.reactOnDiscord(job, link.discord_channel_id, map.discord_message_id, retry);
		}
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
		// Marca ANTES de aplicar: o Papo transmite o `react_update` antes de devolver o
		// HTTP, então o eco chega enquanto a chamada ainda está em voo. Marcando depois,
		// o eco não era reconhecido e a reação voltava ao Discord como duplicada.
		this.store.markSelfReaction({ linkId: link.id, destinationMessageId: map.papo_message_id, emoji: selfKey });
		try {
			if (job.add) await this.api.addReaction(link.papo_channel_id, map.papo_message_id, args);
			else await this.api.removeReaction(link.papo_channel_id, map.papo_message_id, args);
		} catch (err) {
			this.store.clearSelfReaction({ linkId: link.id, destinationMessageId: map.papo_message_id, emoji: selfKey });
			throw err;
		}
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
