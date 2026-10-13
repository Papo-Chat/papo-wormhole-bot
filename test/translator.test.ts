import { describe, expect, it } from 'vitest';
import { authorLabel, discordToPapoContent, discordUserMentionIds, formatDate, papoMentionIds, papoToDiscordContent } from '../src/bridge/translator.js';

const PAPO_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('discordToPapoContent', () => {
	it('converte menção de usuário em rótulo quando não há link', () => {
		const out = discordToPapoContent('oi <@111> e <@!222>', {
			discordUserLabel: (id) => (id === '111' ? 'Jonas' : 'Ana')
		});
		expect(out).toBe('oi @Jonas e @Ana');
	});

	it('usa o formato canônico do Papo quando a menção é propagada', () => {
		const out = discordToPapoContent('oi <@111>', {
			propagateMentions: true,
			papoUserIdForDiscord: () => PAPO_UUID
		});
		expect(out).toBe(`oi @mention(<@${PAPO_UUID}>)`);
	});

	it('menção sem rótulo não atravessa como snowflake', () => {
		expect(discordToPapoContent('oi <@111>')).toBe('oi @usuário');
		expect(discordToPapoContent('oi <@!111>', { discordUserLabel: () => undefined })).toBe('oi @usuário');
	});

	it('converte emoji custom do Discord em shortcode do Papo', () => {
		expect(discordToPapoContent('legal <:papu:1234567890>')).toBe('legal :papu:');
		expect(discordToPapoContent('animado <a:papu:1234567890>')).toBe('animado :papu:');
	});

	it('resolve canal e role para texto legível', () => {
		const out = discordToPapoContent('veja <#42> e <@&7>', {
			discordChannelLabel: () => 'geral',
			discordRoleLabel: () => 'moderação'
		});
		expect(out).toBe('veja #geral e moderação');
	});

	it('substitui timestamp relativo por data absoluta', () => {
		const out = discordToPapoContent('às <t:1700000000:R>', { timezone: 'UTC' });
		expect(out).toContain('às ');
		expect(out).not.toContain('<t:');
		expect(out).toMatch(/\d{2}\/\d{2}\/\d{4}/);
	});

	it('troca sublinhado do Discord por negrito (Papo não renderiza __)', () => {
		expect(discordToPapoContent('__destaque__')).toBe('**destaque**');
	});

	it('converte spoiler ||texto|| em rótulo explícito', () => {
		expect(discordToPapoContent('segredo ||escondido|| fim')).toBe('segredo **spoiler:** escondido fim');
	});

	it('neutraliza @everyone/@here (a conta do bridge pode ter everyone_message no Papo)', () => {
		expect(discordToPapoContent('@everyone atenção')).toBe('@\u200beveryone atenção');
		expect(discordToPapoContent('@here olha')).toBe('@\u200bhere olha');
	});

	it('preserva markdown que os dois lados entendem', () => {
		const src = '~~riscado~~ **negrito** *itálico* `código`\n| a | b |\n|---|---|\n| 1 | 2 |';
		expect(discordToPapoContent(src)).toBe(src);
	});
});

describe('ids de menção (rótulo resolvido antes de traduzir)', () => {
	it('extrai as menções de usuário do Discord', () => {
		expect(discordUserMentionIds('oi <@111> e <@!222>, role <@&7>, canal <#42>')).toEqual(['111', '222']);
		expect(discordUserMentionIds('nada aqui')).toEqual([]);
	});

	it('extrai as menções no formato do Papo', () => {
		expect(papoMentionIds(`olá @mention(<@${PAPO_UUID}>)`)).toEqual([PAPO_UUID]);
		expect(papoMentionIds('sem menção')).toEqual([]);
	});
});

