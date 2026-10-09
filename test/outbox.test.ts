import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox, backoffDelayMs } from '../src/db/outbox.js';

const policy = { maxAttempts: 4, baseMs: 1000, maxMs: 30_000 };

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const link = store.upsertChannelLink({ papo_channel_id: 'papo-1', discord_channel_id: '111' });
	return { db, store, outbox: new Outbox(db, policy), linkId: link.id };
};

describe('backoffDelayMs', () => {
	it('cresce exponencialmente a partir da base', () => {
		const rand = () => 0.5; // jitter = 1.0
		expect(backoffDelayMs(1, policy, rand)).toBe(1000);
		expect(backoffDelayMs(2, policy, rand)).toBe(2000);
		expect(backoffDelayMs(3, policy, rand)).toBe(4000);
	});

	it('satura no teto', () => {
		const rand = () => 0.5;
		expect(backoffDelayMs(20, policy, rand)).toBe(30_000);
	});

	it('aplica jitter de ±20%', () => {
		const low = backoffDelayMs(1, policy, () => 0);
		const high = backoffDelayMs(1, policy, () => 1);
		expect(low).toBe(800);
		expect(high).toBe(1200);
	});
});

describe('Outbox', () => {
	it('enfileira e deduplica por dedupe_key', () => {
		const { outbox, linkId } = fixture();
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k1', payload: { a: 1 } });
		const dup = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k1', payload: { a: 2 } });
		expect(id).not.toBeNull();
		expect(dup).toBeNull();
		expect(outbox.counts().pending).toBe(1);
	});

	it('preserva a ordem FIFO por canal-link', () => {
		const { outbox, linkId } = fixture();
		const ids = [1, 2, 3].map((n) =>
			outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: `k${n}`, payload: { n } })
		);
		const claimed = [outbox.claimNext(linkId)?.id, outbox.claimNext(linkId)?.id, outbox.claimNext(linkId)?.id];
		expect(claimed).toEqual(ids);
		expect(outbox.claimNext(linkId)).toBeUndefined();
	});

	it('links diferentes são independentes', () => {
		const { store, outbox, linkId } = fixture();
		const other = store.upsertChannelLink({ papo_channel_id: 'papo-2', discord_channel_id: '222' });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'a', payload: {} });
		outbox.enqueue({ linkId: other.id, direction: 'to_discord', kind: 'message', dedupeKey: 'b', payload: {} });
		expect(outbox.claimNext(linkId)?.dedupe_key).toBe('a');
		expect(outbox.claimNext(other.id)?.dedupe_key).toBe('b');
	});

	it('erro transitório volta para pending com next_retry_at no futuro', () => {
		const { outbox, linkId } = fixture();
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} })!;
		outbox.claimNext(linkId);
		outbox.fail(id, 'HTTP 429', false);

		// ainda não está disponível: o backoff segura o job
		expect(outbox.claimNext(linkId)).toBeUndefined();
		expect(outbox.counts().pending).toBe(1);

		// disponível a partir do instante em que o retry vence
		const row = outbox.list('pending', 1)[0]!;
		const future = new Date(Date.now() + 60_000);
		expect(new Date(row.next_retry_at).getTime()).toBeGreaterThan(Date.now());
		expect(outbox.claimNext(linkId, future)?.id).toBe(id);
	});

	it('erro permanente vai direto para dead', () => {
		const { outbox, linkId } = fixture();
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} })!;
		outbox.claimNext(linkId);
		outbox.fail(id, '403 Forbidden', true);
		expect(outbox.counts().dead).toBe(1);
		expect(outbox.list('dead')[0]?.last_error).toBe('403 Forbidden');
	});

	it('esgota as tentativas e marca como dead', () => {
		const { outbox, linkId } = fixture();
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} })!;
		for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
			outbox.claimNext(linkId, new Date(Date.now() + attempt * 60_000));
			outbox.fail(id, `falha ${attempt}`, false, new Date(Date.now() + attempt * 60_000));
		}
		expect(outbox.counts().dead).toBe(1);
		expect(outbox.list('dead')[0]?.attempts).toBe(policy.maxAttempts);
	});

	it('complete marca como done e libera o próximo', () => {
		const { outbox, linkId } = fixture();
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} })!;
		outbox.claimNext(linkId);
		outbox.complete(id);
		expect(outbox.counts().done).toBe(1);
		expect(outbox.pendingCount(linkId)).toBe(0);
	});

	it('requeueStale devolve jobs presos em in_flight', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} });
		outbox.claimNext(linkId);
		expect(outbox.counts().in_flight).toBe(1);
		// o job foi reivindicado agora; ele é considerado stale a partir de um instante futuro
		expect(outbox.requeueStale(0, new Date(Date.now() + 5_000))).toBe(1);
		expect(outbox.counts().in_flight).toBe(0);
		expect(outbox.counts().pending).toBe(1);
	});

	it('requeueAll reanima failed e dead', () => {
		const { outbox, linkId } = fixture();
		const dead = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'd', payload: {} })!;
		outbox.claimNext(linkId);
		outbox.fail(dead, 'boom', true);
		expect(outbox.requeueAll(['dead'])).toBe(1);
		expect(outbox.counts().pending).toBe(1);
	});

	it('payload sobrevive ao round-trip JSON', () => {
		const { outbox, linkId } = fixture();
		const payload = { job: { kind: 'message', description: 'olá 🌍' }, embed: { title: 't' } };
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload });
		const row = outbox.claimNext(linkId)!;
		expect(JSON.parse(row.payload)).toEqual(payload);
	});
});
