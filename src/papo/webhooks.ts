import type { Logger } from 'pino';
import type { OutAttachment, PapoApi } from './api.js';
import { PapoApiError, type PapoEmbedInput, type PapoMessage } from './types.js';
import type { Store } from '../db/store.js';
import { bridgeWebhookName } from '../bridge/identity.js';
import { clampText } from '../bridge/limits.js';

/** Limite de `name` em POST /webhooks (80) e de `display_name` (100). */
const NAME_MAX = 80;
const DISPLAY_NAME_MAX = 100;

/**
 * Identidade fixada no webhook (não por mensagem): nickname + avatar. É o espelho do
 * webhook por usuário do Discord — as cópias do mesmo autor saem com a mesma cara.
 */
export interface PapoWebhookIdentity {
	/** Autor Discord (o webhook é por usuário Discord, por canal Papo). */
	userId: string;
	displayName: string;
	username: string;
	avatarSha?: string;
	avatarBuffer?: Buffer;
	/** Formato declarado no upload (`PNG`, `JPEG`, `WEBP`, `GIF`). */
	avatarFormat?: string;
}

/** Credencial de um webhook já resolvido. */
export interface PapoWebhookRef {
	webhookId: string;
	token: string;
}

export interface PapoWebhookSend {
	content?: string;
	embeds?: PapoEmbedInput[];
	attachments?: OutAttachment[];
	replyTo?: string;
	/** Chave de idempotência: retry do mesmo envio não duplica a cópia. */
	externalMessageId?: string;
}

/**
 * Pool de webhooks do bridge no Papo — o espelho do modo webhook do Discord.
 *
 * Cada usuário Discord tem um webhook próprio por canal Papo, com nickname e avatar fixos
 * no webhook. O envio sai pelo token do webhook, então a cópia é uma mensagem comum do
 * Papo: `content` = texto, embeds = só previews. O preço é que a cópia passa a pertencer
 * ao webhook — editar/apagar exige o token (o JWT do bot não pode mexer em mensagem de
 * webhook), e é por isso que o token fica em `papo_webhooks`: o backend o mostra uma única
 * vez, na criação.
 *
 * Sem `manage_webhooks` no usuário do bot a criação falha e o envio continua pelo cartão.
 */
export class PapoWebhooks {
	/** `${canalPapo}:${usuárioDiscord}` → credencial resolvida neste processo. */
	private readonly webhooks = new Map<string, PapoWebhookRef>();
	/** Canal onde a criação falhou (sem permissão): re-tenta depois do TTL. */
	private readonly failedAt = new Map<string, number>();
	private static readonly CREATE_RETRY_MS = 10 * 60_000;

	constructor(
		private readonly api: PapoApi,
		private readonly store: Store,
		private readonly log: Logger
	) {}

	/**
	 * Webhook do usuário Discord no canal Papo. Reaproveitado entre runs pela linha em
	 * `papo_webhooks` (o token não é recuperável: sem a linha, o webhook é recriado).
	 * `null` quando não há webhook possível — o chamador cai no envio pelo cartão do bot.
	 */
	async userWebhook(channelId: string, identity: PapoWebhookIdentity): Promise<PapoWebhookRef | null> {
		const name = bridgeWebhookName(identity.displayName, identity.username);
		const key = `${channelId}:${identity.userId}`;
		const cached = this.webhooks.get(key);
		if (cached) {
			await this.applyIdentity(cached, name, identity);
			return cached;
		}
		const failedAt = this.failedAt.get(channelId);
		if (failedAt && Date.now() - failedAt < PapoWebhooks.CREATE_RETRY_MS) return null;

		const row = this.store.getPapoWebhookByUser(channelId, identity.userId);
		const ref = row ? { webhookId: row.webhook_id, token: row.token } : await this.create(channelId, name, identity);
		if (!ref) {
			this.failedAt.set(channelId, Date.now());
			return null;
		}
		this.failedAt.delete(channelId);
		this.webhooks.set(key, ref);
		await this.applyIdentity(ref, name, identity);
		return ref;
	}

