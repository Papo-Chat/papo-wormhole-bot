import type { Db } from './index.js';
import { rows } from './index.js';

export type OutboxDirection = 'to_discord' | 'to_papo';
export type OutboxKind = 'message' | 'edit' | 'delete' | 'reaction' | 'pin';
export type OutboxState = 'pending' | 'in_flight' | 'done' | 'failed' | 'dead';

export interface OutboxRow {
	id: number;
	link_id: number;
	direction: OutboxDirection;
	kind: OutboxKind;
	payload: string;
	dedupe_key: string;
	revision: string | null;
	remote_attempts: number;
	state: OutboxState;
	attempts: number;
	last_error: string | null;
	next_retry_at: string;
	created_at: string;
}

export interface EnqueueInput {
	linkId: number;
	direction: OutboxDirection;
	kind: OutboxKind;
	dedupeKey: string;
	payload: unknown;
	/**
	 * Chave de **estado** (reação, pino, edição): em vez de descartar a chegada seguinte, o
	 * job vivo da mesma chave recebe o payload mais recente. Estados repetíveis não são
	 * eventos únicos — `1→0→1` precisa chegar ao destino.
	 * Padrão: `true` para `reaction`/`pin`/`edit`, `false` para `message`/`delete`.
	 */
	coalesce?: boolean;
	/** Revisão monotônica do estado (timestamp ISO da origem). Ao coalescer, a maior vence. */
	revision?: string;
	/** O job só sai da fila a partir deste instante (debounce do resumo de reações). */
	notBefore?: Date;
}

export interface BackoffPolicy {
	maxAttempts: number;
	baseMs: number;
	maxMs: number;
}

/** Kinds cuja chave identifica um estado observável, não um evento único. */
const COALESCABLE_KINDS: ReadonlySet<OutboxKind> = new Set<OutboxKind>(['reaction', 'pin', 'edit']);

/** Jobs que ainda podem ter o payload trocado por um estado mais novo. */
const LIVE_STATES = "'pending','in_flight','failed'";

/**
 * Gerações de coalescência: com o job `in_flight` o payload em execução não pode ser
 * trocado por baixo do worker — o estado novo entra como job da geração seguinte.
 */
const MAX_COALESCE_GENERATIONS = 8;

/** Backoff exponencial com jitter: base * 2^(attempt-1), limitado e com ruído ±20%. */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy, rand = Math.random): number {
	const raw = policy.baseMs * 2 ** Math.max(0, attempt - 1);
	const capped = Math.min(policy.maxMs, raw);
	const jitter = 0.8 + rand() * 0.4;
	return Math.round(capped * jitter);
}

export class Outbox {
	constructor(
		private db: Db,
		private policy: BackoffPolicy
	) {}

	/** Sequência de chaves de transbordamento da coalescência. */
	private overflow = 0;

	/**
	 * Enfileira um job. Retorna o id, ou `null` quando a chave já está ocupada por job
	 * equivalente. Para chaves de estado, o job vivo é atualizado com o payload mais recente.
	 */
	enqueue(job: EnqueueInput): number | null {
		const payload = JSON.stringify(job.payload);
		const due = (job.notBefore ?? new Date()).toISOString();
		const coalesce = job.coalesce ?? COALESCABLE_KINDS.has(job.kind);
		if (!coalesce) return this.insert(job, job.dedupeKey, payload, due);

		for (let gen = 0; gen <= MAX_COALESCE_GENERATIONS; gen++) {
			const key = gen === 0 ? job.dedupeKey : `${job.dedupeKey}#${gen}`;
			const live = rows<{ id: number; state: OutboxState; revision: string | null }>(
				this.db
					.prepare(
						`SELECT id, state, revision FROM outbox WHERE dedupe_key = ? AND state IN (${LIVE_STATES}) ORDER BY id DESC LIMIT 1`
					)
					.all(key)
			)[0];
			if (!live) {
				const id = this.insert(job, key, payload, due);
				// chave presa por job concluído (schema antigo, UNIQUE permanente): próxima geração
				if (id !== null) return id;
				continue;
			}
			if (live.state === 'in_flight') continue;
			return this.replace(live.id, payload, job.revision, live.revision, due);
		}
		return this.insertOverflow(job, payload, due);
	}

	/**
	 * Gerações esgotadas: o estado entra com chave própria em vez de ser descartado. O
	 * contador evita que duas transições no mesmo milissegundo colidam na chave.
	 */
	private insertOverflow(job: EnqueueInput, payload: string, due: string): number | null {
		for (let n = 0; n < 16; n++) {
			const id = this.insert(job, `${job.dedupeKey}#x${(this.overflow++).toString(36)}`, payload, due);
			if (id !== null) return id;
		}
		return null;
	}

	private insert(job: EnqueueInput, key: string, payload: string, due: string): number | null {
		try {
			const res = this.db
				.prepare(
					`INSERT INTO outbox (link_id, direction, kind, payload, dedupe_key, revision, next_retry_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`
				)
				.run(job.linkId, job.direction, job.kind, payload, key, job.revision ?? null, due);
			return Number(res.lastInsertRowid);
		} catch (err) {
			if ((err as Error).message.includes('UNIQUE')) return null;
			throw err;
		}
	}

