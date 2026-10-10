import { afterEach, describe, expect, it, vi } from 'vitest';
import { GiphyResolver, giphyId, giphyMediaUrl, giphyPageUrl } from '../src/bridge/giphy.js';

/**
 * O picker do Papo é do lado do cliente: a mensagem chega como `content = giphy:<id>`.
 * O Discord não conhece o marcador, então a ponte resolve o id em imagem. Sem chave de API
 * a URL direta do slug é usada; com chave, a API do Giphy decide a imagem.
 */

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('giphyId', () => {
	it('reconhece o marcador do picker', () => {
		expect(giphyId('giphy:3oEdV9QtPEA95')).toBe('3oEdV9QtPEA95');
		expect(giphyId('  giphy:abc-123_x  ')).toBe('abc-123_x');
	});

	it('não confunde texto comum com marcador', () => {
		expect(giphyId('olá')).toBeUndefined();
		expect(giphyId('giphy:')).toBeUndefined();
		expect(giphyId('veja giphy:abc')).toBeUndefined();
		expect(giphyId('giphy:abc extra')).toBeUndefined();
		expect(giphyId(null)).toBeUndefined();
	});
});

describe('URLs do marcador', () => {
	it('a mídia é o slug do Giphy (o mesmo que o frontend usa)', () => {
		expect(giphyMediaUrl('3oEdV9QtPEA95')).toBe('https://media.giphy.com/media/3oEdV9QtPEA95/giphy.gif');
		expect(giphyPageUrl('3oEdV9QtPEA95')).toBe('https://giphy.com/gifs/3oEdV9QtPEA95');
	});
});

describe('GiphyResolver', () => {
	it('sem chave usa a URL direta do slug (o GIF aparece mesmo sem API)', async () => {
		const gif = await new GiphyResolver().resolve('3oEdV9QtPEA95');
		expect(gif.url).toBe('https://media.giphy.com/media/3oEdV9QtPEA95/giphy.gif');
		expect(gif.pageUrl).toBe('https://giphy.com/gifs/3oEdV9QtPEA95');
	});

	it('com chave aproveita a imagem original da API', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						data: {
							id: 'abc',
							title: 'Gato dançando',
							images: { original: { url: 'https://media.giphy.com/media/abc/giphy.gif' } }
						}
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
			)
		);
		const gif = await new GiphyResolver('chave').resolve('abc');
		expect(gif).toEqual({
			id: 'abc',
			url: 'https://media.giphy.com/media/abc/giphy.gif',
			pageUrl: 'https://giphy.com/gifs/abc',
			title: 'Gato dançando'
		});
	});

	it('a API falhando não derruba a ponte: cai na URL direta do slug', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
		const gif = await new GiphyResolver('chave').resolve('abc');
		expect(gif.url).toBe('https://media.giphy.com/media/abc/giphy.gif');
		expect(gif.title).toBe('GIF');
	});

	it('resolve o mesmo id uma única vez', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ data: { id: 'abc', images: { original: { url: 'https://x/g.gif' } } } }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const resolver = new GiphyResolver('chave');
		const [a, b] = await Promise.all([resolver.resolve('abc'), resolver.resolve('abc')]);
		expect(a).toBe(b);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rede que cai não derruba a ponte: o slug do Giphy é a URL estável do GIF', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('rede caiu');
			})
		);
		const resolver = new GiphyResolver('chave');
		const gif = await resolver.resolve('abc');
		expect(gif.url).toBe('https://media.giphy.com/media/abc/giphy.gif');
	});
});
