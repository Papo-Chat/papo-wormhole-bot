import { clampText } from './limits.js';

export interface ReactionDisplay {
	/** Unicode (👍) ou nome de emoji custom (:nome:) — footer não renderiza emoji custom. */
	emoji: string;
	count: number;
}

/**
 * `👍 3 · <:papu:123> 2` (mais usados primeiro).
 * `tokenFor` converte o emoji para o dialeto do destino: só o `description` do embed
 * renderiza custom emoji, e cada lado tem o seu (`<:nome:id>` no Discord, `:nome:` no Papo).
 */
export const reactionSummaryText = (
	rows: ReactionDisplay[],
	maxEmojis = 8,
	tokenFor?: (emoji: string) => string
): string =>
	rows
		.filter((r) => r.count > 0)
		.slice()
		.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji))
		.slice(0, maxEmojis)
		.map((r) => `${tokenFor?.(r.emoji) ?? r.emoji} ${r.count}`)
		.join(' · ');

/**
 * Mescla as contagens observadas nos dois lados do par bridgeado somando-as.
 * Cada lado guarda apenas a contagem humana daquela mensagem (a reação-eco do
 * bridge é descontada pelo registro em `mirror_reactions` antes de gravar),
 * então as pessoas dos dois lados são conjuntos disjuntos: 3 no Discord + 2 no
 * Papo = 5. Usar o máximo entre os lados perdia as reações do lado menor.
 */
export const mergeReactionCounts = (sides: ReactionDisplay[][]): ReactionDisplay[] => {
	const merged = new Map<string, number>();
	for (const side of sides) {
		for (const r of side) {
			if (r.count <= 0) continue;
			merged.set(r.emoji, (merged.get(r.emoji) ?? 0) + r.count);
		}
	}
	return [...merged]
		.map(([emoji, count]) => ({ emoji, count }))
		.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
};
