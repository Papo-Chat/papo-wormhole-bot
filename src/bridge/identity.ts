import type { PapoApi } from '../papo/api.js';
import type { Store } from '../db/store.js';
import type { MediaStore } from './media.js';
import { authorLabel } from './translator.js';

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

/** Resolve e cachea autores do lado Papo (perfil + avatar). */
export class PapoIdentity {
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

	async author(userId: string): Promise<AuthorInfo> {
		const hit = this.cached(userId);
		if (hit && (hit.avatarSha || !this.publicBaseUrl)) return hit;

		// avatar: profile_batch devolve avatar_blob em base64 → cache local por sha256
		try {
			const [profile] = await this.api.profilesBatch([userId]);
			if (profile) {
				const sha = profile.avatar_blob
					? this.media.save(Buffer.from(profile.avatar_blob, 'base64'), `image/${(profile.avatar_format ?? 'png').toLowerCase()}`, 'papo-avatar').sha256
					: undefined;
				this.store.upsertPapoUser({
					id: profile.id,
					username: profile.username,
					nickname: profile.nickname ?? null,
					avatar_sha: sha ?? null
				});
			}
		} catch {
			// sem avatar não há motivo para derrubar o bridge de texto
		}
		return this.cached(userId) ?? { userId, username: 'usuário', name: 'usuário' };
	}
}
