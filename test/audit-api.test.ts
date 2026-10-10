import { afterEach, describe, expect, it, vi } from 'vitest';
import { PapoApi } from '../src/papo/api.js';
import { PapoApiError } from '../src/papo/types.js';

/**
 * P1.4: recuperação de sessão do Papo.
 * `refresh` só é sucesso quando o backend aceitou, e a recuperação é serializada.
 */

const problem = (status: number, detail = 'sessão inválida') =>
	JSON.stringify({ type: 'https://papo.example.com/errors/expired', title: 'Erro', status, detail });

interface Handlers {
	whoami?: number;
	refresh?: number;
	login?: number;
}

/** Instala um fetch falso que conta as rotas chamadas. */
function stubServer(statuses: Handlers): { calls: string[] } {
	const calls: string[] = [];
	const remaining: Handlers = { whoami: 200, refresh: 200, login: 200, ...statuses };
	let whoamiCalls = 0;
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: URL | string) => {
			const path = new URL(input as string).pathname;
			calls.push(path);
			const headers = new Headers();
			if (path === '/auth/whoami') {
				whoamiCalls += 1;
				// um 401 de quem é só a sessão vencida: a requisição refeita depois da recuperação passa
				const status = whoamiCalls === 1 ? (remaining.whoami ?? 200) : 200;
				if (status !== 200) return new Response(problem(status), { status, headers: { 'content-type': 'application/problem+json' } });
				headers.set('content-type', 'application/json');
				return new Response(JSON.stringify({ id: 'bot', username: 'bot' }), { status, headers });
			}
			if (path === '/auth/refresh') {
				const status = remaining.refresh ?? 200;
				if (status !== 200) return new Response(problem(status), { status, headers: { 'content-type': 'application/problem+json' } });
				headers.set('set-cookie', 'Auth=sessao-nova');
				return new Response(null, { status, headers });
			}
			if (path === '/auth/login') {
				const status = remaining.login ?? 200;
				if (status !== 200) return new Response(problem(status), { status, headers: { 'content-type': 'application/problem+json' } });
				headers.set('set-cookie', 'Auth=sessao-do-login');
				headers.set('content-type', 'application/json');
				return new Response('{}', { status, headers });
			}
			throw new Error(`rota inesperada ${path}`);
		})
	);
	return { calls };
}

const base = { baseUrl: 'https://papo.example.com', username: 'bot', password: 'senha', rateLimitRps: 0 };

/** API já autenticada com `Auth=sessao-antiga`. */
const authedApi = async () => {
	stubServer({});
	const api = new PapoApi(base);
	await api.login();
	return api;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('PapoApi.refresh', () => {
	it('sem cookie não tenta nada', async () => {
		const { calls } = stubServer({});
		const api = new PapoApi(base);
		expect(await api.refresh()).toBe(false);
		expect(calls).toEqual([]);
	});

	it('401 derruba a sessão e devolve false em vez de reportar sucesso', async () => {
		const api = await authedApi();
		expect(api.authCookie).toBe('Auth=sessao-do-login');

		stubServer({ refresh: 401 });
		expect(await api.refresh()).toBe(false);
		expect(api.authCookie).toBeUndefined();
	});

	it('429 é erro transitório, não sucesso', async () => {
		const api = await authedApi();
		stubServer({ refresh: 429 });

		const err = await api.refresh().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PapoApiError);
		expect((err as PapoApiError).status).toBe(429);
		expect((err as PapoApiError).transient).toBe(true);
		// a sessão antiga continua até a próxima tentativa
		expect(api.authCookie).toBe('Auth=sessao-do-login');
	});

	it('5xx é erro transitório, não sucesso', async () => {
		const api = await authedApi();
		stubServer({ refresh: 503 });

		const err = await api.refresh().catch((e: unknown) => e);
		expect((err as PapoApiError).status).toBe(503);
		expect((err as PapoApiError).transient).toBe(true);
	});

	it('refresh aceito troca o cookie e devolve true', async () => {
		const api = await authedApi();
		stubServer({});
		expect(await api.refresh()).toBe(true);
		expect(api.authCookie).toBe('Auth=sessao-nova');
	});

	it('refreshes concorrentes são uma única chamada', async () => {
		const api = await authedApi();
		const { calls } = stubServer({});

		const results = await Promise.all([api.refresh(), api.refresh(), api.refresh()]);
		expect(results).toEqual([true, true, true]);
		expect(calls.filter((p) => p === '/auth/refresh')).toHaveLength(1);
	});
});

describe('PapoApi: recuperação depois de 401', () => {
	it('401 não é classificado como falha permanente da mensagem', () => {
		expect(new PapoApiError('sem sessão', 401).transient).toBe(true);
	});

	it('requisições 401 simultâneas fazem uma única recuperação', async () => {
		const api = await authedApi();
		const { calls } = stubServer({ whoami: 401, refresh: 401 });
		// depois da recuperação o whoami passa
		let whoamiCalls = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: URL | string) => {
				const path = new URL(input as string).pathname;
				calls.push(path);
				const headers = new Headers();
				if (path === '/auth/whoami') {
					whoamiCalls += 1;
					if (whoamiCalls <= 3) return new Response(problem(401), { status: 401, headers: { 'content-type': 'application/problem+json' } });
					headers.set('content-type', 'application/json');
					return new Response(JSON.stringify({ id: 'bot', username: 'bot' }), { status: 200, headers });
				}
				if (path === '/auth/refresh') return new Response(problem(401), { status: 401, headers: { 'content-type': 'application/problem+json' } });
				if (path === '/auth/login') {
					headers.set('set-cookie', 'Auth=sessao-do-login');
					headers.set('content-type', 'application/json');
					return new Response('{}', { status: 200, headers });
				}
				throw new Error(`rota inesperada ${path}`);
			})
		);

		const users = await Promise.all([api.whoami(), api.whoami(), api.whoami()]);
		expect(users.every((u) => u.id === 'bot')).toBe(true);
		expect(calls.filter((p) => p === '/auth/refresh')).toHaveLength(1);
		expect(calls.filter((p) => p === '/auth/login')).toHaveLength(1);
		expect(api.authCookie).toBe('Auth=sessao-do-login');
	});

	it('garante sessão refazendo o login quando o refresh expirou', async () => {
		const api = await authedApi();
		const { calls } = stubServer({ whoami: 401, refresh: 401 });

		await api.ensureSession();

		// o 401 é recuperado dentro da própria requisição: quem refaz o login é a recuperação
		expect(calls.filter((p) => p === '/auth/whoami')).toHaveLength(2);
		expect(calls.filter((p) => p === '/auth/refresh')).toHaveLength(1);
		expect(calls.filter((p) => p === '/auth/login')).toHaveLength(1);
		expect(api.authCookie).toBe('Auth=sessao-do-login');
	});
});
