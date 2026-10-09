import type { PapoChannel, PapoServer, PapoUserSummary } from '../papo/types.js';

/**
 * Resolução de alias dos comandos de configuração: o administrador digita o nome
 * (`Cyber Asilo`, `#geral`, `@jonas`) e o bridge procura o uuid correspondente.
 * O uuid continua aceito em qualquer opção.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Resolved<T> = { ok: true; value: T; by: 'uuid' | 'nome' } | { ok: false; message: string };

/** Alias digitado: tolera o `#` de canal, o `@` de usuário, maiúsculas e espaços sobrando. */
export function normalizeAlias(raw: string): string {
	return raw.trim().replace(/^[@#]/, '').toLowerCase();
}

export function isUuid(raw: string): boolean {
	return UUID_RE.test(raw.trim());
}

/** Candidatos citados na mensagem de erro, limitados para caber nos 2000 caracteres do Discord. */
function candidates<T>(items: T[], describe: (item: T) => string): string {
	if (!items.length) return 'nenhum item visível para o usuário-bot neste backend';
	return items.slice(0, 15).map((item) => `  • ${describe(item)}`).join('\n');
}

/**
 * Casa pelo nome: igualdade (ignorando caixa e o `#`/`@` de borda) primeiro; se nada for
 * exato, aceita um único candidato por substring. Mais de um candidato → erro com a lista,
 * para o administrador desambiguar com o uuid.
 */
function matchByName<T>(items: T[], names: (item: T) => string[], describe: (item: T) => string, wanted: string, plural: string): Resolved<T> {
	const aliasOf = (item: T): string[] => names(item).map(normalizeAlias).filter(Boolean);
	const exact = items.filter((item) => aliasOf(item).includes(wanted));
	if (exact.length === 1) return { ok: true, value: exact[0]!, by: 'nome' };

	const loose = exact.length ? exact : items.filter((item) => aliasOf(item).some((n) => n.includes(wanted)));
	if (loose.length === 1) return { ok: true, value: loose[0]!, by: 'nome' };

	const list = candidates(loose.length ? loose : items, describe);
	const message = loose.length
		? `"${wanted.trim()}" corresponde a ${loose.length} ${plural}. Desambigue usando o uuid:\n${list}`
		: `"${wanted.trim()}" não corresponde a nada. Opções:\n${list}`;
	return { ok: false, message };
}

export function matchChannel(channels: PapoChannel[], input: string): Resolved<PapoChannel> {
	const wanted = normalizeAlias(input);
	const describe = (c: PapoChannel): string => `#${c.name} — ${c.id}`;
	if (isUuid(input)) {
		const found = channels.find((c) => c.id.toLowerCase() === wanted);
		return found
			? { ok: true, value: found, by: 'uuid' }
			: { ok: false, message: `nenhum canal com o uuid ${input.trim()}.\n${candidates(channels, describe)}` };
	}
	return matchByName(channels, (c) => [c.name], describe, wanted, 'canais');
}

/** O backend serve um único servidor: o alias é conferido contra `GET /server`. */
export function matchServer(server: PapoServer, input: string): Resolved<PapoServer> {
	const wanted = normalizeAlias(input);
	if (isUuid(input)) {
		return server.id.toLowerCase() === wanted
			? { ok: true, value: server, by: 'uuid' }
			: { ok: false, message: `este backend serve o servidor "${server.name}" (${server.id}); o uuid informado é de outro servidor` };
	}
	const name = normalizeAlias(server.name);
	if (name === wanted || name.includes(wanted) || wanted.includes(name)) return { ok: true, value: server, by: 'nome' };
	return { ok: false, message: `o servidor deste backend é "${server.name}" (${server.id})` };
}

/** Aceita username e apelido; o username tem prioridade quando os dois casam. */
export function matchUser(users: PapoUserSummary[], input: string): Resolved<PapoUserSummary> {
	const wanted = normalizeAlias(input);
	const describe = (u: PapoUserSummary): string => `${u.nickname ?? u.username} (@${u.username}) — ${u.id}`;
	if (isUuid(input)) {
		const found = users.find((u) => u.id.toLowerCase() === wanted);
		return found
			? { ok: true, value: found, by: 'uuid' }
			: { ok: false, message: `nenhum usuário com o uuid ${input.trim()}.\n${candidates(users, describe)}` };
	}
	const byUsername = users.filter((u) => normalizeAlias(u.username) === wanted);
	if (byUsername.length === 1) return { ok: true, value: byUsername[0]!, by: 'nome' };
	return matchByName(users, (u) => [u.username, u.nickname ?? ''], describe, wanted, 'usuários');
}
