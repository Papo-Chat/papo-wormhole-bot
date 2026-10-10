import { describe, expect, it } from 'vitest';
import { SIGNATURE_LENGTH, copySignature, copySignatures, signatureFromFooter, signedFooter } from '../src/bridge/signature.js';

/**
 * P1.1: a reconciliação de um envio incerto reconhece a cópia pela assinatura do rodapé.
 * Duas mensagens diferentes criadas no mesmo minuto têm o mesmo rodapé datado — só o selo
 * derivado da origem as distingue.
 */

describe('copySignature', () => {
	it('é determinística: o mesmo job produz o mesmo selo no retry', () => {
		expect(copySignature('papo', 'pm1', 0, 0)).toBe(copySignature('papo', 'pm1', 0, 0));
		expect(copySignature('papo', 'pm1', 0)).toBe(copySignature('papo', 'pm1', 0, 0));
	});

	it('distingue mensagens diferentes do mesmo minuto', () => {
		expect(copySignature('papo', 'pm1', 0)).not.toBe(copySignature('papo', 'pm2', 0));
	});

	it('distingue chunk, grupo de anexos e lado', () => {
		const base = copySignature('papo', 'pm1', 0, 0);
		expect(copySignature('papo', 'pm1', 1, 0)).not.toBe(base);
		expect(copySignature('papo', 'pm1', 0, 1)).not.toBe(base);
		expect(copySignature('discord', 'pm1', 0, 0)).not.toBe(base);
	});

	it('é um selo curto e estável', () => {
		const signature = copySignature('papo', 'pm1', 0);
		expect(signature).toMatch(/^#[0-9a-f]{6}$/);
		expect(signature.length).toBe(SIGNATURE_LENGTH + 1);
	});
});

describe('copySignatures', () => {
	it('devolve um selo por grupo de anexos, sem repetição', () => {
		const signatures = copySignatures('papo', 'pm1', 0, 3);
		expect(signatures).toHaveLength(3);
		expect(new Set(signatures).size).toBe(3);
	});

	it('uma mensagem sem anexos tem um selo (o grupo único)', () => {
		expect(copySignatures('papo', 'pm1', 0, 0)).toEqual([copySignature('papo', 'pm1', 0, 0)]);
	});
});

describe('signedFooter', () => {
	it('acrescenta o selo ao rodapé', () => {
		expect(signedFooter('🕒 18:09 · Papo', '#abc123', 2048)).toBe('🕒 18:09 · Papo · #abc123');
	});

	it('o que estoura é a base: o selo nunca é cortado', () => {
		const footer = signedFooter('🕒 '.repeat(200), '#abc123', 40);
		expect(Array.from(footer).length).toBeLessThanOrEqual(40);
		expect(footer.endsWith('#abc123')).toBe(true);
	});

	it('o selo sobrevive ao corte e continua reconhecível', () => {
		const footer = signedFooter('a'.repeat(5000), '#abc123', 60);
		expect(signatureFromFooter(footer)).toBe('#abc123');
	});
});

describe('signatureFromFooter', () => {
	it('lê o selo do rodapé', () => {
		expect(signatureFromFooter('🕒 18:09 · Papo · #abc123')).toBe('#abc123');
	});

	it('ignora texto que não tem selo', () => {
		expect(signatureFromFooter('🕒 18:09 · Papo')).toBeUndefined();
		expect(signatureFromFooter(undefined)).toBeUndefined();
		expect(signatureFromFooter('')).toBeUndefined();
	});
});
