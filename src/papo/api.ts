import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
	PapoChannel,
	PapoServer,
	PapoEmbed,
	PapoEmoji,
	PapoEmbedInput,
	PapoMessage,
	PapoMessageList,
	PapoProblem,
	PapoUserProfile,
	PapoUserSummary,
	PapoWhoami
} from './types.js';
import { PapoApiError } from './types.js';

export interface PapoApiOptions {
	baseUrl: string;
    webhooks?: Record<string,{id:string;token:string}>;
	username: string;
	password: string;
	/**
	 * Senha de acesso ao servidor (`POST /auth/login_server`). Obrigatória quando o
	 * servidor é privado (`GET /server` → `public: false`): o backend recusa
	 * `POST /auth/login` com 401 `server-access-required` enquanto o cookie `Auth`
	 * não carregar o token temporário (30 min) emitido por aquela rota.
	 */
	serverPassword?: string;
	logger?: Logger;
	/** Timeout de cada requisição (ms). */
	timeoutMs?: number;
	/**
	 * Teto de requisições por segundo. O backend aplica um rate limit global por IP
	 * (`RATE_LIMIT=10`, `RATE_BURST=20` por padrão) a **todas** as rotas — inclusive o
	 * handshake do `GET /ws`. O bridge fica abaixo disso para não provocar 429.
	 */
	rateLimitRps?: number;
	rateBurst?: number;
}

export interface OutAttachment {
	name: string;
	data: Buffer;
	mime?: string;
}

export interface SendMessageInput {
    /** Trusted integration attribution; never an authenticated Papo user id. */
    externalAuthor?: import('./types.js').PapoExternalAuthor;
    externalMessageId?: string;
	channelId: string;
	content?: string | null;
	replyTo?: string | null;
	attachments?: OutAttachment[];
	embeds?: PapoEmbedInput[];
}

export interface ListMessagesQuery {
	since?: string;
	lastId?: string;
	order?: 'asc' | 'desc';
}

/**
 * Token bucket do lado do cliente. O limite do Papo é por IP e global (todas as rotas),
 * então um único bucket compartilhado por todo o bridge é a forma correta de respeitá-lo.
 */
class Throttle {
	private tokens: number;
	private last = Date.now();

	constructor(
		private readonly rps: number,
		private readonly burst: number
	) {
		this.tokens = burst;
	}

	async acquire(): Promise<void> {
		if (this.rps <= 0) return;
		for (;;) {
			const now = Date.now();
			this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rps);
			this.last = now;
			if (this.tokens >= 1) {
				this.tokens -= 1;
				return;
			}
			await new Promise((r) => setTimeout(r, Math.ceil(((1 - this.tokens) / this.rps) * 1000)));
		}
	}
}

/**
 * `type` do problem emitido pelo gate de servidor privado. O backend escreve a URL
 * completa (`https://host/errors/server-access-required`), então comparo o último segmento.
 */
function isServerAccessRequired(problem?: PapoProblem): boolean {
	return (problem?.type ?? '').split('/').pop() === 'server-access-required';
}

/**
 * Cliente REST do Papo.
 * Autenticação: cookie HttpOnly `Auth` (gerenciado manualmente, pois fetch não tem cookie jar).
 * Convenções do backend: X-Request-ID por chamada, erros RFC 7807, 401 → refresh + 1 retry.
 */
export class PapoApi {
	private cookie?: string;
	private readonly timeoutMs: number;
	private readonly throttle: Throttle;
	/** Refresh em voo: chamadas concorrentes compartilham o mesmo resultado. */
	private refreshing?: Promise<boolean>;
	/** Recuperação de sessão em voo (401 de várias requisições ao mesmo tempo). */
	private recovering?: Promise<boolean>;
	/** Login em voo. */
	private loggingIn?: Promise<void>;

	constructor(private opts: PapoApiOptions) {
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.throttle = new Throttle(opts.rateLimitRps ?? 8, opts.rateBurst ?? 12);
	}

