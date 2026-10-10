import { describe, expect, it } from 'vitest';
import { mergeReactionCounts, reactionSummaryText } from '../src/bridge/reactions.js';

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

describe('reactionSummaryText com dialeto de emoji', () => {
	it('converte o custom para o token do destino', () => {
		const out = reactionSummaryText(
			[
				{ emoji: '👍', count: 3 },
				{ emoji: ':papu:', count: 2 }
			],
			8,
			(emoji) => (emoji === ':papu:' ? '<:papu:123>' : emoji)
		);
		expect(out).toBe('👍 3 · <:papu:123> 2');
	});

	it('sem conversor mantém a forma canônica do banco', () => {
		expect(reactionSummaryText([{ emoji: ':papu:', count: 2 }])).toBe(':papu: 2');
	});

	it('nunca ultrapassa o limite de emojis mesmo com token expandido', () => {
		const rows = Array.from({ length: 12 }, (_, i) => ({ emoji: `:e${i}:`, count: 100 - i }));
		expect(reactionSummaryText(rows, 8, (e) => `<${e.slice(1, -1)}:1>`).split(' · ').length).toBe(8);
	});
});
