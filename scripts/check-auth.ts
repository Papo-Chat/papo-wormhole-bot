/**
 * Verifica o fluxo de sessão do bot contra o backend Papo configurado.
 *
 * Uso:
 *   npm run check-auth
 *
 * Mostra exatamente o que o bridge precisa para logar: se o servidor é público ou
 * privado, se a senha do servidor (PAPO_SERVER_PASSWORD) está configurada e é aceita,
 * e se as credenciais do usuário-bot funcionam. Não escreve nada no servidor.
 */

import { existsSync } from 'node:fs';
import { PapoApi } from '../src/papo/api.js';
import { PapoApiError } from '../src/papo/types.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const baseUrl = process.env.PAPO_BASE_URL ?? '';
const username = process.env.PAPO_USERNAME ?? '';
const password = process.env.PAPO_PASSWORD ?? '';
const serverPassword = process.env.PAPO_SERVER_PASSWORD?.trim() || undefined;

if (!baseUrl || !username || !password) {
	console.error('defina PAPO_BASE_URL, PAPO_USERNAME e PAPO_PASSWORD no ambiente ou no .env');
	process.exit(2);
}

const line = (label: string, value: string) => console.log(`${label.padEnd(34)} ${value}`);
const fail = (err: unknown): never => {
	if (err instanceof PapoApiError) {
		line('resultado', `HTTP ${err.status} ${err.problem?.title ?? ''} — ${err.problem?.detail ?? err.message}`);
		if ((err.problem?.type ?? '').endsWith('server-access-required')) {
			console.log('\n→ servidor privado: defina PAPO_SERVER_PASSWORD no .env (POST /auth/login_server antes de /auth/login).');
		}
		if (err.status === 401 && (err.problem?.type ?? '').endsWith('invalid-credentials')) {
			console.log('\n→ credencial incorreta. "senha do servidor" ≠ senha da conta do bot.');
		}
	} else {
		line('resultado', `erro: ${(err as Error).message}`);
	}
	process.exit(1);
};

async function main(): Promise<void> {
	const api = new PapoApi({ baseUrl, username, password, serverPassword });

	console.log(`backend ${baseUrl}`);
	line('usuário-bot', username);
	line('senha do servidor', serverPassword ? `configurada (${serverPassword.length} chars)` : 'não configurada');

	let isPublic: boolean | undefined;
	try {
		const server = await api.getServer();
		isPublic = server.public === true;
		line('servidor', `${server.name} (${server.id})`);
		line('acesso', isPublic ? 'público' : 'privado (exige /auth/login_server)');
	} catch (err) {
		fail(err);
	}

	if (!isPublic && !serverPassword) {
		line('resultado', 'falta PAPO_SERVER_PASSWORD para este servidor privado');
		process.exit(1);
	}

	try {
		await api.login();
		const me = await api.whoami();
		line('login', `ok — autenticado como ${me.username} (${me.id})`);
	} catch (err) {
		fail(err);
	}

	try {
		const refreshed = await api.refresh();
		line('refresh', refreshed ? 'ok — sessão rotacionada' : 'recusado (401)');
	} catch (err) {
		fail(err);
	}

	console.log('\nfluxo de sessão ok.');
}

main().catch(fail);
