import {
	Client,
	GatewayIntentBits,
	Partials,
	TextChannel,
	type APIEmbed,
	type APIEmoji,
	type Guild,
	type Message,
	type MessageCreateOptions,
	type MessageMentionTypes,
	type MessageReaction,
	type PartialMessage,
	type PartialMessageReaction,
	type PartialUser,
	type User
} from 'discord.js';
import type { Logger } from 'pino';
import { scoped } from '../logger.js';

export interface DiscordHandlers {
	onMessage?: (message: Message) => void;
	onMessageEdit?: (before: Message | PartialMessage, after: Message | PartialMessage) => void;
	onMessageDelete?: (message: Message | PartialMessage) => void;
	onReactionAdd?: (
		messageId: string,
		channelId: string,
		emojiName: string,
		emojiId: string | null,
		animated: boolean,
		count: number
	) => void;
	onReactionRemove?: (
		messageId: string,
		channelId: string,
		emojiName: string,
		emojiId: string | null,
		count: number
	) => void;
	onPresence?: (guildId: string, userId: string, status: string) => void;
	onReady?: (userId: string) => void;
}

export interface SendOptions {
	embeds?: APIEmbed[];
	content?: string;
	files?: { name: string; buffer: Buffer }[];
	replyTo?: string;
}

/**
 * Montagem do payload de `channel.send`. `reply` é a forma que o discord.js 14 lê
 * (`messageReference` no nível raiz é ignorado pela lib); `allowedMentions: { parse: [] }`
 * é o anti-ping do bridge.
 */
export const buildSendPayload = (
	options: SendOptions
): MessageCreateOptions & { allowedMentions: { parse: readonly MessageMentionTypes[] } } => {
	const payload: MessageCreateOptions & { allowedMentions: { parse: readonly MessageMentionTypes[] } } = {
		allowedMentions: { parse: [] }
	};
	if (options.embeds?.length) payload.embeds = options.embeds;
	if (options.content) payload.content = options.content;
	if (options.files?.length) payload.files = options.files.map((f) => ({ attachment: f.buffer, name: f.name }));
	if (options.replyTo) payload.reply = { messageReference: options.replyTo, failIfNotExists: false };
	return payload;
};

/**
 * Adaptador do Discord (discord.js 14.27).
 *
 * Intents necessários:
 * - `Guilds` — cache de guilds/emojis do guild.
 * - `GuildMessages` + `MessageContent` — mensagens e conteúdo (privilegiado).
 * - `GuildMessageReactions` — sem ele `messageReactionAdd/Remove` nunca disparam.
 * - `GuildPresences` — opcional, só para `/online`.
 */
export class DiscordBridge {
	readonly client: Client;
	private readonly log: Logger;
	/**
	 * IDs de emoji do guild que o Discord marca como `available: false`. O gateway mantém
	 * esses emojis no cache, mas reação com eles responde 10014 Unknown Emoji — o discord.js
	 * não expõe a flag, então ela é lida da rota REST de emojis do guild.
	 */
	private unavailableEmojis = new Map<string, Set<string>>();

