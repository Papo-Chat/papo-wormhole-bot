/**
 * Chunking de texto longo preservando markdown.
 *
 * Regras:
 * - empacota linha a linha (o corte cai em quebra de linha, normalmente borda de parágrafo);
 * - nunca corta dentro de um code fence sem fechar a cerca no fim do chunk e reabri-la no
 *   chunk seguinte com a mesma linguagem;
 * - nunca parte surrogate pairs (Array.from → code points);
 * - o custo das cercas (fechamento no chunk atual + reabertura no próximo) é descontado
 *   do limite, então nenhum chunk ultrapassa `limit`.
 */

const FENCE = '```';

interface LineInfo {
	text: string;
	/** Cerca aberta após esta linha (undefined = fora de fence). */
	openAfter?: string;
}

function scanLines(text: string): LineInfo[] {
	const out: LineInfo[] = [];
	let open: string | null = null;
	for (const raw of text.split('\n')) {
		const trimmed = raw.trimStart();
		const isDelimiter = trimmed.startsWith(FENCE) || trimmed.startsWith('~~~');
		if (isDelimiter) {
			if (open === null) {
				const info = trimmed.slice(3).trim();
				out.push({ text: raw, openAfter: info });
				open = info;
			} else {
				out.push({ text: raw });
				open = null;
			}
			continue;
		}
		out.push({ text: raw, openAfter: open ?? undefined });
	}
	return out;
}

/**
 * Limite de uma linha que vive dentro de um fence: é preciso caber a reabertura
 * (``` + info + newline) e o fechamento (newline + ```).
 */
const fenceLimit = (max: number, info: string | undefined): number =>
	info === undefined ? max : Math.max(8, max - info.length - 8);

/** Corte duro de uma linha gigante, respeitando code points. */
function hardCut(line: LineInfo, limit: number): LineInfo[] {
	const chars = Array.from(line.text);
	const pieces: LineInfo[] = [];
	for (let i = 0; i < chars.length; ) {
		const remaining = chars.length - i;
		const take = remaining <= limit ? limit : limit - 1; // espaço para a elipse
		const slice = chars.slice(i, i + take);
		i += take;
		pieces.push({ text: slice.join('') + (i >= chars.length ? '' : '…'), openAfter: line.openAfter });
	}
	return pieces;
}

export function chunkText(text: string, limit: number): string[] {
	const max = Math.max(32, limit);
	if (!text) return [];

	const chunks: string[] = [];
	let buf: LineInfo[] = [];
	let len = 0;
	/** Cerca reaberta no início do próximo chunk (quando o corte atravessou um fence). */
	let pendingOpener: string | undefined;

	const openFence = (): string | undefined => buf[buf.length - 1]?.openAfter;

	const emit = (): void => {
		if (!buf.length) return;
		const open = openFence();
		const lines = pendingOpener !== undefined ? [pendingOpener, ...buf.map((l) => l.text)] : buf.map((l) => l.text);
		let body = lines.join('\n');
		if (open !== undefined) body += `\n${FENCE}`;
		chunks.push(body);
		pendingOpener = open !== undefined ? `${FENCE}${open}` : undefined;
		buf = [];
		len = 0;
	};

	for (const line of scanLines(text)) {
		const cap = fenceLimit(max, line.openAfter);
		const pieces = Array.from(line.text).length > cap ? hardCut(line, cap) : [line];
		for (const piece of pieces) {
			// custo de fechar a cerca que ainda estará aberta DEPOIS de adicionar esta linha
			const closeCost = piece.openAfter === undefined ? 0 : FENCE.length + 1;
			const openerCost = pendingOpener === undefined ? 0 : pendingOpener.length + 1;
			const cost = piece.text.length + (buf.length ? 1 : 0);
			if (buf.length && openerCost + len + cost + closeCost > max) emit();
			buf.push(piece);
			len += piece.text.length + (buf.length > 1 ? 1 : 0);
		}
	}
	emit();

	return chunks.filter((c) => c.trim().length > 0);
}

/** Sufixo de identificação para mensagens particionadas. */
export const chunkLabel = (index: number, total: number): string => (total > 1 ? ` ${index + 1}/${total}` : '');