describe('papoToDiscordContent', () => {
	it('converte @mention(<@uuid>) em ping quando propagado', () => {
		const out = papoToDiscordContent(`chamando @mention(<@${PAPO_UUID}>)`, {
			propagateMentions: true,
			discordUserIdForPapo: () => '111'
		});
		expect(out).toBe('chamando <@111>');
	});

	it('recai para rótulo quando não há link de usuário', () => {
		const out = papoToDiscordContent(`chamando @mention(<@${PAPO_UUID}>)`, {
			papoUserLabel: () => 'Jonas'
		});
		expect(out).toBe('chamando @Jonas');
	});

	it('menção sem rótulo não atravessa como uuid', () => {
		expect(papoToDiscordContent(`chamando @mention(<@${PAPO_UUID}>)`)).toBe('chamando @usuário');
	});

	it('converte shortcode em emoji do guild', () => {
		const out = papoToDiscordContent('legal :papu:', {
			discordEmoji: (name) => ({ token: `<:papu:999>` })
		});
		expect(out).toBe('legal <:papu:999>');
	});

	it('mantém shortcode desconhecido literal', () => {
		expect(papoToDiscordContent('algo :nao_existe: aqui')).toBe('algo :nao_existe: aqui');
	});

	it('não confunde hora com shortcode', () => {
		expect(papoToDiscordContent('reunião às 14:30 ok')).toBe('reunião às 14:30 ok');
	});
});

describe('formatDate', () => {
	it('formata epoch em segundos', () => {
		expect(formatDate(1700000000, 'UTC')).toMatch(/\d{2}\/\d{2}\/\d{4}/);
	});

	it('formata ISO', () => {
		expect(formatDate('2026-01-02T03:04:05.000Z', 'UTC')).toContain('2026');
	});

	it('não quebra com valor inválido', () => {
		expect(formatDate('não-data')).toBe('não-data');
	});
});

describe('authorLabel', () => {
	it('prefere nickname sobre username', () => {
		expect(authorLabel('Zé', 'ze_br')).toBe('Zé');
	});

	it('recai para username', () => {
		expect(authorLabel(null, 'ze_br')).toBe('ze_br');
	});

	it('limita o tamanho', () => {
		expect(authorLabel('x'.repeat(400)).length).toBe(256);
	});
});

describe('resolução de @nome em texto puro (item 28)', () => {
	const resolver = { propagateMentions: true, papoUserIdForName: (n: string) => (n === 'ana_s' || n === 'ana' ? PAPO_UUID : undefined) };

	it('liga a menção do Papo quando o nome resolve', () => {
		expect(discordToPapoContent('fale com @ana_s', resolver)).toBe(`fale com @mention(<@${PAPO_UUID}>)`);
	});

	it('sem propagateMentions o texto permanece', () => {
		expect(discordToPapoContent('fale com @ana_s', { papoUserIdForName: () => PAPO_UUID })).toBe('fale com @ana_s');
	});

	it('não casa dentro de e-mail, URL ou snowflake', () => {
		expect(discordToPapoContent('a@b.com', resolver)).toBe('a@b.com');
		expect(discordToPapoContent('https://x.com/@ana_s', resolver)).toBe('https://x.com/@ana_s');
		expect(discordToPapoContent('oi <@111>', { ...resolver, discordUserLabel: () => undefined })).toBe('oi @usuário');
	});

	it('palavras reservadas não viram nome', () => {
		expect(discordToPapoContent('chame @everyone', resolver)).toBe('chame @\u200beveryone');
	});

	it('pontuação final não some nem entra no nome', () => {
		expect(discordToPapoContent('chame @ana.', resolver)).toBe(`chame @mention(<@${PAPO_UUID}>).`);
	});

	it('papo: @nome resolve para snowflake do Discord', () => {
		const out = papoToDiscordContent('chame @maria', {
			propagateMentions: true,
			discordUserIdForName: (n) => (n === 'maria' ? '400' : undefined)
		});
		expect(out).toBe('chame <@400>');
	});

	it('menção canônica do Papo não é re-processada pelo caminho de texto puro', () => {
		const out = papoToDiscordContent(`oi @mention(<@${PAPO_UUID}>) tchau`, {
			propagateMentions: true,
			discordUserIdForName: () => '999'
		});
		// sem link de conta e sem rótulo: `@usuário`; "mention" nunca é candidato a nome
		expect(out).toBe('oi @usuário tchau');
	});

	it('ping do Discord sem link resolve pelo rótulo no Papo', () => {
		const out = discordToPapoContent('oi <@111>', {
			propagateMentions: true,
			discordUserLabel: () => 'ana_s',
			papoUserIdForName: (n) => (n === 'ana_s' ? PAPO_UUID : undefined)
		});
		expect(out).toBe(`oi @mention(<@${PAPO_UUID}>)`);
	});
});
