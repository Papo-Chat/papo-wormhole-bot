import { createHash } from 'node:crypto';
import { clampText } from './limits.js';

/**
 * Assinatura da cópia.
 *
 * A reconciliação de um envio cujo resultado é incerto precisa reconhecer NO destino a
 * cópia que aquele job criou. O rodapé com data arredondada ao minuto não serve: duas
 * mensagens diferentes criadas no mesmo minuto produzem o mesmo rodapé, e a busca acertaria
 * a cópia errada. A assinatura é derivada do que identifica a origem — lado, id da mensagem
 * de origem, chunk e grupo de anexos — então cada cópia tem um selo próprio, determinístico
 * (o retry reproduz a mesma assinatura) e impossível de confundir com outra mensagem.
 */
export const SIGNATURE_LENGTH = 6;

const signatureOf = (side: 'papo' | 'discord', sourceMessageId: string, chunkIndex: number, group: number): string =>
	`#${createHash('sha256').update(`${side}:${sourceMessageId}:${chunkIndex}:${group}`).digest('hex').slice(0, SIGNATURE_LENGTH)}`;

/** Selo de uma cópia: origem + chunk de texto + grupo de anexos. */
export const copySignature = (
	side: 'papo' | 'discord',
	sourceMessageId: string,
	chunkIndex: number,
	group = 0
): string => signatureOf(side, sourceMessageId, chunkIndex, group);

/** Selos de todos os grupos de anexos de um chunk (a ordem dos grupos é determinística). */
export const copySignatures = (
	side: 'papo' | 'discord',
	sourceMessageId: string,
	chunkIndex: number,
	groups: number
): string[] => Array.from({ length: Math.max(1, groups) }, (_, g) => signatureOf(side, sourceMessageId, chunkIndex, g));

/**
 * Rodapé assinado. O selo entra por último e nunca é cortado: o que estoura é a base, não a
 * assinatura — sem ela a reconciliação fica cega.
 */
export const signedFooter = (base: string, signature: string, max: number): string => {
	const room = Math.max(0, max - Array.from(signature).length - 3);
	return `${clampText(base, room)} · ${signature}`;
};

/** Assinatura presente num rodapé (usado na reconciliação e em testes). */
export function signatureFromFooter(footer?: string | null): string | undefined {
	if (!footer) return undefined;
	const m = /(#[0-9a-f]{6})(?:\s*$|$)/.exec(footer.trim());
	return m?.[1];
}
