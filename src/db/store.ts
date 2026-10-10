import type { Db } from './index.js';
import { rows } from './index.js';

export type ChannelMode = 'both' | 'to_discord' | 'to_papo';
export type IdentityMode = 'embed' | 'webhook';

export interface ChannelLink {
	id: number;
	papo_channel_id: string;
	discord_channel_id: string;
	mode: ChannelMode;
	identity: IdentityMode;
	paused: number;
	bridge_attachments: number;
	bridge_embeds: number;
	bridge_reactions: number;
	bridge_edits: number;
	bridge_deletes: number;
	bridge_pins: number;
	propagate_mentions: number;
	color: string | null;
	created_at: string;
}

export interface PapoUser {
	id: string;
	username: string;
	nickname: string | null;
	avatar_sha: string | null;
}

export interface DiscordUser {
	id: string;
	username: string | null;
	display_name: string | null;
	avatar_hash: string | null;
}

export interface EmojiMapEntry {
	name: string;
	papo_emoji_id: string | null;
	discord_emoji_id: string | null;
	discord_emoji_name: string | null;
	discord_animated: number;
	image_sha: string | null;
}

export interface MessageMapRow {
	id: number;
	link_id: number;
	direction: 'papo_to_discord' | 'discord_to_papo';
	papo_message_id: string | null;
	discord_message_id: string | null;
	chunk_index: number;
	chunk_total: number;
	rendered: string | null;
	bridge_embed: string | null;
	footer_base: string | null;
	edit_revision: string | null;
	deleted: number;
}

export interface ReactionCountRow {
	emoji: string;
	count: number;
}

export interface DeferredEventRow {
	id: number;
	source: 'papo' | 'discord';
	source_message_id: string;
	kind: 'reaction' | 'edit' | 'delete' | 'pin';
	payload: string;
	created_at: string;
}

export interface PresenceRow {
	platform: 'papo' | 'discord';
	user_id: string;
	status: string;
	updated_at: string;
}

export const bool = (v: boolean | number | undefined): number => (v ? 1 : 0);

export class Store {
	constructor(private db: Db) {}

