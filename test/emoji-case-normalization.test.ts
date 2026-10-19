import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { EmojiBridge } from '../src/bridge/emoji.js';

const makeBridge = (opts: {
	emojis?: { id: string; name: string; image_blob?: string }[];
	createEmoji?: (name: string) => Promise<{ id: string; name: string }>;
	autoImport?: boolean;
} = {}) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const createdNames: string[] = [];
	const api = {
		listAllEmojis: async () => opts.emojis ?? [],
		createEmoji: async (name: string) => {
			createdNames.push(name);
			return opts.createEmoji ? opts.createEmoji(name) : { id: 'new-id', name };
		}
	};
	const bridge = new EmojiBridge(api as never, store, { autoImport: opts.autoImport ?? true });
	return { bridge, store, createdNames };
};

describe('normalização de caixa na importação de emoji do Discord', () => {
	it('faz upload em lowercase e retorna shortcode compatível com o frontend do Papo', async () => {
		const { bridge, createdNames } = makeBridge();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(Buffer.from('png'), { status: 200 });
		try {
			const shortcode = await bridge.shortcodeForPapo('MeuEmoji', '123', false);
			expect(createdNames).toEqual(['meuemoji']);
			expect(shortcode).toBe(':meuemoji:');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('quando o emoji já existe, preserva a referência com o nome normalizado', async () => {
		const { bridge } = makeBridge({ emojis: [{ id: 'existing', name: 'MeuEmoji' }] });
		expect(await bridge.shortcodeForPapo('MeuEmoji', '123', false)).toBe(':meuemoji:');
	});

	it('se o upload falha, o shortcode literal também usa lowercase', async () => {
		const { bridge } = makeBridge();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(null, { status: 503 });
		try {
			expect(await bridge.shortcodeForPapo('MeuEmoji', '123', false)).toBe(':meuemoji:');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('mantém a regra de não importar quando autoImport está desabilitado', async () => {
		const { bridge } = makeBridge({ autoImport: false });
		expect(await bridge.shortcodeForPapo('MeuEmoji', '123', false)).toBe(':meuemoji:');
	});
});
