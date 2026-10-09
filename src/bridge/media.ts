import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db/store.js';

const EXT_BY_MIME: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/gif': 'gif',
	'video/mp4': 'mp4',
	'video/webm': 'webm',
	'application/gzip': 'gz',
	'application/octet-stream': 'bin'
};

const MIME_BY_EXT: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	mp4: 'video/mp4',
	webm: 'video/webm',
	gz: 'application/gzip',
	bin: 'application/octet-stream'
};

export const guessExt = (mime?: string | null): string => (mime && EXT_BY_MIME[mime]) ?? 'bin';
export const guessMime = (ext: string): string => MIME_BY_EXT[ext] ?? 'application/octet-stream';

/** Cache de mídia em disco, endereçado por sha256 (content-addressable). */
export class MediaStore {
	private readonly dir: string;

	constructor(
		private store: Store,
		dataDir: string
	) {
		this.dir = join(dataDir, 'media');
		mkdirSync(this.dir, { recursive: true });
	}

	save(data: Buffer, mime?: string | null, source?: string): { sha256: string; path: string; ext: string } {
		const sha256 = createHash('sha256').update(data).digest('hex');
		const ext = guessExt(mime);
		const path = join(this.dir, `${sha256}.${ext}`);
		if (!existsSync(path)) writeFileSync(path, data);
		this.store.upsertMedia({ sha256, path, mime: mime ?? undefined, sizeBytes: data.length, source });
		return { sha256, path, ext };
	}

	pathFor(sha256: string): string | undefined {
		const row = this.store.getMedia(sha256);
		if (row && existsSync(row.path)) return row.path;
		for (const ext of Object.keys(MIME_BY_EXT)) {
			const candidate = join(this.dir, `${sha256}.${ext}`);
			if (existsSync(candidate)) return candidate;
		}
		return undefined;
	}

	/** URL pública do arquivo (quando o bot tem base URL configurada). */
	urlFor(sha256: string, publicBaseUrl?: string): string | undefined {
		if (!publicBaseUrl) return undefined;
		const row = this.store.getMedia(sha256);
		const ext = row?.path ? row.path.split('.').pop() ?? 'bin' : 'bin';
		return `${publicBaseUrl}/media/${sha256}.${ext}`;
	}
}

/**
 * Servidor estático que expõe o cache de mídia.
 * Necessário porque o Discord exige `author.icon_url` como URL absoluta.
 */
export function startMediaServer(store: MediaStore, port: number): Server {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (url.pathname === '/healthz') {
			res.writeHead(200, { 'content-type': 'text/plain' }).end('OK');
			return;
		}
		const m = /^\/media\/([0-9a-f]{64})\.([a-z0-9]+)$/.exec(url.pathname);
		if (!m) {
			res.writeHead(404).end();
			return;
		}
		const sha = m[1]!;
		const ext = m[2]!;
		const path = store.pathFor(sha);
		if (!path) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, {
			'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
			'cache-control': 'public, max-age=31536000, immutable',
			'content-disposition': `inline; filename="${sha}.${ext}"`
		});
		createReadStream(path).pipe(res);
	});
	server.listen(port);
	return server;
}