	private get log(): Logger | undefined {
		return this.opts.logger;
	}

	get authenticated(): boolean {
		return Boolean(this.cookie);
	}

	// ── auth ───────────────────────────────────────────────

	/**
	 * Servidor privado: troca a senha do servidor pelo token temporário (30 min)
	 * que o gate de `/auth/login` exige no cookie `Auth`. Resposta 204: a
	 * autorização chega só pelo cookie.
	 */
	async loginServer(): Promise<void> {
		if (!this.opts.serverPassword) {
			throw new PapoApiError('senha do servidor não configurada (PAPO_SERVER_PASSWORD)', 401);
		}
		const res = await this.raw('/auth/login_server', {
			method: 'POST',
			body: JSON.stringify({ server_password: this.opts.serverPassword })
		});
		if (res.status >= 400) await this.problem(res, '/auth/login_server');
		this.storeCookie(res);
		if (!this.cookie) {
			throw new PapoApiError('login_server sem cookie Auth na resposta', 500);
		}
	}

	/** Login serializado: várias requisições caindo ao mesmo tempo não disparam N logins. */
	async login(): Promise<void> {
		if (this.loggingIn) return this.loggingIn;
		const run = this.doLogin().finally(() => {
			this.loggingIn = undefined;
		});
		this.loggingIn = run;
		return run;
	}

	private async doLogin(): Promise<void> {
		// servidor privado: o gate de /auth/login lê o cookie Auth e exige o token
		// temporário de /auth/login_server (um token de sessão não vale como tal).
		if (this.opts.serverPassword) await this.loginServer();

		const body = JSON.stringify({ username: this.opts.username, password: this.opts.password });
		let res = await this.raw('/auth/login', { method: 'POST', body });
		let problem = res.status >= 400 ? await this.readProblem(res) : undefined;

		if (res.status === 401 && isServerAccessRequired(problem) && this.opts.serverPassword) {
			// o token temporário expirou (ou nem chegou): renova e tenta uma vez.
			await this.loginServer();
			res = await this.raw('/auth/login', { method: 'POST', body });
			problem = res.status >= 400 ? await this.readProblem(res) : undefined;
		}

		if (res.status >= 400) {
			if (res.status === 401 && isServerAccessRequired(problem)) {
				throw new PapoApiError(
					'servidor privado: informe PAPO_SERVER_PASSWORD (POST /auth/login_server antes de /auth/login)',
					401,
					problem
				);
			}
			await this.problem(res, '/auth/login', problem);
		}

		this.storeCookie(res);
		if (!this.cookie) {
			throw new PapoApiError('login sem cookie Auth na resposta', 500);
		}
	}

	/**
	 * Rotaciona a sessão (JWT expira em 24h; refresh válido até 30 dias).
	 *
	 * Só é sucesso quando o backend aceitou: `raw()` não lança para status de erro, então
	 * validar o status aqui é o que impede um 401/429/500 de ser reportado como sessão
	 * renovada. Refreshes concorrentes são serializados — chamadas simultâneas disputando
	 * a rotação invalidariam umas às outras.
	 */
	async refresh(): Promise<boolean> {
		if (!this.cookie) return false;
		if (this.refreshing) return this.refreshing;
		const run = this.doRefresh().finally(() => {
			this.refreshing = undefined;
		});
		this.refreshing = run;
		return run;
	}

	private async doRefresh(): Promise<boolean> {
		let res: Response;
		try {
			res = await this.raw('/auth/refresh', { method: 'POST' });
		} catch (err) {
			if (err instanceof PapoApiError && err.status === 401) {
				this.cookie = undefined;
				return false;
			}
			throw err;
		}
		if (res.status === 401) {
			// refresh vencido: a sessão não vale mais, é preciso fazer login de novo
			this.cookie = undefined;
			return false;
		}
		if (res.status >= 400) {
			// 429/5xx: a sessão pode até continuar válida, mas o refresh não aconteceu —
			// transitório, não sucesso
			await this.problem(res, '/auth/refresh');
		}
		this.storeCookie(res);
		if (!this.cookie) throw new PapoApiError('refresh sem cookie Auth na resposta', 500);
		return true;
	}

