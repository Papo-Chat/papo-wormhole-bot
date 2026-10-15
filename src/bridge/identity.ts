import type { PapoApi } from '../papo/api.js';
import type { Store } from '../db/store.js';
import type { MediaStore } from './media.js';
import { authorLabel } from './translator.js';
import { logger } from '../logger.js';

export interface AuthorInfo {
	userId: string;
	/** nickname > username (convenção do bridge). */
	name: string;
	username: string;
	nickname?: string;
	avatarSha?: string;
	/** URL absoluta do avatar (só existe quando há media server público). */
	avatarUrl?: string;
}

/**
 * Nome do webhook de um autor (modo webhook, nos dois lados): `nickname (@username)`, ou só
 * o username quando o apelido é o próprio nome. O sufixo com o username torna o nome único
 * e reaproveitável entre runs — apelidos iguais entre usuários colidiriam.
 */
export function bridgeWebhookName(displayName: string, username: string): string {
	const base = displayName.trim() || username;
	if (base === username) return username;
	// o sufixo `(@username)` precisa sobreviver ao limite de 80: o apelido cede espaço
	return `${base.slice(0, 76 - username.length)} (@${username})`.slice(0, 80);
}

/** Resolve e cachea autores do lado Papo (perfil + avatar). */
export class PapoIdentity {
	private readonly fetchedAt = new Map<string, number>();
	private readonly inflight = new Map<string, Promise<void>>();
	private static readonly TTL_MS = 10 * 60_000;   // perfil com avatar
	private static readonly RETRY_MS = 60_000;      // sem avatar ou falha anterior
	
	constructor(
		private api: PapoApi,
		private store: Store,
		private media: MediaStore,
		private publicBaseUrl?: string	
	) {}

	private cached(userId: string): AuthorInfo | undefined {
		const row = this.store.getPapoUser(userId);
		if (!row) return undefined;
		return {
			userId,
			username: row.username,
			nickname: row.nickname ?? undefined,
			name: authorLabel(row.nickname, row.username),
			avatarSha: row.avatar_sha ?? undefined,
			avatarUrl: row.avatar_sha ? this.media.urlFor(row.avatar_sha, this.publicBaseUrl) : undefined
		};
	}

	/** Busca em lote (POST /users/user_summary_batch) e popula o cache. */
	async warm(ids: string[]): Promise<void> {
		const missing = [...new Set(ids)].filter((id) => !this.cached(id));
		if (!missing.length) return;
		const summaries = await this.api.summariesBatch(missing);
		for (const s of summaries) {
			this.store.upsertPapoUser({ id: s.id, username: s.username, nickname: s.nickname ?? null });
		}
	}

	invalidate(userId: string): void {
		this.fetchedAt.delete(userId);
	}

	async author(userId: string): Promise<AuthorInfo> {
		const hit = this.cached(userId);
		const at = this.fetchedAt.get(userId);
		const ttl = hit?.avatarSha ? PapoIdentity.TTL_MS : PapoIdentity.RETRY_MS;
		const fresh = hit !== undefined && at !== undefined && Date.now() - at < ttl;
		if (!fresh) await this.refresh(userId);
		return this.cached(userId) ?? hit ?? { userId, username: 'usuário', name: 'usuário' };
	}

	// várias mensagens do mesmo autor em sequência compartilham uma única busca
	private refresh(userId: string): Promise<void> {
		let p = this.inflight.get(userId);
		if (!p) {
			p = this.fetchProfile(userId).finally(() => this.inflight.delete(userId));
			this.inflight.set(userId, p);
		}
		return p;
	}

	private async fetchProfile(userId: string): Promise<void> {
		// marca antes da chamada: falha também respeita o intervalo e não pressiona o
		// rate limit do Papo (global por IP)
		this.fetchedAt.set(userId, Date.now());
		try {
			const [profile] = await this.api.profilesBatch([userId]);
			if (!profile) return;

			let sha: string | null = null;
			if (profile.avatar_blob) {
				const buf = Buffer.from(profile.avatar_blob, 'base64');
				const info = this.media.sniffImage(buf);
				if (info) {
					sha = this.media.save(buf, info.mime, 'papo-avatar').sha256;
				} else {
					// bytes que não são imagem reconhecida: manter o avatar anterior
					logger.warn({ userId, head: buf.subarray(0, 12).toString('hex') }, 'avatar do Papo com formato não reconhecido');
					sha = this.cached(userId)?.avatarSha ?? null;
				}
			}
			// sem avatar_blob no perfil: o usuário não tem avatar, e sha = null é o estado correto

			this.store.upsertPapoUser({
				id: profile.id,
				username: profile.username,
				nickname: profile.nickname ?? null,
				avatar_sha: sha
			});
		} catch (err) {
			logger.warn({ userId, err }, 'falha ao atualizar perfil do Papo');
		}
	}
}