	/** Cria o webhook e guarda a credencial. `null` quando o Papo recusa (sem `manage_webhooks`). */
	private async create(
		channelId: string,
		name: string,
		identity: PapoWebhookIdentity
	): Promise<PapoWebhookRef | null> {
		try {
			const webhook = await this.api.createWebhook(channelId, name);
			if (!webhook?.id || !webhook.token) {
				this.log.warn({ channelId }, 'POST /webhooks sem token na resposta: envio pelo cartão do bot');
				return null;
			}
			this.store.upsertPapoWebhook({
				webhook_id: webhook.id,
				channel_id: channelId,
				discord_user_id: identity.userId,
				name,
				display_name: null,
				avatar_sha: null,
				token: webhook.token
			});
			this.log.info({ channelId, webhookId: webhook.id, name }, 'webhook do bridge criado no Papo');
			return { webhookId: webhook.id, token: webhook.token };
		} catch (err) {
			const status = err instanceof PapoApiError ? err.status : undefined;
			if (status === 403 || status === 400 || status === 404) {
				this.log.debug({ err, channelId }, 'webhook indisponível no Papo: envio pelo cartão do bot');
				return null;
			}
			this.log.debug({ err, channelId }, 'falha ao criar o webhook do bridge no Papo');
			return null;
		}
	}

	/**
	 * Mantém nickname/avatar do webhook sincronizados com a identidade Discord e regrava a
	 * linha aplicada. Falha de identidade não derruba o envio: o webhook continua com a
	 * identidade antiga.
	 */
	private async applyIdentity(ref: PapoWebhookRef, name: string, identity: PapoWebhookIdentity): Promise<void> {
		const row = this.store.getPapoWebhookById(ref.webhookId);
		if (!row) return;
		const displayName = clampText(identity.displayName.trim() || identity.username, DISPLAY_NAME_MAX);
		const nameChanged = row.name !== name || row.display_name !== displayName;
		const avatarChanged = identity.avatarBuffer !== undefined && (row.avatar_sha ?? undefined) !== identity.avatarSha;
		if (!nameChanged && !avatarChanged) return;

		try {
			await this.api.updateWebhookIdentity(ref.webhookId, {
				...(nameChanged ? { displayName } : {}),
				...(avatarChanged && identity.avatarBuffer
					? { avatarBase64: identity.avatarBuffer.toString('base64'), avatarFormat: identity.avatarFormat ?? 'PNG' }
					: {})
			});
			this.store.upsertPapoWebhook({
				webhook_id: ref.webhookId,
				channel_id: row.channel_id,
				discord_user_id: row.discord_user_id,
				name: nameChanged ? name : row.name,
				display_name: nameChanged ? displayName : row.display_name,
				// o sha só é registrado como aplicado quando o upload do avatar funcionou
				avatar_sha: avatarChanged ? identity.avatarSha ?? null : row.avatar_sha,
				token: ref.token
			});
		} catch (err) {
			this.log.debug({ err, webhookId: ref.webhookId }, 'falha ao atualizar a identidade do webhook no Papo');
		}
	}

	/** Credencial de um webhook conhecido pelo id (a cópia salva em `message_map` guarda o id). */
	refFor(webhookId?: string | null): PapoWebhookRef | null {
		if (!webhookId) return null;
		for (const ref of this.webhooks.values()) if (ref.webhookId === webhookId) return ref;
		const row = this.store.getPapoWebhookById(webhookId);
		if (!row) return null;
		const ref = { webhookId: row.webhook_id, token: row.token };
		this.webhooks.set(`${row.channel_id}:${row.discord_user_id}`, ref);
		return ref;
	}

	/**
	 * O webhook observado é do bridge? A linha em `papo_webhooks` é o registro de posse:
	 * sem chute por nome, webhook de terceiro nunca é tratado como eco.
	 */
	owns(webhookId?: string | null): boolean {
		if (!webhookId) return false;
		for (const ref of this.webhooks.values()) if (ref.webhookId === webhookId) return true;
		return this.store.getPapoWebhookById(webhookId) !== undefined;
	}