	/**
	 * Executa `fn` numa única transação SQLite. É o que torna atômica a transferência de
	 * eventos adiados para a outbox: se o processo cair no meio, nada foi apagado.
	 */
	withTransaction<T>(fn: () => T): T {
		if (this.db.isTransaction) return fn();
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const out = fn();
			this.db.exec('COMMIT');
			return out;
		} catch (err) {
			try {
				this.db.exec('ROLLBACK');
			} catch {
				// transação já desfeita pelo próprio SQLite
			}
			throw err;
		}
	}

	// ── meta ───────────────────────────────────────────────
	getMeta(key: string): string | undefined {
		const r = rows<{ value: string }>(this.db.prepare('SELECT value FROM meta WHERE key = ?').all(key));
		return r[0]?.value;
	}
	setMeta(key: string, value: string): void {
		this.db
			.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
			.run(key, value);
	}

	// ── users ──────────────────────────────────────────────
	upsertPapoUser(u: { id: string; username: string; nickname?: string | null; avatar_sha?: string | null }): void {
		this.db
			.prepare(
				`INSERT INTO users_papo (id, username, nickname, avatar_sha)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   username = excluded.username,
				   nickname = COALESCE(excluded.nickname, users_papo.nickname),
				   avatar_sha = COALESCE(excluded.avatar_sha, users_papo.avatar_sha),
				   updated_at = datetime('now')`
			)
			.run(u.id, u.username, u.nickname ?? null, u.avatar_sha ?? null);
	}
	getPapoUser(id: string): PapoUser | undefined {
		return rows<PapoUser>(this.db.prepare('SELECT * FROM users_papo WHERE id = ?').all(id))[0];
	}
	upsertDiscordUser(u: { id: string; username?: string | null; display_name?: string | null; avatar_hash?: string | null }): void {
		this.db
			.prepare(
				`INSERT INTO users_discord (id, username, display_name, avatar_hash)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
				   username = COALESCE(excluded.username, users_discord.username),
				   display_name = COALESCE(excluded.display_name, users_discord.display_name),
				   avatar_hash = COALESCE(excluded.avatar_hash, users_discord.avatar_hash),
				   updated_at = datetime('now')`
			)
			.run(u.id, u.username ?? null, u.display_name ?? null, u.avatar_hash ?? null);
	}
	getDiscordUser(id: string): DiscordUser | undefined {
		return rows<DiscordUser>(this.db.prepare('SELECT * FROM users_discord WHERE id = ?').all(id))[0];
	}

	// ── user links ─────────────────────────────────────────
	linkUser(papoUserId: string, discordUserId: string): void {
		this.db
			.prepare('INSERT INTO user_links (papo_user_id, discord_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
			.run(papoUserId, discordUserId);
	}
	unlinkUser(discordUserId: string): number {
		return Number(this.db.prepare('DELETE FROM user_links WHERE discord_user_id = ?').run(discordUserId).changes);
	}
	getLinkByPapoUser(papoUserId: string): { discord_user_id: string } | undefined {
		return rows<{ discord_user_id: string }>(
			this.db.prepare('SELECT discord_user_id FROM user_links WHERE papo_user_id = ?').all(papoUserId)
		)[0];
	}
	getLinkByDiscordUser(discordUserId: string): { papo_user_id: string } | undefined {
		return rows<{ papo_user_id: string }>(
			this.db.prepare('SELECT papo_user_id FROM user_links WHERE discord_user_id = ?').all(discordUserId)
		)[0];
	}

	// ── server links ───────────────────────────────────────
	upsertServerLink(papoServerId: string, discordGuildId: string): void {
		this.db
			.prepare(
				`INSERT INTO server_links (papo_server_id, discord_guild_id) VALUES (?, ?)
				 ON CONFLICT(papo_server_id) DO UPDATE SET discord_guild_id = excluded.discord_guild_id`
			)
			.run(papoServerId, discordGuildId);
	}
	getServerLink(papoServerId: string): { discord_guild_id: string } | undefined {
		return rows<{ discord_guild_id: string }>(
			this.db.prepare('SELECT discord_guild_id FROM server_links WHERE papo_server_id = ?').all(papoServerId)
		)[0];
	}

	// ── channel links ──────────────────────────────────────
	/**
	 * Ponto de partida do fluxo Papo → Discord de um canal: o instante em que o link
	 * foi criado. Histórico anterior ao link nunca é reenviado; `backfill` de restart
	 * só recupera o que ficou para trás depois desse ponto.
	 */
	getPapoCursor(linkId: number): string | undefined {
		return this.getMeta(`papo_cursor:${linkId}`);
	}
	setPapoCursor(linkId: number, value: string): void {
		this.setMeta(`papo_cursor:${linkId}`, value);
	}
	/** Semeia o cursor (não sobrescreve) e devolve o valor vigente. */
	seedPapoCursor(linkId: number, at: Date = new Date()): string {
		this.db
			.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
			.run(`papo_cursor:${linkId}`, at.toISOString());
		return this.getPapoCursor(linkId)!;
	}

	upsertChannelLink(l: {
		papo_channel_id: string;
		discord_channel_id: string;
		mode?: ChannelMode;
		identity?: IdentityMode;
		color?: string | null;
	}): ChannelLink {
		const isNew = !this.getChannelLinkByPapo(l.papo_channel_id);
		this.db
			.prepare(
				`INSERT INTO channel_links (papo_channel_id, discord_channel_id, mode, identity, color)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(papo_channel_id) DO UPDATE SET
				   discord_channel_id = excluded.discord_channel_id,
				   mode = excluded.mode,
				   identity = excluded.identity,
				   color = excluded.color`
			)
			.run(
				l.papo_channel_id,
				l.discord_channel_id,
				l.mode ?? 'both',
				l.identity ?? 'embed',
				l.color ?? null
			);
		const link = this.getChannelLinkByPapo(l.papo_channel_id)!;
		if (isNew) this.seedPapoCursor(link.id);
		return link;
	}
	getChannelLinkByPapo(papoChannelId: string): ChannelLink | undefined {
		return rows<ChannelLink>(
			this.db.prepare('SELECT * FROM channel_links WHERE papo_channel_id = ?').all(papoChannelId)
		)[0];
	}
	getChannelLinkById(id: number): ChannelLink | undefined {
		return rows<ChannelLink>(this.db.prepare('SELECT * FROM channel_links WHERE id = ?').all(id))[0];
	}
	getChannelLinkByDiscord(discordChannelId: string): ChannelLink | undefined {
		return rows<ChannelLink>(
			this.db.prepare('SELECT * FROM channel_links WHERE discord_channel_id = ?').all(discordChannelId)
		)[0];
	}
	removeChannelLink(discordChannelId: string): boolean {
		const link = this.getChannelLinkByDiscord(discordChannelId);
		const removed = this.db.prepare('DELETE FROM channel_links WHERE discord_channel_id = ?').run(discordChannelId).changes > 0;
		if (link) this.db.prepare('DELETE FROM meta WHERE key = ?').run(`papo_cursor:${link.id}`);
		return removed;
	}
	listChannelLinks(): ChannelLink[] {
		return rows<ChannelLink>(this.db.prepare('SELECT * FROM channel_links ORDER BY created_at').all());
	}
	setChannelLinkFlag(id: number, flag: keyof ChannelLink, value: number): void {
		const allowed = new Set([
			'paused',
			'bridge_attachments',
			'bridge_embeds',
			'bridge_reactions',
			'bridge_edits',
			'bridge_deletes',
			'bridge_pins',
			'propagate_mentions',
			'mode',
			'identity',
			'color'
		]);
		if (!allowed.has(flag as string)) throw new Error(`flag desconhecida: ${String(flag)}`);
		this.db.prepare(`UPDATE channel_links SET ${String(flag)} = ? WHERE id = ?`).run(value, id);
	}

	// ── message map ────────────────────────────────────────
	mapMessage(m: {
		link_id: number;
		direction: 'papo_to_discord' | 'discord_to_papo';
		papo_message_id?: string | null;
		discord_message_id?: string | null;
		chunk_index?: number;
		chunk_total?: number;
		content_sha?: string | null;
		rendered?: string | null;
		bridge_embed?: unknown;
		footer_base?: string | null;
	}): void {
		this.db
			.prepare(
				`INSERT INTO message_map (link_id, direction, papo_message_id, discord_message_id, chunk_index, chunk_total, content_sha, rendered, bridge_embed, footer_base)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT DO NOTHING`
			)
			.run(
				m.link_id,
				m.direction,
				m.papo_message_id ?? null,
				m.discord_message_id ?? null,
				m.chunk_index ?? 0,
				m.chunk_total ?? 1,
				m.content_sha ?? null,
				m.rendered ?? null,
				m.bridge_embed === undefined ? null : JSON.stringify(m.bridge_embed),
				m.footer_base ?? null
			);
	}

	/**
	 * Atualiza o snapshot do que foi enviado no destino. Uma edição reescreve o embed da
	 * cópia: sem regravar o snapshot, o próximo resumo de reações reenviaria o texto velho.
	 */
	updateMapSnapshot(
		id: number,
		snapshot: { rendered?: string | null; bridge_embed?: unknown; footer_base?: string | null; edit_revision?: string | null }
	): void {
		const sets: string[] = [];
		const args: (string | number | null)[] = [];
		if (snapshot.rendered !== undefined) {
			sets.push('rendered = ?');
			args.push(snapshot.rendered);
		}
		if (snapshot.bridge_embed !== undefined) {
			sets.push('bridge_embed = ?');
			args.push(snapshot.bridge_embed === null ? null : JSON.stringify(snapshot.bridge_embed));
		}
		if (snapshot.footer_base !== undefined) {
			sets.push('footer_base = ?');
			args.push(snapshot.footer_base);
		}
		if (snapshot.edit_revision !== undefined) {
			sets.push('edit_revision = ?');
			args.push(snapshot.edit_revision);
		}
		if (!sets.length) return;
		args.push(id);
		this.db.prepare(`UPDATE message_map SET ${sets.join(', ')} WHERE id = ?`).run(...args);
	}

	findMapByPapo(papoMessageId: string): MessageMapRow[] {
		return rows<MessageMapRow>(
			this.db
				.prepare('SELECT * FROM message_map WHERE papo_message_id = ? ORDER BY chunk_index')
				.all(papoMessageId)
		);
	}
	findMapByDiscord(discordMessageId: string): MessageMapRow[] {
		return rows<MessageMapRow>(
			this.db
				.prepare('SELECT * FROM message_map WHERE discord_message_id = ? ORDER BY chunk_index')
				.all(discordMessageId)
		);
	}
	markMapDeleted(papoMessageId?: string, discordMessageId?: string): void {
		if (papoMessageId) this.db.prepare('UPDATE message_map SET deleted = 1 WHERE papo_message_id = ?').run(papoMessageId);
		if (discordMessageId)
			this.db.prepare('UPDATE message_map SET deleted = 1 WHERE discord_message_id = ?').run(discordMessageId);
	}
	/** Última mensagem Papo já bridgeada em um canal (cursor de backfill). */
	lastPapoMessageId(linkId: number): string | undefined {
		const r = rows<{ papo_message_id: string }>(
			this.db
				.prepare(
					`SELECT papo_message_id FROM message_map
					 WHERE link_id = ? AND direction = 'papo_to_discord' AND papo_message_id IS NOT NULL
					 ORDER BY id DESC LIMIT 1`
				)
				.all(linkId)
		);
		return r[0]?.papo_message_id;
	}

	// ── reações (resumo exibido no embed) ──────────────────
	/** Grava a contagem absoluta de um emoji numa mensagem de origem (0 remove a linha). */
	setReaction(r: {
		linkId: number;
		source: 'papo' | 'discord';
		sourceMessageId: string;
		emoji: string;
		count: number;
	}): void {
		if (r.count <= 0) {
			this.db
				.prepare('DELETE FROM reaction_counts WHERE link_id = ? AND source = ? AND source_message_id = ? AND emoji = ?')
				.run(r.linkId, r.source, r.sourceMessageId, r.emoji);
			return;
		}
		this.db
			.prepare(
				`INSERT INTO reaction_counts (link_id, source, source_message_id, emoji, count)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(link_id, source, source_message_id, emoji)
				 DO UPDATE SET count = excluded.count, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
			)
			.run(r.linkId, r.source, r.sourceMessageId, r.emoji, r.count);
	}

	listReactions(linkId: number, source: 'papo' | 'discord', sourceMessageId: string): ReactionCountRow[] {
		return rows<ReactionCountRow>(
			this.db
				.prepare(
					`SELECT emoji, count FROM reaction_counts
					 WHERE link_id = ? AND source = ? AND source_message_id = ? AND count > 0
					 ORDER BY count DESC, emoji ASC`
				)
				.all(linkId, source, sourceMessageId)
		);
	}

	/**
	 * Registra que fomos nós que aplicamos esta reação no Papo (para reconhecer o eco do
	 * `react_update`). Cada aplicação soma um eco esperado: o marcador é de uso único.
	 */
	markSelfReaction(r: { linkId: number; destinationMessageId: string; emoji: string }): void {
		this.db
			.prepare(
				`INSERT INTO self_reactions (link_id, destination_message_id, emoji, pending_echoes)
				 VALUES (?, ?, ?, 1)
				 ON CONFLICT(link_id, destination_message_id, emoji)
				 DO UPDATE SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
				   pending_echoes = self_reactions.pending_echoes + 1`
			)
			.run(r.linkId, r.destinationMessageId, r.emoji);
	}

	/** Desmarca (falha na chamada: a reação nunca chegou ao Papo, o eco não vai existir). */
	clearSelfReaction(r: { linkId: number; destinationMessageId: string; emoji: string }): void {
		this.db
			.prepare('DELETE FROM self_reactions WHERE link_id = ? AND destination_message_id = ? AND emoji = ?')
			.run(r.linkId, r.destinationMessageId, r.emoji);
	}

	/**
	 * Reconhece **um** eco esperado e o consome. Sem consumo, uma reação legítima igual à
	 * nossa ficava suprimida até a janela expirar.
	 */
	consumeSelfReaction(r: {
		linkId: number;
		destinationMessageId: string;
		emoji: string;
		withinSeconds: number;
	}): boolean {
		const seconds = `-${Math.max(1, Math.floor(r.withinSeconds))} seconds`;
		const res = this.db
			.prepare(
				`UPDATE self_reactions SET pending_echoes = pending_echoes - 1
				 WHERE link_id = ? AND destination_message_id = ? AND emoji = ?
				   AND pending_echoes > 0
				   AND applied_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
			)
			.run(r.linkId, r.destinationMessageId, r.emoji, seconds);
		return Number(res.changes ?? 0) > 0;
	}

	/** true se a reação vista no Papo foi aplicada por nós há menos de `withinSeconds`. */
	isSelfReaction(r: {
		linkId: number;
		destinationMessageId: string;
		emoji: string;
		withinSeconds: number;
	}): boolean {
		const seconds = `-${Math.max(1, Math.floor(r.withinSeconds))} seconds`;
		return (
			this.db
				.prepare(
					`SELECT 1 FROM self_reactions
					 WHERE link_id = ? AND destination_message_id = ? AND emoji = ?
					   AND pending_echoes > 0
					   AND applied_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`
				)
				.get(r.linkId, r.destinationMessageId, r.emoji, seconds) !== undefined
		);
	}

	pruneSelfReactions(olderThanSeconds: number): number {
		const seconds = `-${Math.max(1, Math.floor(olderThanSeconds))} seconds`;
		const res = this.db
			.prepare(`DELETE FROM self_reactions WHERE applied_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`)
			.run(seconds);
		return Number(res.changes ?? 0);
	}

	// ── espelhos aplicados no destino ───────────────────────
	/**
	 * Marca o emoji que o bridge mantém na cópia. Serve para descontar a reação do bot
	 * quando a contagem observada na origem a inclui.
	 */
	markMirrorReaction(r: { linkId: number; side: 'papo' | 'discord'; destinationMessageId: string; emoji: string }): void {
		this.db
			.prepare(
				`INSERT INTO mirror_reactions (link_id, side, destination_message_id, emoji)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(link_id, side, destination_message_id, emoji)
				 DO UPDATE SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
			)
			.run(r.linkId, r.side, r.destinationMessageId, r.emoji);
	}

	clearMirrorReaction(r: { linkId: number; side: 'papo' | 'discord'; destinationMessageId: string; emoji: string }): void {
		this.db
			.prepare('DELETE FROM mirror_reactions WHERE link_id = ? AND side = ? AND destination_message_id = ? AND emoji = ?')
			.run(r.linkId, r.side, r.destinationMessageId, r.emoji);
	}

	hasMirrorReaction(r: { linkId: number; side: 'papo' | 'discord'; destinationMessageId: string; emoji: string }): boolean {
		return (
			this.db
				.prepare('SELECT 1 FROM mirror_reactions WHERE link_id = ? AND side = ? AND destination_message_id = ? AND emoji = ?')
				.get(r.linkId, r.side, r.destinationMessageId, r.emoji) !== undefined
		);
	}

	// ── tombstone de exclusão ───────────────────────────────
	/**
	 * A origem foi apagada. Persiste mesmo sem `message_map`: é o que permite reconciliar
	 * o delete com o job de criação que ainda não rodou.
	 */
	tombstoneMessage(side: 'papo' | 'discord', sourceMessageId: string): void {
		this.db
			.prepare(
				`INSERT INTO message_tombstones (side, source_message_id) VALUES (?, ?)
				 ON CONFLICT(side, source_message_id) DO UPDATE SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
			)
			.run(side, sourceMessageId);
	}

	isTombstoned(side: 'papo' | 'discord', sourceMessageId: string): boolean {
		return this.db.prepare('SELECT 1 FROM message_tombstones WHERE side = ? AND source_message_id = ?').get(side, sourceMessageId) !== undefined;
	}

	pruneTombstones(olderThanSeconds: number): number {
		const seconds = `-${Math.max(1, Math.floor(olderThanSeconds))} seconds`;
		return Number(
			this.db
				.prepare(`DELETE FROM message_tombstones WHERE deleted_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`)
				.run(seconds).changes
		);
	}

	// ── eventos fora de ordem (mensagem ainda não bridgeada) ────
	deferEvent(e: {
		source: 'papo' | 'discord';
		sourceMessageId: string;
		kind: 'reaction' | 'edit' | 'delete' | 'pin';
		payload: unknown;
	}): void {
		this.db
			.prepare('INSERT INTO deferred_events (source, source_message_id, kind, payload) VALUES (?, ?, ?, ?)')
			.run(e.source, e.sourceMessageId, e.kind, JSON.stringify(e.payload));
	}

	/** Consulta sem remover: permite medir o que ainda espera um bridge. */
	peekDeferredEvents(source: 'papo' | 'discord', sourceMessageId: string): DeferredEventRow[] {
		return rows<DeferredEventRow>(
			this.db
				.prepare('SELECT id, source, source_message_id, kind, payload, created_at FROM deferred_events WHERE source = ? AND source_message_id = ? ORDER BY id')
				.all(source, sourceMessageId)
		);
	}

	/** Remove e devolve os eventos adiados de uma mensagem de origem. */
	takeDeferredEvents(source: 'papo' | 'discord', sourceMessageId: string): DeferredEventRow[] {
		const found = rows<DeferredEventRow>(
			this.db
				.prepare('SELECT id, source, source_message_id, kind, payload, created_at FROM deferred_events WHERE source = ? AND source_message_id = ? ORDER BY id')
				.all(source, sourceMessageId)
		);
		if (found.length) {
			this.db.prepare('DELETE FROM deferred_events WHERE source = ? AND source_message_id = ?').run(source, sourceMessageId);
		}
		return found;
	}

	pruneDeferredEvents(olderThanSeconds: number): number {
		const seconds = `-${Math.max(1, Math.floor(olderThanSeconds))} seconds`;
		return Number(
			this.db
				.prepare(`DELETE FROM deferred_events WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`)
				.run(seconds).changes
		);
	}

	// ── emojis ─────────────────────────────────────────────
	getEmojiByName(name: string): EmojiMapEntry | undefined {
		return rows<EmojiMapEntry>(this.db.prepare('SELECT * FROM emoji_map WHERE name = ?').all(name.toLowerCase()))[0];
	}
	getEmojiByPapoId(id: string): EmojiMapEntry | undefined {
		return rows<EmojiMapEntry>(this.db.prepare('SELECT * FROM emoji_map WHERE papo_emoji_id = ?').all(id))[0];
	}
	upsertEmoji(e: {
		name: string;
		papo_emoji_id?: string | null;
		discord_emoji_id?: string | null;
		discord_emoji_name?: string | null;
		discord_animated?: boolean;
		image_sha?: string | null;
	}): void {
		const name = e.name.toLowerCase();
		this.db
			.prepare(
				`INSERT INTO emoji_map (name, papo_emoji_id, discord_emoji_id, discord_emoji_name, discord_animated, image_sha)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(name) DO UPDATE SET
				   papo_emoji_id = COALESCE(excluded.papo_emoji_id, emoji_map.papo_emoji_id),
				   discord_emoji_id = COALESCE(excluded.discord_emoji_id, emoji_map.discord_emoji_id),
				   discord_emoji_name = COALESCE(excluded.discord_emoji_name, emoji_map.discord_emoji_name),
				   discord_animated = COALESCE(excluded.discord_animated, emoji_map.discord_animated),
				   image_sha = COALESCE(excluded.image_sha, emoji_map.image_sha)`
			)
			.run(
				name,
				e.papo_emoji_id ?? null,
				e.discord_emoji_id ?? null,
				e.discord_emoji_name ?? null,
				bool(e.discord_animated),
				e.image_sha ?? null
			);
	}

	// ── media cache ────────────────────────────────────────
	upsertMedia(m: { sha256: string; path: string; mime?: string | null; sizeBytes?: number | null; source?: string | null }): void {
		this.db
			.prepare(
				`INSERT INTO media_cache (sha256, path, mime, size_bytes, source) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(sha256) DO UPDATE SET path = excluded.path, mime = excluded.mime, size_bytes = excluded.size_bytes`
			)
			.run(m.sha256, m.path, m.mime ?? null, m.sizeBytes ?? null, m.source ?? null);
	}
	getMedia(sha256: string): { sha256: string; path: string; mime: string | null } | undefined {
		return rows<{ sha256: string; path: string; mime: string | null }>(
			this.db.prepare('SELECT sha256, path, mime FROM media_cache WHERE sha256 = ?').all(sha256)
		)[0];
	}

	// ── presence ───────────────────────────────────────────
	setPresence(platform: 'papo' | 'discord', userId: string, status: string): void {
		this.db
			.prepare(
				`INSERT INTO presence_cache (platform, user_id, status) VALUES (?, ?, ?)
				 ON CONFLICT(platform, user_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
			)
			.run(platform, userId, status);
	}
	/** Statuses "disponíveis" nos dois vocabulários (Papo: online/away/busy · Discord: online/idle/dnd). */
	listPresence(
		platform: 'papo' | 'discord',
		statuses = ['online', 'away', 'busy', 'idle', 'dnd']
	): PresenceRow[] {
		const placeholders = statuses.map(() => '?').join(',');
		return rows<PresenceRow>(
			this.db.prepare(`SELECT * FROM presence_cache WHERE platform = ? AND status IN (${placeholders})`).all(platform, ...statuses)
		);
	}

	// ── audit ──────────────────────────────────────────────
	audit(level: string, event: string, payload?: unknown): void {
		this.db
			.prepare('INSERT INTO audit_log (level, event, payload) VALUES (?, ?, ?)')
			.run(level, event, payload === undefined ? null : JSON.stringify(payload));
	}
	recentAudit(limit = 20) {
		return rows<{ id: number; ts: string; level: string; event: string; payload: string | null }>(
			this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit)
		);
	}
}