	/**
	 * Recupera a sessão depois de um 401: tenta o refresh e, se ele não resolver, refaz o
	 * login. Serializado: várias requisições 401 ao mesmo tempo fazem uma única recuperação.
	 */
	private async recoverSession(): Promise<boolean> {
		if (this.recovering) return this.recovering;
		const run = (async () => {
			try {
				if (await this.refresh()) return true;
				this.cookie = undefined;
				await this.login();
				return true;
			} catch (err) {
				this.log?.error({ err }, 'recuperação de sessão falhou');
				return false;
			}
		})().finally(() => {
			this.recovering = undefined;
		});
		this.recovering = run;
		return run;
	}

	async ensureSession(): Promise<void> {
		if (!this.cookie) {
			await this.login();
			return;
		}
		try {
			await this.whoami();
		} catch (err) {
			if (err instanceof PapoApiError && err.status === 401) {
				this.cookie = undefined;
				await this.login();
				return;
			}
			throw err;
		}
	}

	async whoami(): Promise<PapoWhoami> {
		return this.request<PapoWhoami>('/auth/whoami');
	}

	/** Metadados públicos do servidor; `public: false` exige `/auth/login_server` antes do login. */
	async getServer(): Promise<PapoServer> {
		return this.request<PapoServer>('/server');
	}

	/** Cookie atual (usado no handshake do WebSocket). */
	get authCookie(): string | undefined {
		return this.cookie;
	}

	// ── channels / messages ────────────────────────────────

	async listChannels(): Promise<PapoChannel[]> {
		const r = await this.request<{ channels: PapoChannel[] }>('/channels');
		return r.channels ?? [];
	}

	async listMessages(channelId: string, q: ListMessagesQuery = {}): Promise<PapoMessageList> {
		const params = new URLSearchParams();
		if (q.since) params.set('since', q.since);
		if (q.lastId) params.set('last_id', q.lastId);
		params.set('order', q.order ?? 'asc');
		return this.request<PapoMessageList>(`/channels/${channelId}/messages?${params.toString()}`);
	}

