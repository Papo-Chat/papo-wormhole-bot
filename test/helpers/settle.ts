import type { Outbox } from '../../src/db/outbox.js';

/**
 * Espera a fila do bridge esvaziar.
 *
 * O refresh do resumo de reações é agendado depois da última mudança da mensagem, então
 * "quiet" precisa ser sustentado por um tempo — observar a fila vazia uma única vez faria
 * o teste devolver antes do refresh existir na fila.
 */
export async function settleQueue(outbox: Outbox, quietMs = 700, maxMs = 5000): Promise<void> {
	const until = Date.now() + maxMs;
	let quietSince = 0;
	while (Date.now() < until) {
		const counts = outbox.counts();
		const quiet = counts.in_flight === 0 && counts.pending === 0;
		if (quiet) {
			if (quietSince === 0) quietSince = Date.now();
			if (Date.now() - quietSince >= quietMs) return;
		} else {
			quietSince = 0;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
}