	/** Troca o estado pendente pelo mais recente — a transição não pode ser descartada. */
	private replace(id: number, payload: string, revision: string | undefined, current: string | null, due: string): number {
		if (revision !== undefined && current !== null && revision < current) return id;
		this.db
			.prepare(
				`UPDATE outbox SET payload = ?, revision = ?, state = 'pending', attempts = 0, claimed_at = NULL, next_retry_at = ?
				 WHERE id = ?`
			)
			.run(payload, revision ?? null, due, id);
		return id;
	}

	/**
	 * Reivindica o próximo job pendente de um canal-link (FIFO por id).
	 * Um só worker por link garante ordem de conversa; links avançam em paralelo.
	 * Reivindicação em uma única statement atômica: duas instâncias não conseguem tomar
	 * o mesmo job.
	 */
	claimNext(linkId: number, now = new Date()): OutboxRow | undefined {
		const claimed = rows<OutboxRow>(
			this.db
				.prepare(
					`UPDATE outbox SET state = 'in_flight', claimed_at = ?
					 WHERE id = (
					   SELECT id FROM outbox
					   WHERE link_id = ? AND state IN ('pending','failed') AND next_retry_at <= ?
					   ORDER BY id LIMIT 1
					 )
					 RETURNING *`
				)
				.all(now.toISOString(), linkId, now.toISOString())
		);
		const job = claimed[0];
		if (!job) return undefined;
		return { ...job, state: 'in_flight' };
	}

	/**
	 * Registra o envio remoto antes de chamá-lo. Separa "nunca saiu" de "saiu e o resultado
	 * é incerto" — o caso em que repetir o envio duplicaria a mensagem no destino.
	 */
	markRemoteAttempt(id: number): void {
		this.db.prepare('UPDATE outbox SET remote_attempts = remote_attempts + 1 WHERE id = ?').run(id);
	}

	/** Quantos envios remotos já foram tentados para este job. */
	remoteAttempts(id: number): number {
		const r = rows<{ remote_attempts: number }>(this.db.prepare('SELECT remote_attempts FROM outbox WHERE id = ?').all(id))[0];
		return r?.remote_attempts ?? 0;
	}

	complete(id: number, now = new Date()): void {
		this.db
			.prepare(`UPDATE outbox SET state = 'done', done_at = ?, claimed_at = NULL WHERE id = ?`)
			.run(now.toISOString(), id);
	}

	/**
	 * Registra falha. Erro permanente (4xx de payload/permissão) vai direto para `dead`;
	 * erro transitório volta para `pending` com next_retry_at.
	 */
	fail(id: number, error: string, permanent = false, now = new Date()): void {
		const current = rows<{ attempts: number }>(this.db.prepare('SELECT attempts FROM outbox WHERE id = ?').all(id))[0];
		const attempts = (current?.attempts ?? 0) + 1;
		if (permanent || attempts >= this.policy.maxAttempts) {
			this.db
				.prepare(`UPDATE outbox SET state = 'dead', attempts = ?, last_error = ?, claimed_at = NULL WHERE id = ?`)
				.run(attempts, error, id);
			return;
		}
		const delay = backoffDelayMs(attempts, this.policy);
		this.db
			.prepare(
				`UPDATE outbox SET state = 'pending', attempts = ?, last_error = ?, claimed_at = NULL,
				 next_retry_at = ? WHERE id = ?`
			)
			.run(attempts, error, new Date(now.getTime() + delay).toISOString(), id);
	}

	/** Jobs presos em in_flight (crash no meio do envio) voltam para a fila. */
	requeueStale(olderThanMs = 60_000, now = new Date()): number {
		const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
		return Number(
			this.db
				.prepare(
					`UPDATE outbox SET state = 'pending', claimed_at = NULL
					 WHERE state = 'in_flight' AND (claimed_at IS NULL OR claimed_at < ?)`
				)
				.run(cutoff).changes
		);
	}

	requeueAll(states: OutboxState[] = ['failed', 'dead'], now = new Date()): number {
		const placeholders = states.map(() => '?').join(',');
		return Number(
			this.db
				.prepare(
					`UPDATE outbox SET state = 'pending', next_retry_at = ?, attempts = 0
					 WHERE state IN (${placeholders})`
				)
				.run(now.toISOString(), ...states).changes
		);
	}

	counts(): Record<OutboxState, number> {
		const out = { pending: 0, in_flight: 0, done: 0, failed: 0, dead: 0 } as Record<OutboxState, number>;
		for (const r of rows<{ state: OutboxState; n: number }>(
			this.db.prepare('SELECT state, COUNT(*) AS n FROM outbox GROUP BY state').all()
		)) {
			out[r.state] = r.n;
		}
		return out;
	}

	pendingCount(linkId: number): number {
		const r = rows<{ n: number }>(
			this.db.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE link_id = ? AND state IN ('pending','in_flight','failed')`).all(linkId)
		);
		return r[0]?.n ?? 0;
	}

	list(state: OutboxState, limit = 20): OutboxRow[] {
		return rows<OutboxRow>(this.db.prepare('SELECT * FROM outbox WHERE state = ? ORDER BY id DESC LIMIT ?').all(state, limit));
	}
}
