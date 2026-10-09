import { describe, expect, it } from 'vitest';
import { footerWithReactions, mergeReactionCounts, reactionSummaryText } from '../src/bridge/reactions.js';

describe('reactionSummaryText', () => {
	it('ordena por contagem e separa com ·', () => {
		expect(reactionSummaryText([{ emoji: '❤️', count: 1 }, { emoji: '👍', count: 3 }])).toBe('👍 3 · ❤️ 1');
	});

	it('ignora contagem zero', () => {
		expect(reactionSummaryText([{ emoji: '👍', count: 0 }])).toBe('');
	});

	it('limita a quantidade de emojis exibidos', () => {
		const rows = Array.from({ length: 12 }, (_, i) => ({ emoji: `${i}`, count: 100 - i }));
		expect(reactionSummaryText(rows, 8).split(' · ').length).toBe(8);
	});
});

describe('mergeReactionCounts', () => {
	it('mescla os dois lados do par e fica com a maior contagem', () => {
		const merged = mergeReactionCounts([
			[
				{ emoji: '👍', count: 3 },
				{ emoji: ':papu:', count: 1 }
			],
			[
				{ emoji: '👍', count: 1 },
				{ emoji: '❤️', count: 2 }
			]
		]);
		expect(merged).toEqual([
			{ emoji: '👍', count: 3 },
			{ emoji: '❤️', count: 2 },
			{ emoji: ':papu:', count: 1 }
		]);
	});

	it('o eco do bridge (1) não cria contagem fantasma', () => {
		expect(mergeReactionCounts([[{ emoji: '👍', count: 1 }], []])).toEqual([{ emoji: '👍', count: 1 }]);
	});

	it('descarta contagem zero', () => {
		expect(mergeReactionCounts([[{ emoji: '👍', count: 0 }], [{ emoji: '👍', count: 0 }]])).toEqual([]);
	});
});

describe('footerWithReactions', () => {
	it('anexa o resumo ao rodapé base', () => {
		expect(footerWithReactions('🕒 09/10/2026 · Papo', [{ emoji: '👍', count: 2 }], 2048)).toBe(
			'🕒 09/10/2026 · Papo · 👍 2'
		);
	});

	it('mantém o rodapé intacto sem reações', () => {
		expect(footerWithReactions('🕒 09/10/2026 · Papo 1/2', [], 2048)).toBe('🕒 09/10/2026 · Papo 1/2');
	});

	it('nunca ultrapassa o limite de footer', () => {
		const rows = Array.from({ length: 8 }, (_, i) => ({ emoji: '👍'.repeat(30), count: i + 1 }));
		const out = footerWithReactions('base', rows, 60, 8);
		// clampText conta code points: emoji de surrogate pair ocupa 2 unidades em .length
		expect(Array.from(out).length).toBeLessThanOrEqual(60);
		expect(out.endsWith('…')).toBe(true);
	});
});