	/**
	 * Envia pelo webhook. `null` quando a credencial morreu (token revogado, webhook apagado
	 * por fora): nada foi entregue — a linha é descartada e o chamador cai no cartão do bot;
	 * a próxima mensagem recria o webhook. Falha incerta (5xx/timeout/429) é re-lançada: o
	 * job re-tenta e a chave de idempotência evita duplicar.
	 */
	async send(ref: PapoWebhookRef, channelId: string, options: PapoWebhookSend): Promise<PapoMessage | null> {
		try {
			return await this.api.sendWebhookMessage({
				webhookId: ref.webhookId,
				token: ref.token,
				...(options.content ? { content: options.content } : {}),
				...(options.replyTo ? { replyTo: options.replyTo } : {}),
				...(options.externalMessageId ? { externalMessageId: options.externalMessageId } : {}),
				...(options.attachments?.length ? { attachments: options.attachments } : {}),
				...(options.embeds?.length ? { embeds: options.embeds } : {})
			});
		} catch (err) {
			if (this.dropIfDead(ref, err, 'envio')) return null;
			throw err;
		}
	}

	/**
	 * Edita mensagem que o webhook enviou. `false` quando a credencial morreu ou o webhook
	 * não é mais conhecido: a cópia existe, mas não tem como o bridge mexer nela.
	 */
	async edit(ref: PapoWebhookRef, messageId: string, content: string, embeds?: PapoEmbedInput[]): Promise<boolean> {
		try {
			await this.api.editWebhookMessage(ref.webhookId, ref.token, messageId, content, embeds);
			return true;
		} catch (err) {
			if (this.dropIfDead(ref, err, 'edição')) return false;
			throw err;
		}
	}

	/** Apaga mensagem que o webhook enviou. `false` quando a credencial morreu. */
	async delete(ref: PapoWebhookRef, messageId: string): Promise<boolean> {
		try {
			await this.api.deleteWebhookMessage(ref.webhookId, ref.token, messageId);
			return true;
		} catch (err) {
			if (this.dropIfDead(ref, err, 'exclusão')) return false;
			throw err;
		}
	}

	/**
	 * 401 é a credencial que morreu (token errado ou webhook revogado). 403 nas rotas de
	 * mensagem de webhook é o backend dizendo que o webhook não está mais ativo. Nos dois
	 * casos o webhook é descartado; 404 é outra coisa (mensagem/canal que sumiu) e fica com
	 * quem chamou.
	 */
	private dropIfDead(ref: PapoWebhookRef, err: unknown, what: string): boolean {
		const status = err instanceof PapoApiError ? err.status : (err as { status?: number })?.status;
		if (status !== 401 && status !== 403) return false;
		for (const [key, value] of this.webhooks) if (value.webhookId === ref.webhookId) this.webhooks.delete(key);
		this.store.deletePapoWebhook(ref.webhookId);
		this.log.debug({ err, webhookId: ref.webhookId, what }, 'webhook do bridge indisponível no Papo');
		return true;
	}

	/**
	 * Reconciliação de boot: `GET /webhooks` lista os webhooks ativos, mas o token não é
	 * recuperável. Uma linha com credencial morta (webhook revogado ou apagado por fora) faria
	 * cada cópia pagar um 401 antes de cair no cartão do bot — descartá-la aqui devolve o canal
	 * ao modo webhook já na primeira mensagem.
	 *
	 * `undefined` quando a listagem falhou: sem `manage_webhooks`, ou sem backend, ausência de
	 * permissão não é evidência de webhook morto e nenhuma linha é tocada.
	 */
	async reconcile(): Promise<{ webhooks: number; dropped: number } | undefined> {
		const hooks = await this.api.listWebhooks().catch(() => undefined);
		if (!hooks) return undefined;
		const alive = new Set(hooks.map((h) => h.id));
		let dropped = 0;
		for (const row of this.store.listPapoWebhooks()) {
			if (alive.has(row.webhook_id)) continue;
			this.store.deletePapoWebhook(row.webhook_id);
			for (const [key, ref] of this.webhooks) if (ref.webhookId === row.webhook_id) this.webhooks.delete(key);
			dropped++;
		}
		return { webhooks: hooks.length, dropped };
	}

	/** Nome que o bridge dá ao webhook de um autor (limite de 80 do backend). */
	static webhookName(displayName: string, username: string): string {
		return clampText(bridgeWebhookName(displayName, username), NAME_MAX);
	}
}
