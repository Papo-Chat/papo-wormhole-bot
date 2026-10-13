import {
	Client,
	GatewayIntentBits,
	Partials,
	TextChannel,
	Webhook,
	AttachmentBuilder,
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
import type { Store } from '../db/store.js';

/**
 * Nome do webhook de um usuário Papo (item 27): `nickname (@username)`, ou só o
 * username quando o apelido é o próprio nome. O sufixo com o username torna o nome
 * único e reaproveitável entre runs — apelidos iguais entre usuários colidiriam.
 */
export function bridgeWebhookName(displayName: string, username: string): string {
	const base = displayName.trim() || username;
	if (base === username) return username;
	// o sufixo `(@username)` precisa sobreviver ao limite de 80: o apelido cede espaço
	return `${base.slice(0, 76 - username.length)} (@${username})`.slice(0, 80);
}

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
 * - `GuildMembers` — cache de membros para resolver `@nome` do Papo no guild (item 28).
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
	/**
	 * Webhooks do bridge (item 27): um por usuário Papo por canal, com a identidade
	 * (nome + avatar) fixa no webhook — o Discord agrupa mensagens consecutivas quando
	 * autor e username batem, e para webhook o autor é o webhook. Cache dos objetos
	 * `Webhook`; a posse persistente fica na tabela `bridge_webhooks`.
	 */
	private webhooks = new Map<string, Webhook>();
	private webhookById = new Map<string, Webhook>();
	/** Falha de criação por canal (limite de webhooks, sem Manage Webhooks): re-tenta após o TTL. */
	private webhookFailedAt = new Map<string, number>();
	private static readonly WEBHOOK_RETRY_MS = 10 * 60_000;
	/** Índice de membros por nome (item 28), recarregado com TTL. */
	private memberIndex?: { at: number; byUsername: Map<string, string>; byNickname: Map<string, string | null> };
	private static readonly MEMBER_INDEX_TTL_MS = 10 * 60_000;

	constructor(
		private opts: {
			token: string;
			handlers: DiscordHandlers;
			logger?: Logger;
			presences?: boolean;
			store?: Store;
		},
	) {
		this.log = opts.logger ?? scoped('discord');
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMembers,
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

	/**
	 * Webhook do canal para o usuário Papo (item 27). Criado na primeira necessidade,
	 * reaproveitado entre runs pela linha em `bridge_webhooks` (ou pelo nome, para
	 * webhooks anteriores à tabela). Nome e avatar ficam no webhook — não por mensagem
	 * — porque o Discord agrupa mensagens consecutivas quando autor e username batem:
	 * as cópias do mesmo usuário agrupam como um usuário comum.
	 * `null` quando o canal não aceita envio ou a criação falha (limite de webhooks do
	 * canal, sem Manage Webhooks) — o envio continua pelo cartão do bot.
	 */
	async userWebhook(
		channelId: string,
		identity: { userId: string; displayName: string; username: string; avatarSha?: string; avatarBuffer?: Buffer }
	): Promise<Webhook | null> {
		const key = `${channelId}:${identity.userId}`;
		const name = bridgeWebhookName(identity.displayName, identity.username);
		const cached = this.webhooks.get(key);
		if (cached) {
			await this.applyWebhookIdentity(cached, name, identity);
			return cached;
		}
		const failedAt = this.webhookFailedAt.get(channelId);
		if (failedAt && Date.now() - failedAt < DiscordBridge.WEBHOOK_RETRY_MS) return null;
		const channel = await this.textChannel(channelId);
		if (!channel) return null;
		try {
			const row = this.opts.store?.getBridgeWebhookByUser(channelId, identity.userId);
			const hooks = await channel.fetchWebhooks();
			let webhook = row ? hooks.find((w) => w.id === row.webhook_id) : undefined;
			if (!webhook) webhook = hooks.find((w) => w.name === name);
			if (!webhook) {
				try {
					webhook = await channel.createWebhook({
						name,
						...(identity.avatarBuffer ? { avatar: identity.avatarBuffer } : {}),
						reason: 'papo bridge'
					});
				} catch (err) {
					// limite de webhooks do canal ou sem Manage Webhooks: re-tenta após o TTL
					this.webhookFailedAt.set(channelId, Date.now());
					this.log.debug({ err, channelId }, 'webhook do usuário indisponível: envio pelo cartão do bot');
					return null;
				}
			}
			this.webhooks.set(key, webhook);
			this.webhookById.set(webhook.id, webhook);
			await this.applyWebhookIdentity(webhook, name, identity);
			return webhook;
		} catch (err) {
			this.log.debug({ err, channelId }, 'falha ao resolver o webhook do usuário');
			return null;
		}
	}

	/**
	 * Mantém nome/avatar do webhook sincronizados com a identidade Papo (apelido ou
	 * avatar mudados editam o webhook) e registra a posse em `bridge_webhooks`.
	 */
	private async applyWebhookIdentity(
		webhook: Webhook,
		name: string,
		identity: { userId: string; avatarSha?: string; avatarBuffer?: Buffer }
	): Promise<void> {
		const row = this.opts.store?.getBridgeWebhookById(webhook.id);
		const avatarChanged = identity.avatarBuffer !== undefined && (row?.avatar_sha ?? undefined) !== identity.avatarSha;
		let appliedSha = row?.avatar_sha ?? null;
		if (webhook.name !== name || avatarChanged) {
			try {
				await webhook.edit({
					name,
					...(avatarChanged && identity.avatarBuffer ? { avatar: identity.avatarBuffer } : {})
				});
				// o sha novo só é registrado como aplicado se o upload do avatar funcionou
				if (avatarChanged) appliedSha = identity.avatarSha ?? null;
			} catch (err) {
				this.log.debug({ err, webhookId: webhook.id }, 'falha ao atualizar a identidade do webhook');
			}
		}
		this.opts.store?.upsertBridgeWebhook({
			webhook_id: webhook.id,
			channel_id: webhook.channelId,
			papo_user_id: identity.userId,
			name,
			avatar_sha: appliedSha
		});
	}

	/** Objeto `Webhook` (token) de um webhook nosso; busca no canal quando ainda não conhecido. */
	private async webhookObject(channelId: string, webhookId: string): Promise<Webhook | null> {
		const hit = this.webhookById.get(webhookId);
		if (hit) return hit;
		const channel = await this.textChannel(channelId);
		if (!channel) return null;
		const hooks = await channel.fetchWebhooks().catch(() => null);
		const webhook = hooks?.find((w) => w.id === webhookId) ?? null;
		if (webhook) this.webhookById.set(webhook.id, webhook);
		return webhook;
	}

	/**
	 * O webhook observado é do bridge? A linha em `bridge_webhooks` é o registro de
	 * posse: sem chute por nome, webhook de terceiros nunca é tratado como eco.
	 */
	async isBridgeWebhook(channelId: string, webhookId: string): Promise<boolean> {
		if (this.webhookById.has(webhookId)) return true;
		const row = this.opts.store?.getBridgeWebhookById(webhookId);
		if (!row || row.channel_id !== channelId) return false;
		await this.webhookObject(channelId, webhookId);
		return true;
	}

	/**
	 * Mensagem criada pelo bridge: pelo bot ou pelo webhook do bridge. Mensagem de webhook
	 * não tem autor válido (o autor é o webhook) — o identificador é o `webhook_id`.
	 */
	async isSelfMessage(message: Message | PartialMessage): Promise<boolean> {
		if (this.isSelf(message.author?.id)) return true;
		const webhookId = message.webhookId;
		if (!webhookId) return false;
		return this.isBridgeWebhook(message.channelId, webhookId);
	}

	/**
	 * Envio pelo webhook do usuário: a identidade já está no webhook, então a mensagem
	 * sai sem override de nick/avatar e agrupa como usuário comum. Cartão e previews vão
	 * como embeds na mesma call. `null` quando não há webhook para o par (canal, usuário)
	 * — o chamador cai para o envio normal. Webhook não responde a mensagens, então a
	 * thread de reply/continuação se perde nesse caminho (limitação do Discord).
	 */
	async sendAsWebhook(
		channelId: string,
		userId: string,
		options: {
			content?: string;
			embeds?: APIEmbed[];
			files?: { name: string; buffer: Buffer }[];
		}
	): Promise<Message | null> {
		const key = `${channelId}:${userId}`;
		const webhook = this.webhooks.get(key);
		if (!webhook) return null;
		try {
			return await webhook.send({
				...(options.content ? { content: options.content } : {}),
				...(options.embeds?.length ? { embeds: options.embeds } : {}),
				...(options.files?.length ? { files: options.files.map((f) => new AttachmentBuilder(f.buffer, { name: f.name })) } : {}),
				allowedMentions: { parse: [] }
			});
		} catch (err) {
			// webhook morto (apagado por fora, sem permissão): nada foi entregue — descarta
			// o cache e o chamador cai para o cartão do bot; a próxima mensagem recria.
			// Falha incerta (5xx/timeout) é re-lançada: o job re-tenta e a reconciliação
			// de envio incerto evita duplicar.
			this.webhooks.delete(key);
			this.webhookById.delete(webhook.id);
			const status = (err as { status?: number })?.status;
			if (status === 401 || status === 403 || status === 404) {
				this.log.debug({ err, channelId, webhookId: webhook.id }, 'webhook do usuário indisponível no envio');
				return null;
			}
			throw err;
		}
	}

	async fetchMessage(channelId: string, messageId: string): Promise<Message | undefined> {
		const channel = await this.textChannel(channelId);
		if (!channel) return undefined;
		return channel.messages.fetch(messageId).catch(() => undefined);
	}

	/**
	 * Mensagens recentes de um autor no canal, com os rodapés dos embeds. É a base da
	 * reconciliação de envios cujo resultado é incerto: o bridge reconhece a cópia que já
	 * criou pelo rodapé determinístico que escreve nela.
	 */
	async recentByAuthor(
		channelId: string,
		authorId: string,
		limit = 50
	): Promise<{ id: string; createdAt: number; footers: string[]; content: string; files: string[] }[]> {
		const channel = await this.textChannel(channelId);
		if (!channel) return [];
		const messages = await channel.messages.fetch({ limit: Math.min(100, Math.max(1, limit)) }).catch(() => null);
		if (!messages) return [];
		// cópias enviadas pelo webhook do bridge têm author = webhook (não o bot): a
		// reconciliação também precisa enxergá-las
		const webhookIds = new Set(this.opts.store?.listBridgeWebhookIds(channelId) ?? []);
		return messages
			.filter((m) => m.author.id === authorId || (m.webhookId !== null && webhookIds.has(m.webhookId)))
			.map((m) => ({
				id: m.id,
				createdAt: m.createdTimestamp,
				footers: m.embeds.map((e) => e.footer?.text ?? ''),
				// cópia de webhook não tem cartão: o reconhecimento é pelo `content` e pelos
				// nomes de anexo
				content: m.content,
				files: m.attachments.map((a) => a.name ?? '')
			}));
	}

	async edit(
		channelId: string,
		messageId: string,
		options: { content?: string; embeds?: APIEmbed[]; files?: { name: string; buffer: Buffer }[] }
	): Promise<void> {
		const message = await this.fetchMessage(channelId, messageId);
		if (!message) return;
		const files = options.files ?? [];
		// `files`/`attachments` reescrevem a lista de anexos da mensagem: o Discord apaga tudo
		// que não for redeclarado. Mandar só o avatar do embed derrubava a imagem que a
		// mensagem tinha.
		const resending = new Set(files.map((f) => f.name));
		const keep = message.attachments.filter((a) => !resending.has(a.name)).map((a) => ({ id: a.id }));
		const payload = {
			...(options.content !== undefined ? { content: options.content } : {}),
			...(options.embeds ? { embeds: options.embeds } : {}),
			// embed que referencia `attachment://` precisa do arquivo reenviado no edit
			...(files.length ? { files: files.map((f) => ({ attachment: f.buffer, name: f.name })) } : {}),
			...(keep.length ? { attachments: keep } : {})
		};
		// mensagem de webhook não pode ser editada pela API de mensagem (50005): o edit
		// precisa do token do webhook. Só cópias mapeadas chegam aqui, e o Discord só
		// aceita o edit quando o token é do webhook que enviou a mensagem.
		const webhookId = message.webhookId;
		if (webhookId) {
			const webhook = await this.webhookObject(channelId, webhookId);
			if (webhook) {
				await webhook.editMessage(messageId, payload);
				return;
			}
		}
		await message.edit(payload);
	}

	async delete(channelId: string, messageId: string): Promise<void> {
		const message = await this.fetchMessage(channelId, messageId);
		if (!message) return;
		// mensagem de webhook não pode ser apagada pela API de mensagem (50005)
		const webhookId = message.webhookId;
		if (webhookId) {
			const webhook = await this.webhookObject(channelId, webhookId);
			if (webhook) {
				await webhook.deleteMessage(messageId);
				return;
			}
		}
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

	/**
	 * Índice de membros do guild por username/nickname (resolução de `@nome`, item 28).
	 * Casamento exato, sem caixa. Nickname dividido por mais de um membro é ambíguo
	 * (`null`) e não resolve — link errado é pior que link nenhum. Username é único.
	 */
	async ensureMemberIndex(): Promise<void> {
		if (this.memberIndex && Date.now() - this.memberIndex.at < DiscordBridge.MEMBER_INDEX_TTL_MS) return;
		const guild = this.firstGuild;
		if (!guild) return;
		try {
			const members = await guild.members.fetch();
			const byUsername = new Map<string, string>();
			const byNickname = new Map<string, string | null>();
			for (const member of members.values()) {
				const username = member.user.username.toLowerCase();
				if (username) byUsername.set(username, member.id);
				const nickname = member.nickname?.toLowerCase();
				if (!nickname) continue;
				if (byNickname.get(nickname) === null) continue; // já ambíguo
				if (byNickname.has(nickname)) {
					byNickname.set(nickname, null);
					continue;
				}
				byNickname.set(nickname, member.id);
			}
			this.memberIndex = { at: Date.now(), byUsername, byNickname };
		} catch (err) {
			this.log.debug({ err }, 'falha ao carregar o índice de membros do guild');
		}
	}

	/** Membro por username/nickname; username tem prioridade. `undefined` sem match único. */
	memberByName(name: string): { id: string } | undefined {
		const wanted = name.trim().toLowerCase();
		if (!wanted) return undefined;
		const byUsername = this.memberIndex?.byUsername.get(wanted);
		if (byUsername) return { id: byUsername };
		const byNickname = this.memberIndex?.byNickname.get(wanted);
		if (byNickname) return { id: byNickname };
		return undefined;
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

	/**
	 * Nome da role do guild (`GUILD_CREATE` traz a lista inteira — não exige o intent
	 * `GuildMembers`). Menção de role não tem equivalente no Papo: vira texto.
	 */
	roleName(roleId: string): string | undefined {
		for (const guild of this.client.guilds.cache.values()) {
			const name = guild.roles.cache.get(roleId)?.name;
			if (name) return name;
		}
		return undefined;
	}
}
