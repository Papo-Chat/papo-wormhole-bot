import type { PapoApi } from '../papo/api.js';
import type { PapoEmoji } from '../papo/types.js';
import { PapoApiError } from '../papo/types.js';
import type { Store } from '../db/store.js';
import { DISCORD_EMOJI_LIMITS, PAPO_LIMITS } from './limits.js';

export interface GuildEmojiLike {
	id: string;
	name: string;
	animated?: boolean;
}

/** Resolver de emoji do guild Discord (injetado para não acoplar ao discord.js). */
export interface GuildEmojiResolver {
	findByName(name: string): GuildEmojiLike | undefined;
}

/**
 * Emoji da aplicação (`ApplicationEmojiManager` do discord.js): pertence ao app, não a um
 * guild. Renderiza em qualquer canal e não exige `Use External Emojis`, mas só o app que o
 * criou pode usá-lo — é o fallback quando o guild não tem o nome.
 */
export interface ApplicationEmojiLike {
	id: string;
	name: string;
	animated?: boolean;
}

/**
 * Emojis da aplicação, injetados pelo adaptador Discord: `findByName` lê o cache, `load`
 * o preenche (`GET /applications/{id}/emojis`) e `create` sobe a imagem
 * (`POST /applications/{id}/emojis`).
 */
export interface ApplicationEmojiResolver {
	findByName(name: string): ApplicationEmojiLike | undefined;
	/** Quantos emojis da aplicação estão no cache (o teto é por aplicação). */
	count(): number;
	load(): Promise<unknown>;
	create(name: string, image: Buffer): Promise<ApplicationEmojiLike | undefined>;
}

const EMOJI_NAME_RE = /^[A-Za-z0-9_]{1,32}$/;
/** O Discord exige 2–32 caracteres `[A-Za-z0-9_]`; o Papo aceita nome de 1 caractere. */
const DISCORD_EMOJI_NAME_RE = new RegExp(
	`^[A-Za-z0-9_]{${DISCORD_EMOJI_LIMITS.emojiNameMin},${DISCORD_EMOJI_LIMITS.emojiNameMax}}$`
);

