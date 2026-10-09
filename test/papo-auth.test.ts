import { afterEach, describe, expect, it, vi } from 'vitest';
import { PapoApi } from '../src/papo/api.js';
import { PapoApiError } from '../src/papo/types.js';

/**
 * Fluxo de sessão do Papo: servidor privado exige o token temporário de
 * `/auth/login_server` no cookie `Auth` antes de `/auth/login`.
 */

interface FakeResponse {
	status: number;
	body?: string;
	contentType?: string;
	setCookie?: string;
}

const problem = (status: number, type: string, detail: string): string =>
	JSON.stringify({ type: `https://papo.example.com/errors/${type}`, title: 'Erro', status, detail });

/** Instala um fetch falso que registra a ordem das rotas chamadas. */
function stubFetch(handler: (path: string) => FakeResponse): string[] {
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: URL | string) => {
			const path = new URL(input as string).pathname;
			calls.push(path);
			const r = handler(path);
			const headers = new Headers();
			if (r.contentType) headers.set('content-type', r.contentType);
			if (r.setCookie) headers.set('set-cookie', r.setCookie);
			return new Response(r.body ?? null, { status: r.status, headers });
		})
	);
	return calls;
}

const base = { baseUrl: 'https://papo.example.com', username: 'bot', password: 'senha-da-conta', rateLimitRps: 0 };

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('PapoApi.login', () => {
	it('resolve o gate de servidor privado antes de /auth/login', async () => {
		const calls = stubFetch((path) => {
			if (path === '/auth/login_server') return { status: 204, setCookie: 'Auth=temp-token; Max-Age=1800' };
			if (path === '/auth/login') return { status: 200, contentType: 'application/json', body: '{}', setCookie: 'Auth=session-token' };
			throw new Error(`rota inesperada ${path}`);
		});

		const api = new PapoApi({ ...base, serverPassword: 'senha-do-servidor' });
		await api.login();

		expect(calls).toEqual(['/auth/login_server', '/auth/login']);
		expect(api.authCookie).toBe('Auth=session-token');
	});

	it('envia o token temporário no cookie da tentativa de login', async () => {
		let loginCookie: string | null = null;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: URL | string, init?: RequestInit) => {
				const path = new URL(input as string).pathname;
				if (path === '/auth/login_server') {
					const body = JSON.parse(String(init?.body)) as { server_password?: string };
					expect(body.server_password).toBe('senha-do-servidor');
					return new Response(null, { status: 204, headers: { 'set-cookie': 'Auth=temp-token' } });
				}
				loginCookie = new Headers(init?.headers).get('cookie');
				return new Response('{}', {
					status: 200,
					headers: { 'content-type': 'application/json', 'set-cookie': 'Auth=session-token' }
				});
			})
		);

		await new PapoApi({ ...base, serverPassword: 'senha-do-servidor' }).login();
		expect(loginCookie).toBe('Auth=temp-token');
	});

	it('recusa login em servidor privado sem PAPO_SERVER_PASSWORD, com erro legível', async () => {
		stubFetch(() => ({
			status: 401,
			contentType: 'application/problem+json',
			body: problem(401, 'server-access-required', 'servidor não público: informe a senha do servidor em /auth/login_server antes de continuar')
		}));

		const err = await new PapoApi(base).login().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PapoApiError);
		expect((err as PapoApiError).status).toBe(401);
		expect((err as PapoApiError).message).toContain('PAPO_SERVER_PASSWORD');
	});

	it('propaga a recusa do backend quando a senha do servidor está errada', async () => {
		const calls = stubFetch((path) => ({
			status: 401,
			contentType: 'application/problem+json',
			body: problem(401, 'invalid-credentials', 'senha do servidor incorreta')
		}));

		const err = await new PapoApi({ ...base, serverPassword: 'errada' }).login().catch((e: unknown) => e);
		expect((err as PapoApiError).message).toContain('senha do servidor incorreta');
		expect(calls).toEqual(['/auth/login_server']);
	});

	it('renova o token temporário expirado e repete o login uma vez', async () => {
		let attempts = 0;
		const calls = stubFetch((path) => {
			if (path === '/auth/login_server') return { status: 204, setCookie: 'Auth=temp-token' };
			attempts += 1;
			if (attempts === 1) {
				return {
					status: 401,
					contentType: 'application/problem+json',
					body: problem(401, 'server-access-required', 'token temporário expirado')
				};
			}
			return { status: 200, contentType: 'application/json', body: '{}', setCookie: 'Auth=session-token' };
		});

		await new PapoApi({ ...base, serverPassword: 'senha-do-servidor' }).login();
		expect(calls).toEqual(['/auth/login_server', '/auth/login', '/auth/login_server', '/auth/login']);
	});
});
