import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzip, partition, tar, tarGz } from '../src/bridge/tar.js';

interface TarEntryRead {
	name: string;
	size: number;
	data: Buffer;
}

/** Leitor USTAR mínimo para validar o que o writer produz. */
function readTar(buf: Buffer): TarEntryRead[] {
	const out: TarEntryRead[] = [];
	for (let offset = 0; offset + 512 <= buf.length; ) {
		const header = buf.subarray(offset, offset + 512);
		if (header.every((b) => b === 0)) break;

		const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
		const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
		const size = Number.parseInt(sizeText, 8);
		const storedChecksum = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8);

		// checksum: campo de checksum tratado como espaços
		const copy = Buffer.from(header);
		copy.fill(0x20, 148, 156);
		let sum = 0;
		for (const b of copy) sum += b;

		const data = buf.subarray(offset + 512, offset + 512 + size);
		out.push({ name, size, data });
		offset += 512 + Math.ceil(size / 512) * 512;

		expect(storedChecksum, `checksum de ${name}`).toBe(sum);
	}
	return out;
}

describe('tar', () => {
	it('escreve entradas com nome, tamanho e conteúdo corretos', () => {
		const buf = tar([
			{ name: 'a.txt', data: Buffer.from('hello') },
			{ name: 'b.bin', data: Buffer.alloc(1500, 7) }
		]);
		const entries = readTar(buf);
		expect(entries.map((e) => e.name)).toEqual(['a.txt', 'b.bin']);
		expect(entries[0]!.data.toString()).toBe('hello');
		expect(entries[1]!.size).toBe(1500);
		expect(entries[1]!.data.every((b) => b === 7)).toBe(true);
	});

	it('termina com dois blocos de zeros', () => {
		const buf = tar([{ name: 'a', data: Buffer.from('x') }]);
		expect(buf.length % 512).toBe(0);
		expect(buf.subarray(buf.length - 1024).every((b) => b === 0)).toBe(true);
	});
});

describe('tarGz', () => {
	it('round-trip: descompacta e recupera o arquivo original', () => {
		const original = Buffer.from('conteúdo de texto '.repeat(200));
		const packed = gunzipSync(tarGz([{ name: 'grande.txt', data: original }]));
		const [entry] = readTar(packed);
		expect(entry?.name).toBe('grande.txt');
		expect(entry?.data.equals(original)).toBe(true);
	});
});

describe('gzip', () => {
	it('comprime texto de forma reversível', () => {
		const original = Buffer.from('abc'.repeat(5000));
		const gz = gzip(original);
		expect(gz.length).toBeLessThan(original.length);
		expect(gunzipSync(gz).equals(original)).toBe(true);
	});
});

describe('partition', () => {
	it('divide em partes do tamanho pedido com nomes sequenciais', () => {
		const data = Buffer.alloc(10_000, 1);
		const parts = partition(data, 4000, 'video.mp4');
		expect(parts.map((p) => p.name)).toEqual(['video.mp4.part001', 'video.mp4.part002', 'video.mp4.part003']);
		expect(parts.reduce((acc, p) => acc + p.data.length, 0)).toBe(data.length);
		expect(Buffer.concat(parts.map((p) => p.data)).equals(data)).toBe(true);
	});

	it('usa largura de dígito suficiente para muitas partes', () => {
		const parts = partition(Buffer.alloc(105_000), 1000, 'a.bin');
		expect(parts.length).toBe(105);
		expect(parts[104]!.name).toBe('a.bin.part105');
	});
});
