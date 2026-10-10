import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';

const policy = { maxAttempts: 4, baseMs: 1000, maxMs: 30_000 };

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const link = store.upsertChannelLink({ papo_channel_id: 'papo-1', discord_channel_id: '111' });
	return { db, store, outbox: new Outbox(db, policy), linkId: link.id };
};

const reaction = (count: number) => ({
	kind: 'reaction',
	linkId: 1,
	side: 'papo',
	sourceMessageId: 'pm1',
	destinationMessageId: '9999',
	emoji: '👍',
	present: count > 0,
	count
});

describe('P1.1: coalescência de estado no outbox', () => {
	it('reação 1→0→1 deixa um único job ativo com o estado final', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(1) });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(0) });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(1) });

		const rows = outbox.list('pending');
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.payload).count).toBe(1);
		expect(outbox.counts().pending).toBe(1);
	});

	it('pino true→false→true deixa um único job ativo com o estado final', () => {
		const { outbox, linkId } = fixture();
		for (const pinned of [true, false, true]) {
			outbox.enqueue({
				linkId,
				direction: 'to_discord',
				kind: 'pin',
				dedupeKey: 'p1',
				payload: { kind: 'pin', linkId, side: 'papo', sourceMessageId: 'pm1', pinned }
			});
		}
		const rows = outbox.list('pending');
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.payload).pinned).toBe(true);
	});

	it('o estado coalescido substitui o payload e mantém a primeira posição na fila', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'm1', payload: { n: 1 } });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(1) });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(0) });

		expect(outbox.claimNext(linkId)?.dedupe_key).toBe('m1');
		const row = outbox.claimNext(linkId)!;
		expect(JSON.parse(row.payload).count).toBe(0);
	});

	it('dois jobs com o mesmo estado não se acumulam', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(1) });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(1) });
		expect(outbox.counts().pending).toBe(1);
	});

	it('dois jobs de estado diferente convivem quando o primeiro já está em voo', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(1) });
		outbox.claimNext(linkId); // trava o estado atual em `in_flight`
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(0) });

		expect(id).not.toBeNull();
		expect(outbox.counts().in_flight).toBe(1);
		expect(outbox.counts().pending).toBe(1);
		// a nova geração carrega o estado mais recente
		expect(JSON.parse(outbox.list('pending')[0]!.payload).count).toBe(0);
	});

	it('estado novo nunca se perde quando as gerações se esgotam', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(0) });
		let last = 0;
		for (let i = 0; i < 12; i++) {
			outbox.claimNext(linkId); // cada volta trava a geração anterior em `in_flight`
			last = i + 1;
			outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(last) });
		}

		const live = [...outbox.list('pending'), ...outbox.list('in_flight')];
		// o estado mais recente está na fila: nada foi descartado
		expect(live.some((r) => JSON.parse(r.payload).count === last)).toBe(true);
		// as gerações nomeadas têm teto; o que passa dele entra com chave própria
		expect(live.filter((r) => /^r1#\d+$/.test(r.dedupe_key)).length).toBeLessThanOrEqual(8);
	});

	it('atualizações de embed com conteúdo diferente não são coalescidas', () => {
		const { outbox, linkId } = fixture();
		// o bridge deriva a chave do conteúdo: contagem igual, conteúdo diferente → chaves diferentes
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'edit', dedupeKey: 'papo-embeds:pm1:0:aaa', payload: { embeds: [{ description: 'a' }] } });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'edit', dedupeKey: 'papo-embeds:pm1:0:bbb', payload: { embeds: [{ description: 'b' }] } });
		expect(outbox.counts().pending).toBe(2);
	});

	it('criação e exclusão não são coalescidas', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'papo-create:pm1', payload: { a: 1 } });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'delete', dedupeKey: 'papo-delete:pm1', payload: { a: 1 } });
		expect(outbox.counts().pending).toBe(2);
	});

	it('job concluído não bloqueia um novo estado', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(1) });
		outbox.complete(outbox.claimNext(linkId)!.id);
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'reaction', dedupeKey: 'r1', payload: reaction(0) });
		expect(outbox.counts().pending).toBe(1);
		expect(JSON.parse(outbox.list('pending')[0]!.payload).count).toBe(0);
	});

	it('o índice único parcial permite o mesmo dedupe_key depois de concluído', () => {
		const { db, outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} });
		outbox.complete(outbox.claimNext(linkId)!.id);
		expect(() =>
			db.prepare('INSERT INTO outbox (link_id, direction, kind, dedupe_key, payload) VALUES (?,?,?,?,?)').run(linkId, 'to_discord', 'message', 'k', '{}')
		).not.toThrow();
		expect(outbox.counts().pending).toBe(1);
		expect(outbox.counts().done).toBe(1);
	});
});

describe('P2.2: reivindicar atômico', () => {
	it('duas reivindicações simultâneas nunca devolvem o mesmo job', () => {
		const { outbox, linkId } = fixture();
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k1', payload: {} });
		outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k2', payload: {} });

		const claimed = [outbox.claimNext(linkId)!.id, outbox.claimNext(linkId)!.id];
		expect(new Set(claimed).size).toBe(2);
		expect(outbox.counts().in_flight).toBe(2);
		expect(outbox.counts().pending).toBe(0);
	});

	it('reivindicação não toca em job que ainda não está disponível', () => {
		const { outbox, linkId } = fixture();
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} })!;
		outbox.claimNext(linkId);
		outbox.fail(id, 'HTTP 503', false);
		expect(outbox.claimNext(linkId)).toBeUndefined();
		expect(outbox.counts().pending).toBe(1);
	});
});

describe('tentativas que podem ter criado algo remoto', () => {
	it('marca a tentativa remota antes da entrega e sobrevive ao retry', () => {
		const { outbox, linkId } = fixture();
		const id = outbox.enqueue({ linkId, direction: 'to_discord', kind: 'message', dedupeKey: 'k', payload: {} })!;
		expect(outbox.remoteAttempts(id)).toBe(0);

		outbox.claimNext(linkId);
		outbox.markRemoteAttempt(id);
		expect(outbox.remoteAttempts(id)).toBe(1);
		outbox.fail(id, 'timeout depois de criar', false);

		outbox.claimNext(linkId, new Date(Date.now() + 60_000));
		expect(outbox.remoteAttempts(id)).toBe(1);
		outbox.markRemoteAttempt(id);
		expect(outbox.remoteAttempts(id)).toBe(2);
	});
});
