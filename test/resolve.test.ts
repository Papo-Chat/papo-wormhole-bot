import { describe, expect, it } from 'vitest';
import { isUuid, matchChannel, matchServer, matchUser, normalizeAlias, type Resolved } from '../src/commands/resolve.js';
import type { PapoChannel, PapoServer, PapoUserSummary } from '../src/papo/types.js';

const channels: PapoChannel[] = [
	{ id: 'aaaaaaaa-0000-4000-8000-000000000001', name: '💻 Desenvolvimento', type: 'text', position: 1 },
	{ id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'geral', type: 'text', position: 2 },
	{ id: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'geral-2', type: 'text', position: 3 }
];

const server: PapoServer = {
	id: '3f916d4d-5914-4e5a-a1c8-04df6222b547',
	name: 'Cyber Asilo',
	owner_id: 'o',
	public: false
};

const users: PapoUserSummary[] = [
	{ id: 'bbbbbbbb-0000-4000-8000-000000000001', username: 'jonas', nickname: 'Jonas 🦆' },
	{ id: 'bbbbbbbb-0000-4000-8000-000000000002', username: 'discord-wormhole', nickname: null },
	{ id: 'bbbbbbbb-0000-4000-8000-000000000003', username: 'ana', nickname: 'jonas' }
];

/** Valor resolvido; falha o teste com a mensagem que o administrador veria. */
const ok = <T>(r: Resolved<T>): T => {
	if (!r.ok) throw new Error(`não resolveu: ${r.message}`);
	return r.value;
};

/** Como o alias foi resolvido. */
const by = <T>(r: Resolved<T>): 'uuid' | 'nome' => {
	if (!r.ok) throw new Error(`não resolveu: ${r.message}`);
	return r.by;
};

/** Mensagem de erro de uma resolução recusada. */
const err = (r: Resolved<unknown>): string => {
	if (r.ok) throw new Error('esperava recusa, resolveu');
	return r.message;
};

describe('normalizeAlias / isUuid', () => {
	it('tolera #, @, caixa e espaços', () => {
		expect(normalizeAlias('  #💻 Desenvolvimento ')).toBe('💻 desenvolvimento');
		expect(normalizeAlias('@Jonas')).toBe('jonas');
	});
	it('reconhece uuid e rejeita nome', () => {
		expect(isUuid(' 3F916D4D-5914-4E5A-A1C8-04DF6222B547 ')).toBe(true);
		expect(isUuid('Cyber Asilo')).toBe(false);
	});
});

describe('matchChannel', () => {
	it('resolve por nome, com ou sem # e ignorando caixa', () => {
		expect(ok(matchChannel(channels, 'geral')).id).toBe(channels[1]!.id);
		expect(ok(matchChannel(channels, '#💻 desenvolvimento')).id).toBe(channels[0]!.id);
		expect(ok(matchChannel(channels, 'Desenvolvimento')).name).toBe('💻 Desenvolvimento');
	});
	it('resolve por uuid', () => {
		expect(ok(matchChannel(channels, channels[2]!.id)).name).toBe('geral-2');
	});
	it('substring que casa com um único canal é aceita', () => {
		expect(ok(matchChannel(channels, 'desenvolvimento')).id).toBe(channels[0]!.id);
	});
	it('uuid inexistente lista os canais visíveis', () => {
		expect(err(matchChannel(channels, '00000000-0000-4000-8000-000000000000'))).toContain('#geral');
	});
	it('nome ambíguo pede o uuid e lista os candidatos', () => {
		const dup = [
			{ ...channels[1]!, id: 'x1', name: 'geral' },
			{ ...channels[2]!, id: 'x2', name: 'Geral' }
		];
		expect(err(matchChannel(dup, 'geral'))).toContain('Desambigue');
	});
});

describe('matchServer', () => {
	it('resolve pelo nome do servidor', () => {
		expect(ok(matchServer(server, 'cyber asilo')).id).toBe(server.id);
		expect(by(matchServer(server, 'Cyber'))).toBe('nome');
	});
	it('resolve pelo uuid', () => {
		expect(by(matchServer(server, server.id))).toBe('uuid');
	});
	it('uuid de outro servidor é recusado citando o servidor real', () => {
		expect(err(matchServer(server, 'aaaaaaaa-0000-4000-8000-000000000009'))).toContain('Cyber Asilo');
	});
});

describe('matchUser', () => {
	it('resolve por username', () => {
		expect(ok(matchUser(users, 'jonas')).id).toBe(users[0]!.id);
		expect(ok(matchUser(users, '@discord-wormhole')).username).toBe('discord-wormhole');
	});
	it('username tem prioridade quando um nickname empata', () => {
		expect(ok(matchUser(users, 'jonas')).username).toBe('jonas');
	});
	it('resolve por nickname quando o username não casa', () => {
		expect(ok(matchUser(users, 'Jonas 🦆')).id).toBe(users[0]!.id);
	});
	it('uuid é aceito direto', () => {
		expect(ok(matchUser(users, users[2]!.id)).username).toBe('ana');
	});
	it('nome ambíguo lista os candidatos', () => {
		expect(err(matchUser(users, 'jo'))).toContain('@jonas');
	});
});
