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
}

export interface BackoffPolicy {
	maxAttempts: number;
	baseMs: number;
	maxMs: number;
}

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

	/** Enfileira um job. Retorna o id, ou null quando o dedupe_key já existia. */
	enqueue(job: EnqueueInput): number | null {
		try {
			const res = this.db
				.prepare(
					`INSERT INTO outbox (link_id, direction, kind, payload, dedupe_key)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.run(job.linkId, job.direction, job.kind, JSON.stringify(job.payload), job.dedupeKey);
			return Number(res.lastInsertRowid);
		} catch (err) {
			if ((err as Error).message.includes('UNIQUE')) return null;
			throw err;
		}
	}

	/**
	 * Reivindica o próximo job pendente de um canal-link (FIFO por id).
	 * Um só worker por link garante ordem de conversa; links avançam em paralelo.
	 */
	claimNext(linkId: number, now = new Date()): OutboxRow | undefined {
		const due = rows<OutboxRow>(
			this.db
				.prepare(
					`SELECT * FROM outbox
					 WHERE link_id = ? AND state IN ('pending','failed') AND next_retry_at <= ?
					 ORDER BY id LIMIT 1`
				)
				.all(linkId, now.toISOString())
		);
		const job = due[0];
		if (!job) return undefined;
		this.db
			.prepare(`UPDATE outbox SET state = 'in_flight', claimed_at = ? WHERE id = ?`)
			.run(now.toISOString(), job.id);
		return { ...job, state: 'in_flight' };
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