	constructor(
		private opts: { token: string; handlers: DiscordHandlers; logger?: Logger; presences?: boolean },
	) {
		this.log = opts.logger ?? scoped('discord');
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildMessageReactions,
				GatewayIntentBits.MessageContent,
				...(opts.presences ? [GatewayIntentBits.GuildPresences] : [])
			],
			partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User]
		});

		// `ready` foi deprecado em favor de `clientReady` (discord.js 14.16+)
		this.client.on('clientReady', () => {
			this.log.info({ tag: this.client.user?.tag }, 'Discord conectado');
			const id = this.client.user?.id;
			if (id) opts.handlers.onReady?.(id);
		});
		this.client.on('error', (err) => this.log.error({ err }, 'erro do gateway'));
		this.client.on('shardError', (err) => this.log.error({ err }, 'erro de shard'));

		this.client.on('messageCreate', (m) => opts.handlers.onMessage?.(m));
		this.client.on('messageUpdate', (b, a) => opts.handlers.onMessageEdit?.(b, a));
		this.client.on('messageDelete', (m) => opts.handlers.onMessageDelete?.(m));
		this.client.on('messageReactionAdd', (reaction, user) => void this.handleReaction(reaction, user, true));
		this.client.on('messageReactionRemove', (reaction, user) => void this.handleReaction(reaction, user, false));
		this.client.on('presenceUpdate', (_old, newPresence) => {
			if (!newPresence.userId || newPresence.userId === this.client.user?.id) return;
			opts.handlers.onPresence?.(newPresence.guild?.id ?? '', newPresence.userId, newPresence.status ?? 'offline');
		});
	}

	private async handleReaction(
		reaction: MessageReaction | PartialMessageReaction,
		user: User | PartialUser,
		add: boolean
	): Promise<void> {
		if (user.id === this.client.user?.id) return;
		try {
			const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
			const name = reaction.emoji.name ?? reaction.emoji.id ?? '';
			const id = reaction.emoji.id ?? null;
			const count = this.reactionCount(message, reaction);
			if (add) this.opts.handlers.onReactionAdd?.(message.id, message.channelId, name, id, Boolean(reaction.emoji.animated), count);
			else this.opts.handlers.onReactionRemove?.(message.id, message.channelId, name, id, count);
		} catch (err) {
			this.log.error({ err }, 'evento de reação descartado (mensagem inacessível)');
		}
	}

	/** Contagem atual do emoji na mensagem (fallback quando a mensagem chegou parcial). */
	private reactionCount(message: Message | PartialMessage, reaction: MessageReaction | PartialMessageReaction): number {
		const key = reaction.emoji.id ?? reaction.emoji.name ?? '';
		return message.reactions.cache.get(key)?.count ?? reaction.count ?? 0;
	}

	login(): Promise<string> {
		return this.client.login(this.opts.token);
	}

	async destroy(): Promise<void> {
		await this.client.destroy();
	}

	get selfId(): string | undefined {
		return this.client.user?.id;
	}

	get firstGuild(): Guild | undefined {
		return this.client.guilds.cache.first();
	}

	isSelf(userId?: string | null): boolean {
		return Boolean(userId) && userId === this.client.user?.id;
	}

	/**
	 * Canal de texto utilizável. `channels.fetch` pode devolver `PartialGroupDMChannel`,
	 * que não tem `messages` nem `send` — usar direto estoura em TypeError.
	 */
	private async textChannel(channelId: string): Promise<TextChannel | null> {
		const channel = await this.client.channels.fetch(channelId).catch(() => null);
		return channel instanceof TextChannel ? channel : null;
	}

	async send(channelId: string, options: SendOptions): Promise<Message> {
		const channel = await this.textChannel(channelId);
		if (!channel) throw new Error(`canal ${channelId} não aceita envio`);
		return channel.send(buildSendPayload(options));
	}

	async fetchMessage(channelId: string, messageId: string): Promise<Message | undefined> {
		const channel = await this.textChannel(channelId);
		if (!channel) return undefined;
		return channel.messages.fetch(messageId).catch(() => undefined);
	}

	async edit(
		channelId: string,
		messageId: string,
		options: { content?: string; embeds?: APIEmbed[]; files?: { name: string; buffer: Buffer }[] }
	): Promise<void> {
		const message = await this.fetchMessage(channelId, messageId);
		if (!message) return;
		await message.edit({
			...(options.content !== undefined ? { content: options.content } : {}),
			...(options.embeds ? { embeds: options.embeds } : {}),
			// embed que referencia `attachment://` precisa do arquivo reenviado no edit
			...(options.files?.length ? { files: options.files.map((f) => ({ attachment: f.buffer, name: f.name })) } : {})
		});
	}

	async delete(channelId: string, messageId: string): Promise<void> {
		const message = await this.fetchMessage(channelId, messageId);
		if (!message) return;
		await message.delete();
	}

	async react(channelId: string, messageId: string, emoji: string): Promise<void> {
		const message = await this.fetchMessage(channelId, messageId);
		if (!message) return;
		await message.react(emoji);
	}

	/** Remove a reação da própria conta do bot (`<:nome:id>` ou unicode). */
	async unreact(channelId: string, messageId: string, emoji: string): Promise<void> {
		const message = await this.fetchMessage(channelId, messageId);
		if (!message) return;
		// a chave do cache é o id (custom) ou o nome (unicode); o token completo precisa de match manual
		const reaction =
			message.reactions.cache.find((r) => r.emoji.toString() === emoji || r.emoji.name === emoji) ??
			message.reactions.resolve(emoji);
		if (!reaction) return;
		await reaction.remove();
	}

	async setPin(channelId: string, messageId: string, pinned: boolean): Promise<void> {
		const message = await this.fetchMessage(channelId, messageId);
		if (!message) return;
		if (pinned) await message.pin();
		else await message.unpin();
	}

	async username(userId: string): Promise<string | undefined> {
		const user = await this.client.users.fetch(userId).catch(() => undefined);
		return user?.username;
	}

	/** `false` quando o cache de guilds ainda não foi povoado (reconexão, guild indisponível). */
	guildsCached(): boolean {
		return this.client.guilds.cache.size > 0;
	}

	/** Emoji do guild por nome (usado na conversão Papo → Discord), ignorando os indisponíveis. */
	findGuildEmoji(name: string): { id: string; name: string; animated: boolean } | undefined {
		for (const guild of this.client.guilds.cache.values()) {
			const blocked = this.unavailableEmojis.get(guild.id);
			const emoji = guild.emojis.cache.find((e) => e.name === name && !(blocked?.has(e.id) ?? false));
			if (emoji) return { id: emoji.id, name: emoji.name ?? name, animated: Boolean(emoji.animated) };
		}
		return undefined;
	}

	/**
	 * Recarrega de cada guild acessível a lista de emojis indisponíveis (apagados por
	 * moderação pelo Discord). Retorna quantos emojis foram bloqueados.
	 */
	async loadUnavailableEmojis(): Promise<number> {
		let total = 0;
		for (const guild of this.client.guilds.cache.values()) {
			try {
				const list = (await this.client.rest.get(`/guilds/${guild.id}/emojis`)) as APIEmoji[];
				const ids = new Set<string>();
				for (const e of list) if (e.available === false && e.id) ids.add(e.id);
				this.unavailableEmojis.set(guild.id, ids);
				total += ids.size;
			} catch (err) {
				this.unavailableEmojis.delete(guild.id);
				this.log.debug({ err, guildId: guild.id }, 'lista de emojis indisponíveis não carregada');
			}
		}
		return total;
	}

	channelName(channelId: string): string | undefined {
		const channel = this.client.channels.cache.get(channelId);
		return channel && 'name' in channel ? String(channel.name) : undefined;
	}
}