/** Token de emoji custom no dialeto do Discord (`<:nome:id>` / `<a:nome:id>`). */
const discordToken = (emoji: GuildEmojiLike | ApplicationEmojiLike): string =>
	`<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;

export class EmojiBridge {
	private papoIndex?: Map<string, PapoEmoji>;
	/** Importação em voo por nome: mensagens simultâneas não enviam o mesmo emoji duas vezes. */
	private readonly importing = new Map<string, Promise<PapoEmoji | undefined>>();
	/** Carga do índice de emojis da aplicação: uma por run (o cache do discord.js é o índice). */
	private appIndex?: Promise<unknown>;
	/** Criação em voo por nome: duas mensagens com o mesmo emoji novo criam um só emoji. */
	private readonly creating = new Map<string, Promise<ApplicationEmojiLike | undefined>>();
	/**
	 * Cooldown da criação: por nome (nome inválido no Discord, imagem indisponível) e global
	 * (o Discord recusou). Sem isso cada mensagem com o mesmo emoji insistiria na rota de
	 * criação, que o Discord limita por aplicação.
	 */
	private readonly failedAt = new Map<string, number>();
	private failedGloballyAt = 0;
	private static readonly CREATE_RETRY_MS = 30 * 60_000;

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

	/** Nome canônico conhecido pelo mapa persistente, disponível para o tradutor síncrono. */
	papoNameForDiscord(name: string): string | undefined {
		const known = this.store.getEmojiByName(name);
		return known?.papo_emoji_id ? known.name : undefined;
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

	/**
	 * Emoji do Papo → token no Discord: `<:nome:id>` quando o guild tem o nome, senão o
	 * emoji da aplicação com o mesmo nome, senão `:nome:` cru.
	 */
	tokenForDiscord(name: string, guild: GuildEmojiResolver, app?: ApplicationEmojiResolver): string {
		const found = guild.findByName(name);
		if (found) {
			this.store.upsertEmoji({
				name,
				discord_emoji_id: found.id,
				discord_emoji_name: found.name,
				discord_animated: Boolean(found.animated),
				discord_application: false
			});
			return discordToken(found);
		}
		const application = app?.findByName(name);
		if (application) {
			this.store.upsertEmoji({
				name,
				discord_emoji_id: application.id,
				discord_emoji_name: application.name,
				discord_animated: Boolean(application.animated),
				discord_application: true
			});
			return discordToken(application);
		}
		return `:${name}:`;
	}

	/**
	 * Token renderizável para `:nome:` garantindo o equivalente no Discord: emoji do guild →
	 * emoji da aplicação já existente → **emoji da aplicação criado** a partir da imagem do
	 * emoji no Papo. Sem as três o tradutor mantém `:nome:` cru — criar nunca derruba a ponte.
	 */
	async ensureDiscordToken(
		name: string,
		guild: GuildEmojiResolver,
		app?: ApplicationEmojiResolver
	): Promise<string> {
		const direct = this.tokenForDiscord(name, guild, app);
		if (direct.startsWith('<') || !app) return direct;
		const created = await this.applicationEmojiFor(name, app);
		return created ? discordToken(created) : direct;
	}

	/** Criação deduplicada por nome, com cooldown depois de falha. */
	private applicationEmojiFor(name: string, app: ApplicationEmojiResolver): Promise<ApplicationEmojiLike | undefined> {
		const key = name.toLowerCase();
		const inflight = this.creating.get(key);
		if (inflight) return inflight;
		if (this.inCooldown(key)) return Promise.resolve(undefined);
		const task = this.createApplicationEmoji(name, app).finally(() => this.creating.delete(key));
		this.creating.set(key, task);
		return task;
	}

	private inCooldown(key: string): boolean {
		const since = Math.max(this.failedGloballyAt, this.failedAt.get(key) ?? 0);
		return since !== 0 && Date.now() - since < EmojiBridge.CREATE_RETRY_MS;
	}

	/**
	 * Emoji da aplicação correspondente ao nome, criando quando não existe. A imagem vem do
	 * índice do Papo (`GET /emojis` traz `image_blob`): sem ela não há o que subir.
	 */
	private async createApplicationEmoji(name: string, app: ApplicationEmojiResolver): Promise<ApplicationEmojiLike | undefined> {
		const key = name.toLowerCase();
		// nome que o Discord não aceita ou imagem que o bridge não tem: só esse nome entra em
		// cooldown. Recusa do Discord (limite do app, imagem rejeitada) congela a criação por
		// um tempo — a rota é limitada por aplicação, não por mensagem.
		const skip = (): undefined => {
			this.failedAt.set(key, Date.now());
			return undefined;
		};
		const reject = (): undefined => {
			skip();
			this.failedGloballyAt = Date.now();
			return undefined;
		};

		const safeName = name.slice(0, DISCORD_EMOJI_LIMITS.emojiNameMax);
		if (!DISCORD_EMOJI_NAME_RE.test(safeName)) return skip();

		// o cache pode estar vazio (fetch ainda não rodou): tentar antes de criar um duplicado
		await this.ensureAppIndex(app);
		const existing = app.findByName(safeName);
		if (existing) return existing;
		// o teto é por aplicação: sem slot não adianta insistir na rota de criação
		if (app.count() >= DISCORD_EMOJI_LIMITS.applicationEmojiMax) return reject();

		const papo = await this.papoByName(safeName).catch(() => undefined);
		const image = papo?.image_blob ? Buffer.from(papo.image_blob, 'base64') : undefined;
		if (!image?.length || image.length > DISCORD_EMOJI_LIMITS.emojiMaxBytes) return skip();

		let created: ApplicationEmojiLike | undefined;
		try {
			created = await app.create(safeName, image);
		} catch {
			return reject();
		}
		if (!created) return reject();

		this.store.upsertEmoji({
			name: safeName,
			papo_emoji_id: papo?.id ?? null,
			discord_emoji_id: created.id,
			discord_emoji_name: created.name,
			discord_animated: Boolean(created.animated),
			discord_application: true
		});
		return created;
	}

	/** Preenche o cache de emojis da aplicação uma vez; falha permite tentar de novo depois. */
	private async ensureAppIndex(app: ApplicationEmojiResolver): Promise<void> {
		this.appIndex ??= Promise.resolve(app.load()).catch(() => undefined);
		try {
			await this.appIndex;
		} catch {
			this.appIndex = undefined;
		}
	}

	/** Emoji do Discord → shortcode do Papo, importando quando possível. */
	async shortcodeForPapo(name: string, emojiId: string, animated: boolean, guild?: GuildEmojiResolver): Promise<string> {
		const known = this.store.getEmojiByName(name);
		if (known?.papo_emoji_id) {
			this.store.upsertEmoji({
				name: known.name,
				papo_emoji_id: known.papo_emoji_id,
				discord_emoji_id: emojiId,
				discord_emoji_name: name,
				discord_animated: animated
			});
			return `:${known.name}:`;
		}

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

		const key = name.toLowerCase();
		let pending = this.importing.get(key);
		if (!pending) {
			pending = this.importDiscordEmojiToPapo(name, emojiId, animated);
			this.importing.set(key, pending);
		}
		let imported: PapoEmoji | undefined;
		try {
			imported = await pending;
		} finally {
			if (this.importing.get(key) === pending) this.importing.delete(key);
		}
		if (imported) return `:${imported.name}:`;
		void guild;
		return `:${name.slice(0, PAPO_LIMITS.emojiNameMax)}:`;
	}
}
