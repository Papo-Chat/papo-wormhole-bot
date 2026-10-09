import { gzipSync } from 'node:zlib';

/**
 * Escrita mínima de tar USTAR + gzip.
 * Usada para compactar/particionar arquivos que não cabem no limite do destino.
 */

const BLOCK = 512;

interface HeaderFields {
	name: string;
	size: number;
	mode: number;
	mtime: number;
}

function octal(value: number, length: number): string {
	const s = value.toString(8);
	return s.padStart(length - 1, '0') + '\0';
}

function buildHeader({ name, size, mode, mtime }: HeaderFields): Buffer {
	const header = Buffer.alloc(BLOCK, 0);
	const write = (text: string, offset: number, length: number) =>
		header.write(text.slice(0, length), offset, 'ascii');

	const fullName = name.length > 100 ? name.slice(-100) : name;
	write(fullName, 0, 100);
	write(octal(mode, 8), 100, 8);
	write(octal(0, 8), 108, 8); // uid
	write(octal(0, 8), 116, 8); // gid
	write(octal(size, 12), 124, 12);
	write(octal(Math.floor(mtime / 1000), 12), 136, 12);
	write('        ', 148, 8); // checksum placeholder (espaços)
	write('0', 156, 1); // typeflag: arquivo regular
	write('', 157, 100); // linkname
	write('ustar\0', 257, 6);
	write('00', 263, 2);
	write('wormhole', 265, 32);
	write('wormhole', 297, 32);
	write(octal(0, 8), 329, 8);
	write(octal(0, 8), 337, 8);
	write('', 345, 155);

	let sum = 0;
	for (const b of header) sum += b;
	write(octal(sum, 8), 148, 8);
	return header;
}

export interface TarEntry {
	name: string;
	data: Buffer;
}

export function tar(entries: TarEntry[]): Buffer {
	const parts: Buffer[] = [];
	for (const e of entries) {
		parts.push(buildHeader({ name: e.name, size: e.data.length, mode: 0o644, mtime: Date.now() }));
		parts.push(e.data);
		const remainder = e.data.length % BLOCK;
		if (remainder) parts.push(Buffer.alloc(BLOCK - remainder, 0));
	}
	parts.push(Buffer.alloc(BLOCK * 2, 0)); // bloco final de dois zeros
	return Buffer.concat(parts);
}

export function tarGz(entries: TarEntry[]): Buffer {
	return gzipSync(tar(entries), { level: 9 });
}

export function gzip(data: Buffer): Buffer {
	return gzipSync(data, { level: 9 });
}

/** Divide um buffer em partes de `size` bytes (nomes `base.part001`…). */
export function partition(data: Buffer, size: number, baseName: string): TarEntry[] {
	const total = Math.max(1, Math.ceil(data.length / size));
	const width = Math.max(3, String(total).length);
	const out: TarEntry[] = [];
	for (let i = 0; i < total; i++) {
		const slice = data.subarray(i * size, (i + 1) * size);
		out.push({ name: `${baseName}.part${String(i + 1).padStart(width, '0')}`, data: slice });
	}
	return out;
}

/** MIMEs que valem compressão (texto/código/documento). */
export function isCompressibleMime(mime?: string | null): boolean {
	if (!mime) return false;
	if (mime.startsWith('text/')) return true;
	if (mime.startsWith('application/json')) return true;
	if (mime.startsWith('application/xml')) return true;
	if (mime.startsWith('application/javascript')) return true;
	if (mime.startsWith('application/x-httpd-php')) return true;
	if (/\.(txt|md|csv|json|xml|ya?ml|log|sql|ts|js|go|c|h|py|sh|ini|conf)$/i.test(mime)) return true;
	return false;
}
