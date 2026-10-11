import type { Logger } from 'pino';

/**
 * GIF do picker do Papo.
 *
 * O picker do Papo é do lado do cliente: a mensagem enviada tem `content` = `giphy:<id>` e o
 * frontend resolve o id na API do Giphy para desenhar o GIF. O Discord não conhece esse
 * marcador — bridgeado cru, viraria texto `giphy:3oEd…`. Por isso a ponte resolve o id em
 * imagem e envia o GIF como embed extra da cópia.
 *
 * O id do marcador é o slug do Giphy, o mesmo que forma a URL direta de mídia
 * (`https://media.giphy.com/media/<id>/giphy.gif`): sem chave de API a ponte usa essa URL.
 * Com `GIPHY_API_KEY` configurada, a resolução passa pela API e aproveita a URL original.
 */

export interface GiphyGif {
	id: string;
	/** Imagem animada (o que o Discord renderiza no embed). */
	url: string;
	/** Página do GIF (link clicável do embed). */
	pageUrl: string;
	title: string;
}

const MARKER_RE = /^giphy:([A-Za-z0-9_-]{1,80})$/;

/** Id do GIF quando o conteúdo é um marcador do picker (`giphy:<id>`). */
export const giphyId = (content?: string | null): string | undefined => MARKER_RE.exec(content?.trim() ?? '')?.[1];

export const giphyPageUrl = (id: string): string => `https://giphy.com/gifs/${encodeURIComponent(id)}`;
export const giphyMediaUrl = (id: string): string => `https://media.giphy.com/media/${id}/giphy.gif`;

interface GiphyApiResponse {
	data?: {
		id?: string;
		title?: string;
		images?: Record<string, { url?: string } | undefined>;
	};
}

export class GiphyResolver {
	private readonly cache = new Map<string, Promise<GiphyGif>>();

	constructor(
		private apiKey?: string,
		private log?: Logger
	) {}

	/** Resolução memoizada: a mesma mensagem não consulta o Giphy duas vezes. */
	resolve(id: string): Promise<GiphyGif> {
		const cached = this.cache.get(id);
		if (cached) return cached;
		const run = this.doResolve(id).catch((err) => {
			this.cache.delete(id);
			throw err;
		});
		this.cache.set(id, run);
		return run;
	}

	private async doResolve(id: string): Promise<GiphyGif> {
		const fallback: GiphyGif = { id, url: giphyMediaUrl(id), pageUrl: giphyPageUrl(id), title: 'GIF' };
		if (!this.apiKey) return fallback;
		try {
			const res = await fetch(
				`https://api.giphy.com/v1/gifs/${encodeURIComponent(id)}?api_key=${encodeURIComponent(this.apiKey)}`,
				{ signal: AbortSignal.timeout(30_000) }
			);
			if (!res.ok) throw new Error(`giphy ${res.status}`);
			const payload = (await res.json()) as GiphyApiResponse;
			const images = payload.data?.images;
			const image = images?.original ?? images?.downsized ?? images?.fixed_width;
			if (!image?.url) throw new Error('giphy sem imagem');
			return {
				id,
				url: image.url,
				pageUrl: giphyPageUrl(id),
				title: 'GIF'
			};
		} catch (err) {
			// a URL direta do slug é estável: sem ela o GIF simplesmente não aparece
			this.log?.warn({ err, id }, 'API do Giphy não respondeu: usando a URL direta do slug');
			return fallback;
		}
	}
}