	/** Todos os usuários do servidor (páginas de 100), com teto de segurança. */
	async listAllUsers(maxPages = 20): Promise<PapoUserSummary[]> {
		const out: PapoUserSummary[] = [];
		let since: string | undefined;
		let lastId: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const params = new URLSearchParams({ order: 'asc' });
			if (since) params.set('since', since);
			if (lastId) params.set('last_id', lastId);
			const res = await this.request<{ users?: PapoUserSummary[]; has_more?: boolean }>(`/users?${params.toString()}`);
			const users = res.users ?? [];
			out.push(...users);
			if (!res.has_more || users.length === 0) break;
			const last = users[users.length - 1]!;
			since = last.created_at;
			lastId = last.id;
			if (!since) break;
		}
		return out;
	}

	/** Todas as páginas de um canal (ordem asc), com teto de segurança. */
	async listAllMessages(channelId: string, since?: string, maxPages = 20): Promise<PapoMessage[]> {
		const out: PapoMessage[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const res = await this.listMessages(channelId, { since, lastId: cursor, order: 'asc' });
			out.push(...(res.messages ?? []));
			if (!res.has_more || res.messages.length === 0) break;
			cursor = res.messages[res.messages.length - 1]?.id;
			if (!cursor) break;
		}
		return out;
	}

	hasWebhook(channelId:string):boolean {return Boolean(this.opts.webhooks?.[channelId]);}

    async sendMessage(input: SendMessageInput): Promise<PapoMessage> {
		const form = new FormData();
		form.append('channel_id', input.channelId);
		if (input.content != null) form.append('content', input.content);
		if (input.replyTo) form.append('reply_to', input.replyTo);
		for (const a of input.attachments ?? []) {
			form.append('attachments', new Blob([new Uint8Array(a.data)], { type: a.mime ?? 'application/octet-stream' }), a.name);
		}
		if (input.embeds?.length) form.append('embeds', JSON.stringify(input.embeds));
        if (input.externalAuthor) {
            const hook=this.opts.webhooks?.[input.channelId];
            if (!hook) throw new PapoApiError('webhook não configurado para canal '+input.channelId,400);
            if (!input.externalMessageId) throw new PapoApiError('externalMessageId obrigatório',400);
            form.append('external_author',JSON.stringify(input.externalAuthor));
            form.append('external_message_id',input.externalMessageId);
            return this.webhookRequest<PapoMessage>(hook,'/webhooks/'+hook.id+'/messages',{method:'POST',body:form});
        }
        return this.request<PapoMessage>('/messages',{method:'POST',body:form});
	}

	async editMessage(messageId: string, content: string, embeds?: PapoEmbedInput[], channelId?:string): Promise<PapoMessage> {
		const body: { content: string; embeds?: PapoEmbedInput[] } = { content };
		if (embeds) body.embeds = embeds;
		const hook=channelId ? this.opts.webhooks?.[channelId] : undefined;
        if(hook) return this.webhookRequest<PapoMessage>(hook,`/webhooks/${hook.id}/messages/${messageId}`,{method:'PUT',body:JSON.stringify(body)});
        return this.request<PapoMessage>(`/messages/${messageId}`,{method:'PUT',body:JSON.stringify(body)});
	}

	async deleteMessage(messageId: string,channelId?:string): Promise<void> {
        const hook=channelId ? this.opts.webhooks?.[channelId] : undefined;
        if(hook) {
            await this.webhookRequest<void>(hook,`/webhooks/${hook.id}/messages/${messageId}`,{method:'DELETE'});
            return;
        }
        await this.request<void>(`/messages/${messageId}`,{method:'DELETE'});
	}

	// ── reactions / pins ───────────────────────────────────

	async addReaction(channelId: string, messageId: string, reaction: { emojiId?: string; unicode?: string }): Promise<void> {
		const body: Record<string, string> = {};
		if (reaction.emojiId) body.emoji_id = reaction.emojiId;
		if (reaction.unicode) body.unicode = reaction.unicode;
		await this.request<void>(`/channels/${channelId}/messages/${messageId}/reactions`, {
			method: 'POST',
			body: JSON.stringify(body)
		});
	}

	async removeReaction(channelId: string, messageId: string, reaction: { emojiId?: string; unicode?: string }): Promise<void> {
		const body: Record<string, string> = {};
		if (reaction.emojiId) body.emoji_id = reaction.emojiId;
		if (reaction.unicode) body.unicode = reaction.unicode;
		await this.request<void>(`/channels/${channelId}/messages/${messageId}/reactions`, {
			method: 'DELETE',
			body: JSON.stringify(body)
		});
	}

	/** Mensagens pinadas do canal, na ordem em que foram fixadas. */
	async listPinned(channelId: string): Promise<PapoMessage[]> {
		const res = await this.request<{ pinned?: PapoMessage[]; messages?: PapoMessage[] } | PapoMessage[]>(
			`/channels/${channelId}/pinned`
		);
		if (Array.isArray(res)) return res;
		return res.pinned ?? res.messages ?? [];
	}

	/** Embed com `image_data` (base64 da thumbnail) quando o backend tem a imagem em cache. */
	async getEmbed(embedId: string): Promise<PapoEmbed & { image_data?: string | null }> {
		return this.request<PapoEmbed & { image_data?: string | null }>(`/embeds/${embedId}`);
	}

	/**
	 * Autores das reações de uma mensagem (páginas de 100). O evento WS `react_update` não traz
	 * quem reagiu; esta é a única forma de recuperar a identidade.
	 */
	async listReactions(
		channelId: string,
		messageId: string
	): Promise<{ reactions?: { id?: string; user_id?: string; emoji_id?: string | null; unicode?: string | null }[] }> {
		return this.request(`/channels/${channelId}/messages/${messageId}/reactions`);
	}

	async setPin(channelId: string, messageId: string, pinned: boolean): Promise<void> {
		if (pinned) {
			await this.request<void>(`/channels/${channelId}/messages/${messageId}/pin`, { method: 'POST' });
		} else {
			await this.request<void>(`/channels/${channelId}/messages/${messageId}/pin`, { method: 'DELETE' });
		}
	}

	// ── emojis ─────────────────────────────────────────────

	/** Lista completa de emojis do servidor (25 por página). */
	async listAllEmojis(maxPages = 40): Promise<PapoEmoji[]> {
		const out: PapoEmoji[] = [];
		let since: string | undefined;
		let lastId: string | undefined;
		for (let page = 0; page < maxPages; page++) {
			const params = new URLSearchParams({ order: 'asc' });
			if (since) params.set('since', since);
			if (lastId) params.set('last_id', lastId);
			const res = await this.request<{ emojis: PapoEmoji[] }>(`/emojis?${params.toString()}`);
			const emojis = res.emojis ?? [];
			out.push(...emojis);
			if (emojis.length === 0) break;
			const last = emojis[emojis.length - 1]!;
			since = last.created_at;
			lastId = last.id;
		}
		return out;
	}

	/**
	 * Cria emoji custom. Atenção: o backend exige `manage_server`
	 * (dono do servidor ou role com a permissão).
	 */
	async createEmoji(name: string, imageBase64: string, format: PapoEmoji['format']): Promise<PapoEmoji> {
		return this.request<PapoEmoji>('/emojis', {
			method: 'POST',
			body: JSON.stringify({ name, format, image_blob: imageBase64 })
		});
	}

	/** Remove emoji (o bridge usa isso para desfazer uma importação). */
	async deleteEmoji(emojiId: string): Promise<void> {
		await this.request<void>(`/emojis/${emojiId}`, { method: 'DELETE' });
	}

	// ── mídia ──────────────────────────────────────────────

	async downloadAttachment(fileId: string): Promise<Buffer> {
		return this.download(`/attachments/${fileId}`);
	}

	async downloadAttachmentThumbnail(fileId: string): Promise<Buffer> {
		return this.download(`/attachments/${fileId}/thumbnail`);
	}

	async downloadMedia(sha256: string): Promise<Buffer> {
		return this.download(`/media/${sha256}`);
	}

	// ── usuários ───────────────────────────────────────────

	/** Perfis em lote (máx. 50 ids por chamada). */
	async profilesBatch(ids: string[]): Promise<PapoUserProfile[]> {
		const out: PapoUserProfile[] = [];
		for (let i = 0; i < ids.length; i += 50) {
			const chunk = ids.slice(i, i + 50);
			if (!chunk.length) continue;
			const res = await this.request<{ profiles: PapoUserProfile[] }>('/users/profile_batch', {
				method: 'POST',
				body: JSON.stringify({ ids: chunk })
			});
			out.push(...(res.profiles ?? []));
		}
		return out;
	}

	/** Resumos em lote (máx. 1000 ids por chamada). */
	async summariesBatch(ids: string[]): Promise<PapoUserSummary[]> {
		const out: PapoUserSummary[] = [];
		for (let i = 0; i < ids.length; i += 1000) {
			const chunk = ids.slice(i, i + 1000);
			if (!chunk.length) continue;
			const res = await this.request<PapoUserSummary[]>('/users/user_summary_batch', {
				method: 'POST',
				body: JSON.stringify({ ids: chunk })
			});
			out.push(...(res ?? []));
		}
		return out;
	}

	// ── plumbing ───────────────────────────────────────────

	private storeCookie(res: Response): void {
		const getCookies = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
		const cookies = getCookies?.length ? getCookies : res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [];
		for (const c of cookies) {
			const pair = c.split(';')[0]?.trim();
			// o cookie vem com `Secure` mesmo em http:// — guardamos só o par `Auth=…`
			// e enviamos como header `Cookie` (fetch não tem cookie jar).
			if (pair && pair.startsWith('Auth=') && pair !== 'Auth=') this.cookie = pair;
		}
	}

	private async raw(path: string, init: RequestInit): Promise<Response> {
		await this.throttle.acquire();
		const headers = new Headers(init.headers ?? {});
		headers.set('X-Request-ID', randomUUID());
		if (!headers.has('Accept')) headers.set('Accept', 'application/problem+json, application/json');
		if (this.cookie && !headers.has('Cookie') && !headers.has('Authorization')) headers.set('Cookie', this.cookie);
		if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
			headers.set('Content-Type', 'application/json');
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let res: Response;
		try {
			res = await fetch(new URL(path, this.opts.baseUrl), { ...init, headers, signal: controller.signal });
		} catch (err) {
			throw new PapoApiError(`falha de rede em ${path}: ${(err as Error).message}`, 0);
		} finally {
			clearTimeout(timer);
		}
		return res;
	}

	private async readProblem(res: Response): Promise<PapoProblem | undefined> {
		try {
			if ((res.headers.get('content-type') ?? '').includes('json')) return (await res.json()) as PapoProblem;
		} catch {
			return undefined;
		}
		return undefined;
	}

	private async problem(res: Response, path: string, preread?: PapoProblem): Promise<never> {
		const problem = preread ?? (await this.readProblem(res));
		const detail = problem?.detail ?? problem?.title ?? res.statusText;
		throw new PapoApiError(`${res.status} em ${path}: ${detail}`, res.status, problem, res.headers.get('x-request-id') ?? undefined);
	}

	private async webhookRequest<T>(hook:{id:string;token:string},path:string,init:RequestInit):Promise<T> {
        const headers=new Headers(init.headers);
        headers.set('Authorization','Bearer '+hook.token);
        const res=await this.raw(path,{...init,headers});
        if (res.status>=400) await this.problem(res,path);
        if (res.status===204) return undefined as T;
        return (await res.json()) as T;
    }

    private async request<T>(path: string, init: RequestInit = {}, allowRecovery = true): Promise<T> {
		const res = await this.raw(path, init);
		if (res.status === 401 && allowRecovery) {
			// uma única recuperação por onda de 401; o retry é feito com a sessão renovada
			if (await this.recoverSession()) return this.request<T>(path, init, false);
		}
		if (res.status >= 400) await this.problem(res, path);
		if (res.status === 204) return undefined as T;
		const ct = res.headers.get('content-type') ?? '';
		if (!ct.includes('json')) return (await res.text()) as unknown as T;
		return (await res.json()) as T;
	}

	/**
	 * Requisição binária (anexo, thumbnail, mídia). A recuperação de sessão vale aqui tanto
	 * quanto vale nas requisições JSON: um 401 no meio do download de um anexo derrubaria a
	 * mensagem inteira, e `PapoApiError.transient` não chega a ser consultado se a sessão
	 * pudesse ser renovada antes. Uma única recuperação, um único retry.
	 */
	private async download(path: string, allowRecovery = true): Promise<Buffer> {
		const res = await this.raw(path, { method: 'GET' });
		if (res.status === 401 && allowRecovery) {
			if (await this.recoverSession()) return this.download(path, false);
		}
		if (res.status >= 400) await this.problem(res, path);
		return Buffer.from(await res.arrayBuffer());
	}
}
