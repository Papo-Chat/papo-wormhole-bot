import type { PapoApi } from '../papo/api.js';
import type { PapoEmoji } from '../papo/types.js';
import { PapoApiError } from '../papo/types.js';
import type { Store } from '../db/store.js';
import { PAPO_LIMITS } from './limits.js';

export interface GuildEmojiLike {
	id: string;
	name: string;
	animated?: boolean;
}

/** Resolver de emoji do guild Discord (injetado para não acoplar ao discord.js). */
export interface GuildEmojiResolver {
	findByName(name: string): GuildEmojiLike | undefined;
}

const EMOJI_NAME_RE = /^[A-Za-z0-9_]{1,32}$/;

export class EmojiBridge {
	private papoIndex?: Map<string, PapoEmoji>;

	constructor(
		private api: PapoApi,
		private store: Store,
		private opts: { autoImport: boolean } = { autoImport: true }
	) {}

	/** Índice name → emoji do Papo (GET /emojis paginado). */
	async loadPapoIndex(force = false): Promise<Map<string, PapoEmoji>> {
		if (this.papoIndex && !force) return this.papoIndex;
		const list = await this.api.listAllEmojis();
		const map = new Map<string, PapoEmoji>();
		for (const e of list) {
			map.set(e.name.toLowerCase(), e);
			this.store.upsertEmoji({ name: e.name, papo_emoji_id: e.id });
		}
		this.papoIndex = map;
		return map;
	}

	async papoByName(name: string): Promise<PapoEmoji | undefined> {
		const index = await this.loadPapoIndex();
		return index.get(name.toLowerCase());
	}

	/** Resolve emoji do Papo pelo id (usado ao converter reações). */
	async papoById(id: string): Promise<PapoEmoji | undefined> {
		const known = this.store.getEmojiByPapoId(id);
		if (known?.name) {
			const hit = await this.papoByName(known.name);
			if (hit) return hit;
		}
		const index = await this.loadPapoIndex();
		for (const e of index.values()) if (e.id === id) return e;
		return undefined;
	}

	/**
	 * Importa um emoji do Discord para o Papo.
	 * Requer `manage_server` no Papo; sem a permissão o bridge cai para `:name:` literal.
	 */
	async importDiscordEmojiToPapo(name: string, emojiId: string, animated: boolean): Promise<PapoEmoji | undefined> {
		if (!this.opts.autoImport) return undefined;
		const safeName = name.slice(0, PAPO_LIMITS.emojiNameMax);
		if (!EMOJI_NAME_RE.test(safeName)) return undefined;

		const url = `https://cdn.discordapp.com/emojis/${encodeURIComponent(emojiId)}.${animated ? 'gif' : 'png'}`;
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
			if (!res.ok) return undefined;
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > PAPO_LIMITS.emojiMaxBytes) return undefined;
			const created = await this.api.createEmoji(safeName, buf.toString('base64'), animated ? 'GIF' : 'PNG');
			this.papoIndex = undefined; // índice desatualizado
			this.store.upsertEmoji({
				name: safeName,
				papo_emoji_id: created.id,
				discord_emoji_id: emojiId,
				discord_emoji_name: name,
				discord_animated: animated
			});
			return created;
		} catch (err) {
			if (err instanceof PapoApiError && (err.status === 403 || err.status === 409)) return undefined;
			return undefined;
		}
	}

	/** Emoji do Papo → token no Discord (`<:name:id>` quando o guild tem o mesmo nome). */
	tokenForDiscord(name: string, guild: GuildEmojiResolver): string {
		const found = guild.findByName(name);
		if (!found) return `:${name}:`;
		this.store.upsertEmoji({
			name,
			discord_emoji_id: found.id,
			discord_emoji_name: found.name,
			discord_animated: Boolean(found.animated)
		});
		return `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>`;
	}

	/** Emoji do Discord → shortcode do Papo, importando quando possível. */
	async shortcodeForPapo(name: string, emojiId: string, animated: boolean, guild?: GuildEmojiResolver): Promise<string> {
		const existing = await this.papoByName(name);
		if (existing) {
			this.store.upsertEmoji({
				name: existing.name,
				papo_emoji_id: existing.id,
				discord_emoji_id: emojiId,
				discord_emoji_name: name,
				discord_animated: animated
			});
			return `:${existing.name}:`;
		}
		const imported = await this.importDiscordEmojiToPapo(name, emojiId, animated);
		if (imported) return `:${imported.name}:`;
		void guild;
		return `:${name.slice(0, PAPO_LIMITS.emojiNameMax)}:`;
	}
}
