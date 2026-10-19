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

describe('capitalização de emojis do Discord', () => {
	it('preserva a capitalização no upload e no shortcode após importar', async () => {
		const { bridge, createdNames } = makeBridge();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(Buffer.from('png'), { status: 200 });
		try {
			const shortcode = await bridge.shortcodeForPapo('MeuEmoji', '123', false);
			expect(createdNames).toEqual(['MeuEmoji']);
			expect(shortcode).toBe(':MeuEmoji:');
			// O tradutor também consegue recuperar o nome original após a gravação no mapa persistente.
			expect(bridge.papoNameForDiscord('MeuEmoji')).toBe('MeuEmoji');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('normaliza apenas a busca e preserva o nome original do emoji existente', async () => {
		const { bridge, createdNames } = makeBridge({ emojis: [{ id: 'existing', name: 'mEuEmOjI' }] });
		expect(await bridge.shortcodeForPapo('MeuEmoji', '123', false)).toBe(':mEuEmOjI:');
		expect(createdNames).toHaveLength(0);
	});

	it('se o upload falha, mantém a capitalização no shortcode literal', async () => {
		const { bridge } = makeBridge();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(null, { status: 503 });
		try {
			expect(await bridge.shortcodeForPapo('MeuEmoji', '123', false)).toBe(':MeuEmoji:');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('mantém a regra de não importar quando autoImport está desabilitado', async () => {
		const { bridge } = makeBridge({ autoImport: false });
		expect(await bridge.shortcodeForPapo('MeuEmoji', '123', false)).toBe(':MeuEmoji:');
	});
});
