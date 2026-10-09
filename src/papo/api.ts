import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
	PapoChannel,
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
	username: string;
	password: string;
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
 * Cliente REST do Papo.
 * Autenticação: cookie HttpOnly `Auth` (gerenciado manualmente, pois fetch não tem cookie jar).
 * Convenções do backend: X-Request-ID por chamada, erros RFC 7807, 401 → refresh + 1 retry.
 */
export class PapoApi {
	private cookie?: string;
	private readonly timeoutMs: number;
	private readonly throttle: Throttle;

	constructor(private opts: PapoApiOptions) {
		this.timeoutMs = opts.timeoutMs ?? 30_000;
		this.throttle = new Throttle(opts.rateLimitRps ?? 8, opts.rateBurst ?? 12);
	}

	get authenticated(): boolean {
		return Boolean(this.cookie);
	}

	// ── auth ───────────────────────────────────────────────

	async login(): Promise<void> {
		const res = await this.raw('/auth/login', {
			method: 'POST',
			body: JSON.stringify({ username: this.opts.username, password: this.opts.password })
		});
		this.storeCookie(res);
		if (!this.cookie) {
			throw new PapoApiError('login sem cookie Auth na resposta', 500);
		}
	}

	/** Rotaciona a sessão (JWT expira em 24h; refresh válido até 30 dias). */
	async refresh(): Promise<boolean> {
		if (!this.cookie) return false;
		try {
			const res = await this.raw('/auth/refresh', { method: 'POST' });
			this.storeCookie(res);
			return true;
		} catch (err) {
			if (err instanceof PapoApiError && err.status === 401) {
				this.cookie = undefined;
				return false;
			}
			throw err;
		}
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

	async sendMessage(input: SendMessageInput): Promise<PapoMessage> {
		const form = new FormData();
		form.append('channel_id', input.channelId);
		if (input.content != null) form.append('content', input.content);
		if (input.replyTo) form.append('reply_to', input.replyTo);
		for (const a of input.attachments ?? []) {
			form.append('attachments', new Blob([new Uint8Array(a.data)], { type: a.mime ?? 'application/octet-stream' }), a.name);
		}
		if (input.embeds?.length) form.append('embeds', JSON.stringify(input.embeds));
		return this.request<PapoMessage>('/messages', { method: 'POST', body: form });
	}

	async editMessage(messageId: string, content: string, embeds?: PapoEmbedInput[]): Promise<PapoMessage> {
		const body: { content: string; embeds?: PapoEmbedInput[] } = { content };
		if (embeds) body.embeds = embeds;
		return this.request<PapoMessage>(`/messages/${messageId}`, { method: 'PUT', body: JSON.stringify(body) });
	}

	async deleteMessage(messageId: string): Promise<void> {
		await this.request<void>(`/messages/${messageId}`, { method: 'DELETE' });
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
		if (this.cookie && !headers.has('Cookie')) headers.set('Cookie', this.cookie);
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

	private async problem(res: Response, path: string): Promise<never> {
		let problem: PapoProblem | undefined;
		try {
			if ((res.headers.get('content-type') ?? '').includes('json')) problem = (await res.json()) as PapoProblem;
		} catch {
			problem = undefined;
		}
		const detail = problem?.detail ?? problem?.title ?? res.statusText;
		throw new PapoApiError(`${res.status} em ${path}: ${detail}`, res.status, problem, res.headers.get('x-request-id') ?? undefined);
	}

	private async request<T>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> {
		const res = await this.raw(path, init);
		if (res.status === 401 && allowRefresh) {
			const refreshed = await this.refresh().catch(() => false);
			if (refreshed) return this.request<T>(path, init, false);
		}
		if (res.status >= 400) await this.problem(res, path);
		if (res.status === 204) return undefined as T;
		const ct = res.headers.get('content-type') ?? '';
		if (!ct.includes('json')) return (await res.text()) as unknown as T;
		return (await res.json()) as T;
	}

	private async download(path: string): Promise<Buffer> {
		const res = await this.raw(path, { method: 'GET' });
		if (res.status >= 400) await this.problem(res, path);
		return Buffer.from(await res.arrayBuffer());
	}
}
