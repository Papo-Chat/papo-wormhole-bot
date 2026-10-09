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
import { authorLabel, discordToPapoContent, formatDate, papoToDiscordContent, type TranslateResolvers } from './translator.js';
import {
	buildDiscordBridgeEmbed,
	buildPapoBridgeEmbed,
	discordEmbedsToPapo,
	papoEmbedsToDiscord,
	type DiscordEmbedPayload
} from './embeds.js';
import { prepareAttachments, type SourceAttachment } from './attachments.js';
import {
	footerWithReactions as buildReactionFooter,
	mergeReactionCounts,
	reactionSummaryText,
	type ReactionDisplay
} from './reactions.js';
import { EMBED_CHUNK_CHARS, PAPO_LIMITS, DISCORD_LIMITS, clampText } from './limits.js';
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
	/** Re-rendera só o rodapé do embed de destino (resumo de reações). */
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
				const cursorKey = `papo_cursor:${link.id}`;
				const since = this.store.getMeta(cursorKey);
				const messages = await this.api.listAllMessages(link.papo_channel_id, since, 2);
				const fresh = messages.filter((m) => this.store.findMapByPapo(m.id).length === 0);
				this.log.info({ linkId: link.id, total: messages.length, fresh: fresh.length }, 'backfill');
				for (const m of fresh) {
					await this.onPapoMessage(m);
					this.store.setMeta(cursorKey, m.created_at);
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

	private resolvers(): TranslateResolvers {
		return {
			propagateMentions: this.cfg.bridge.propagateMentions,
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

	private async onPapoMessage(msg: PapoWsMessageEvent | PapoMessage): Promise<void> {
		const link = this.linkForPapoChannel(msg.channel_id);
		if (!link) return;
		if (msg.author_id === this.papoUserId) return; // anti-loop
		if (this.store.findMapByPapo(msg.id).length) return; // idempotência

		const author = await this.identity.author(msg.author_id);
		const translated = papoToDiscordContent(msg.content ?? '', this.resolvers());
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
				sources: i === 0 ? sources : []
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
		this.store.setMeta(`papo_cursor:${link.id}`, msg.created_at);
		this.scheduleLink(link.id);
	}

	private async onPapoEdit(e: PapoWsEditEvent): Promise<void> {
		const link = this.linkForPapoChannel(e.channel_id);
		if (!link || !link.bridge_edits) return;
		const maps = this.store.findMapByPapo(e.id);
		const chunks = chunkText(papoToDiscordContent(e.content ?? '', this.resolvers()), EMBED_CHUNK_CHARS);
		// sem mapeamento a mensagem ainda está na fila de bridge: o job re-tenta até ela aparecer
		const targets = maps.length
			? maps
					.filter((m) => m.discord_message_id)
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
			if (!map.discord_message_id) continue;
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

	/** Re-rendera o rodapé do embed de destino com o resumo atual de reações (máx. 1 a cada 3s). */
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

		const content = discordToPapoContent(m.content ?? '', this.resolvers());
		const chunks = chunkText(content, PAPO_LIMITS.contentMax - 256);
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
			const chunkContent = chunks[i] ?? (i === 0 ? (linkEmbeds[0]?.url ?? '[mensagem sem texto]') : '');
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
				linkEmbeds
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
		const maps = this.store.findMapByDiscord(fresh.id);
		const chunks = chunkText(discordToPapoContent(fresh.content ?? '', this.resolvers()), PAPO_LIMITS.contentMax - 256);
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

	/** Resumo de reações no formato do rodapé: `👍 3 · ❤️ 1 · :nome: 2`. */
	private reactionSummary(linkId: number, source: 'papo' | 'discord', sourceMessageId: string): string {
		return reactionSummaryText(this.store.listReactions(linkId, source, sourceMessageId));
	}

	private footerWithReactions(
		base: string,
		linkId: number,
		source: 'papo' | 'discord',
		sourceMessageId: string,
		max: number
	): string {
		return buildReactionFooter(base, this.store.listReactions(linkId, source, sourceMessageId), max);
	}

	/**
	 * Rodapé de uma mensagem já bridgeada: mescla as contagens dos dois lados do par
	 * (o eco da nossa própria reação conta 1 e nunca supera a contagem real).
	 */
	private footerForMap(map: MessageMapRow, maxChars: number): string {
		const sides: ReactionDisplay[][] = [];
		if (map.papo_message_id) sides.push(this.store.listReactions(map.link_id, 'papo', map.papo_message_id));
		if (map.discord_message_id) sides.push(this.store.listReactions(map.link_id, 'discord', map.discord_message_id));
		return buildReactionFooter(map.footer_base ?? '', mergeReactionCounts(sides), maxChars);
	}

	private async sendToDiscord(job: ToDiscordMessageJob, embed?: DiscordEmbedPayload): Promise<void> {
		const plan = await prepareAttachments(this.sourcesToAttachments(job.sources), {
			maxFileBytes: this.cfg.discord.maxFileBytes,
			maxFilesPerMessage: 10
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
		built.description = clampText(description, DISCORD_LIMITS.embedDescriptionMax);
		built.footer = {
			text: this.footerWithReactions(footerBase, job.linkId, 'papo', job.papoMessageId, DISCORD_LIMITS.embedFooterMax)
		};

		const groups = plan.groups.length ? plan.groups : [[]];
		let lastDiscordId: string | undefined;

		for (let g = 0; g < groups.length; g++) {
			const files = groups[g]!.map((f) => ({ name: f.name, buffer: f.data }));
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
				replyTo: extra ? lastDiscordId : undefined
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

		const notes = [...job.notes, ...plan.notes];
		const content = clampText(
			notes.length
				? `${job.content}${job.content ? '\n\n' : ''}${notes.map((n) => `> ${n}`).join('\n')}`.trim()
				: job.content,
			PAPO_LIMITS.contentMax
		);

		const groups = plan.groups.length ? plan.groups : [[]];
		let lastPapoId: string | undefined;

		for (let g = 0; g < groups.length; g++) {
			const attachments = groups[g]!.map((f) => ({ name: f.name, data: f.data, mime: f.mime }));
			const extra = g > 0;
			if (!content && !attachments.length) return;

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
				mainEmbed.footer = {
					text: this.footerWithReactions(
						job.footerBase,
						job.linkId,
						'discord',
						job.discordMessageId,
						PAPO_LIMITS.embedFooterMax
					)
				};
			}

			const created = await this.sendToPapoSafe({
				channelId: job.papoChannelId,
				content: extra ? undefined : content,
				replyTo: extra ? job.replyToPapoId ?? lastPapoId : job.replyToPapoId,
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
				rendered: extra ? null : content,
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
			if (!map.discord_message_id) throw new RetryableError('sem mensagem do Discord mapeada');
			if (env.embedsOnly) {
				await this.discord.edit(job.targetChannelId, map.discord_message_id, {
					embeds: (env.embeds ?? []) as APIEmbed[]
				});
				return;
			}
			const link = this.store.getChannelLinkById(job.linkId);
			const original = this.store.findMapByPapo(job.sourceMessageId)[0];
			if (!original) throw new RetryableError('mapeamento ainda não disponível');
			await this.discord.edit(job.targetChannelId, map.discord_message_id, {
				embeds: [
					buildDiscordBridgeEmbed({
						authorName: 'mensagem editada',
						description: job.text,
						footerText: `✏️ editado · Papo${chunkLabel(job.chunkIndex, job.chunkTotal)}`,
						colorHex: link?.color ?? undefined
					}) as APIEmbed
				]
			});
			return;
		}

		if (!map.papo_message_id) throw new RetryableError('sem mensagem do Papo mapeada');
		await this.api.editMessage(map.papo_message_id, job.text);
	}

	/** Reescreve o rodapé do embed salvo em `message_map` com o resumo atual de reações. */
	private async refreshFooter(job: EditJob): Promise<void> {
		const maps =
			job.side === 'papo' ? this.store.findMapByPapo(job.sourceMessageId) : this.store.findMapByDiscord(job.sourceMessageId);
		const targets = maps.filter((m) => m.bridge_embed && !m.deleted);
		if (!targets.length) {
			// mensagem ponte antiga (sem snapshot) ou sem embed: nada a atualizar
			this.log.debug({ sourceMessageId: job.sourceMessageId }, 'rodapé sem embed salvo: resumo ignorado');
			return;
		}
		const link = this.store.getChannelLinkById(job.linkId);
		if (!link) throw new PermanentError('link removido');

		const maxFooter = job.side === 'papo' ? DISCORD_LIMITS.embedFooterMax : PAPO_LIMITS.embedFooterMax;
		for (const map of targets) {
			const embed = JSON.parse(map.bridge_embed!) as DiscordEmbedPayload & PapoEmbedInput;
			embed.footer = { text: this.footerForMap(map, maxFooter) };
			if (job.side === 'papo') {
				if (!map.discord_message_id) continue;
				await this.discord.edit(link.discord_channel_id, map.discord_message_id, { embeds: [embed as APIEmbed] });
				continue;
			}
			if (!map.papo_message_id) continue;
			await this.api.editMessage(map.papo_message_id, map.rendered ?? '', [embed as PapoEmbedInput]);
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
					await this.discord.delete(link.discord_channel_id, map.discord_message_id);
				} else if (job.side === 'discord' && map.papo_message_id) {
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
		// no rodapé o custom aparece como texto (:nome:) — footer não renderiza emoji custom
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
				this.log.debug({ emoji: display, messageId: job.sourceMessageId }, 'reação sem equivalente no guild: só o resumo do rodapé');
				return;
			}
		}

		if (job.add) await this.discord.react(link.discord_channel_id, map.discord_message_id, native);
		else await this.discord.unreact(link.discord_channel_id, map.discord_message_id, native);
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
		if (job.add) await this.api.addReaction(link.papo_channel_id, map.papo_message_id, args);
		else await this.api.removeReaction(link.papo_channel_id, map.papo_message_id, args);
		// marca como nossa: o `react_update` que isso dispara não deve voltar ao Discord
		this.store.markSelfReaction({
			linkId: link.id,
			destinationMessageId: map.papo_message_id,
			emoji: papoEmoji ? `e:${papoEmoji.id}` : `u:${display}`
		});
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
