import { clampText } from './limits.js';

export interface ReactionDisplay {
	/** Unicode (👍) ou nome de emoji custom (:nome:) — footer não renderiza emoji custom. */
	emoji: string;
	count: number;
}

/** `👍 3 · ❤️ 1 · :papu: 2` (mais usados primeiro). */
export const reactionSummaryText = (rows: ReactionDisplay[], maxEmojis = 8): string =>
	rows
		.filter((r) => r.count > 0)
		.slice()
		.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji))
		.slice(0, maxEmojis)
		.map((r) => `${r.emoji} ${r.count}`)
		.join(' · ');

/**
 * Mescla as contagens observadas nos dois lados do par bridgeado.
 * O mesmo emoji vale a maior contagem: a reação-eco do bridge (1) nunca supera a contagem real.
 */
export const mergeReactionCounts = (sides: ReactionDisplay[][]): ReactionDisplay[] => {
	const merged = new Map<string, number>();
	for (const side of sides) {
		for (const r of side) {
			if (r.count <= 0) continue;
			merged.set(r.emoji, Math.max(merged.get(r.emoji) ?? 0, r.count));
		}
	}
	return [...merged]
		.map(([emoji, count]) => ({ emoji, count }))
		.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
};

/** Rodapé do embed de destino: base + resumo de reações, dentro do limite de footer. */
export const footerWithReactions = (
	base: string,
	rows: ReactionDisplay[],
	maxChars: number,
	maxEmojis = 8
): string => {
	const summary = reactionSummaryText(rows, maxEmojis);
	return clampText(summary ? `${base} · ${summary}` : base, maxChars);
};
