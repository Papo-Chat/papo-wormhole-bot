import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/bridge/chunk.js';

/** Confere se todas as cercas de código estão balanceadas dentro do chunk. */
const balanced = (text: string): boolean => {
	let open = 0;
	for (const line of text.split('\n')) {
		if (line.trimStart().startsWith('```')) open = open === 0 ? 1 : 0;
	}
	return open === 0;
};

describe('chunkText', () => {
	it('retorna vazio para texto vazio', () => {
		expect(chunkText('', 100)).toEqual([]);
		expect(chunkText('   \n\n  ', 100)).toEqual([]);
	});

	it('mantém texto curto em um único chunk', () => {
		expect(chunkText('olá mundo', 100)).toEqual(['olá mundo']);
	});

	it('corta em quebra de linha quando passa do limite', () => {
		const text = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10), 'd'.repeat(10)].join('\n');
		const chunks = chunkText(text, 32);
		expect(chunks.length).toBe(2);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(32);
		expect(chunks.join('\n')).toBe(text);
	});

	it('fecha e reabre code fence ao cortar dentro dele', () => {
		const text = ['```ts', 'const a = 1;', 'const b = 2;', 'const c = 3;', '```'].join('\n');
		const chunks = chunkText(text, 32);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(balanced(c), c).toBe(true);
			expect(c.length, c).toBeLessThanOrEqual(32);
		}
		const body = chunks.join('\n').replace(/```[a-zA-Z]*/g, '');
		expect(body).toContain('const a = 1;');
		expect(body).toContain('const c = 3;');
	});

	it('preserva a linguagem do fence no chunk de continuação', () => {
		const text = ['```python', 'print("1234567890")', 'print("0987654321")', '```'].join('\n');
		const chunks = chunkText(text, 40);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[1]!.startsWith('```python')).toBe(true);
		for (const c of chunks) expect(balanced(c), c).toBe(true);
	});

	it('não deixa texto após o fechamento do fence dentro do bloco de código', () => {
		const text = ['```js', 'let x = "0123456789";', '```', 'texto depois'].join('\n');
		const chunks = chunkText(text, 32);
		for (const c of chunks) {
			expect(balanced(c), c).toBe(true);
			expect(c.length, c).toBeLessThanOrEqual(32);
		}
		const last = chunks[chunks.length - 1]!;
		expect(last).toContain('texto depois');
		expect(balanced(last)).toBe(true);
	});

	it('corta linhas gigantes por code points sem partir surrogate pair', () => {
		const text = '😀'.repeat(100);
		const chunks = chunkText(text, 64);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect(c).not.toContain('\uFFFD');
			expect(Array.from(c).length).toBeLessThanOrEqual(64);
		}
		const recovered = chunks.join('').replace(/…/g, '');
		expect(recovered).toBe(text);
	});

	it('respeita o limite mesmo com fences que exigem reabertura', () => {
		const text = ['```', 'a'.repeat(50), 'b'.repeat(50), '```'].join('\n');
		const chunks = chunkText(text, 40);
		for (const c of chunks) {
			expect(c.length, c).toBeLessThanOrEqual(40);
			expect(balanced(c), c).toBe(true);
		}
		expect(chunks.join('\n').replace(/```/g, '')).toContain('a'.repeat(31));
	});

	it('nunca produz chunk vazio', () => {
		const chunks = chunkText('\n\n\na\n\n\n', 100);
		expect(chunks.length).toBe(1);
		expect(chunks[0]!.trim().length).toBeGreaterThan(0);
	});

	it('chunk grande de texto real fica dentro do limite do Discord', () => {
		const text = Array.from({ length: 200 }, (_, i) => `linha ${i} de um parágrafo comprido o suficiente`).join('\n');
		const chunks = chunkText(text, 3600);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3600);
		expect(chunks.join('\n')).toBe(text);
	});

	it('não duplica fence quando o fechamento está grudado no fim da última linha', () => {
		// O Papo aceita ```\ncode```; o chunker não pode tratar a fence como aberta.
		const chunks = chunkText('```js\ncode```', 2000);
		expect(chunks).toEqual(['```js\ncode\n```']);
	});

	it('normaliza fence grudada na abertura e no fechamento', () => {
		const chunks = chunkText('```{"ok":true}```', 2000);
		expect(chunks).toEqual(['```\n{"ok":true}\n```']);
	});

	it('mantém o texto após uma fence grudada fora do bloco de código', () => {
		const chunks = chunkText('antes ```x``` depois', 2000);
		expect(chunks).toEqual(['antes \n```\nx\n```\n depois']);
	});

	it('fecha fence genuinamente aberta sem duplicar a última linha', () => {
		const chunks = chunkText('```js\ncode', 2000);
		expect(chunks).toEqual(['```js\ncode\n```']);
	});

	it('não deixa backtick órfão ao cortar linha gigante com código inline', () => {
		const text = 'a'.repeat(25) + ' `inline` ' + 'b'.repeat(25);
		const chunks = chunkText(text, 32);
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) {
			expect((c.match(/`/g) ?? []).length % 2, c).toBe(0);
			expect(Array.from(c).length, c).toBeLessThanOrEqual(32);
		}
	});

	it('mantém span inline curto inteiro quando o corte cairia dentro dele', () => {
		const text = 'a'.repeat(25) + ' `inline code maior` ' + 'b'.repeat(25);
		const chunks = chunkText(text, 32);
		expect(chunks.some((c) => c.includes('`inline code maior`')), chunks.join('\n')).toBe(true);
		for (const c of chunks) expect((c.match(/`/g) ?? []).length % 2, c).toBe(0);
	});
});
