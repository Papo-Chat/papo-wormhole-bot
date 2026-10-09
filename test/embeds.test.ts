import { describe, expect, it } from 'vitest';
import {
	buildDiscordBridgeEmbed,
	buildPapoBridgeEmbed,
	discordEmbedsToPapo,
	embedTextLength,
	fitEmbedBudget,
	hexToInt,
	intToHex,
	papoEmbedsToDiscord
} from '../src/bridge/embeds.js';
import { PAPO_LIMITS } from '../src/bridge/limits.js';

describe('cores', () => {
	it('converte int → hex e hex → int', () => {
		expect(intToHex(0x5865f2)).toBe('#5865f2');
		expect(hexToInt('#5865F2')).toBe(0x5865f2);
		expect(hexToInt('5865F2')).toBe(0x5865f2);
		expect(hexToInt('inválida')).toBeUndefined();
	});
});

describe('discordEmbedsToPapo', () => {
	it('mapeia autor, footer, campos e cor', () => {
		const [out] = discordEmbedsToPapo([
			{
				title: 'Título',
				description: 'descrição',
				url: 'https://example.com/x',
				color: 0x00ff00,
				author: { name: 'Jonas', url: 'https://example.com' },
				footer: { text: 'rodapé' },
				fields: [{ name: 'f', value: 'v', inline: true }]
			}
		]);
		expect(out?.title).toBe('Título');
		expect(out?.description).toBe('descrição');
		expect(out?.color).toBe('#00ff00');
		expect(out?.author?.name).toBe('Jonas');
		expect(out?.footer?.text).toBe('rodapé');
		expect(out?.site_name).toBe('example.com');
		expect(out?.fields?.[0]).toEqual({ name: 'f', value: 'v', inline: true });
	});

	it('usa a imagem principal como thumbnail quando não há thumbnail', () => {
		const [out] = discordEmbedsToPapo([{ description: 'x', image: { url: 'https://cdn.example.com/a.png' } }]);
		expect(out?.thumbnail?.url).toBe('https://cdn.example.com/a.png');
		expect(out?.image).toBeUndefined();
	});

	it('aplica os limites do Papo', () => {
		const [out] = discordEmbedsToPapo([
			{
				title: 't'.repeat(500),
				description: 'd'.repeat(6000),
				author: { name: 'a'.repeat(400) },
				footer: { text: 'f'.repeat(3000) },
				fields: Array.from({ length: 40 }, (_, i) => ({ name: `n${i}`.repeat(100), value: 'v'.repeat(2000) }))
			}
		]);
		expect(out?.title?.length ?? 0).toBeLessThanOrEqual(PAPO_LIMITS.embedTitleMax);
		expect(out?.description?.length ?? 0).toBeLessThanOrEqual(PAPO_LIMITS.embedDescriptionMax);
		expect(out?.author?.name?.length ?? 0).toBeLessThanOrEqual(PAPO_LIMITS.embedAuthorMax);
		expect(out?.footer?.text?.length ?? 0).toBeLessThanOrEqual(PAPO_LIMITS.embedFooterMax);
		expect((out?.fields?.length ?? 0) + 1).toBeLessThanOrEqual(PAPO_LIMITS.embedFieldsMax + 1);
	});

	it('descarta embeds além de 10 por mensagem', () => {
		const embeds = Array.from({ length: 15 }, (_, i) => ({ description: `e${i}` }));
		expect(discordEmbedsToPapo(embeds).length).toBeLessThanOrEqual(PAPO_LIMITS.embedsPerMessage);
	});
});

describe('papoEmbedsToDiscord', () => {
	it('mapeia embed de link do Papo para o Discord', () => {
		const [out] = papoEmbedsToDiscord([
			{
				id: 'e1',
				source_type: 'link',
				title: 'GitHub',
				description: 'repo',
				url: 'https://github.com/Papo-Chat',
				color: '#00ff00',
				site_name: 'github.com'
			}
		]);
		expect(out?.title).toBe('GitHub');
		expect(out?.url).toBe('https://github.com/Papo-Chat');
		expect(out?.color).toBe(0x00ff00);
	});

	it('usa a imagem re-hospedada quando o embed do Papo não tem URL de thumbnail', () => {
		const [out] = papoEmbedsToDiscord(
			[
				{
					id: 'e1',
					source_type: 'link',
					title: 'YouTube',
					thumbnail: { mime_type: 'image/webp', width: 384, height: 288, size_bytes: 10090 }
				}
			],
			{ thumbnailUrlFor: (e) => (e.id === 'e1' ? 'https://media.example/media/abc.webp' : undefined) }
		);
		expect(out?.thumbnail?.url).toBe('https://media.example/media/abc.webp');
	});

	it('mantém a URL quando o embed já traz uma', () => {
		const [out] = papoEmbedsToDiscord([{ id: 'e2', source_type: 'custom', thumbnail: { url: 'https://cdn.example/a.png' } }], {
			thumbnailUrlFor: () => 'https://media.example/nao-usar.webp'
		});
		expect(out?.thumbnail?.url).toBe('https://cdn.example/a.png');
	});
});

describe('fitEmbedBudget', () => {
	it('mantém embeds dentro do orçamento de 6000 chars', () => {
		const embeds = Array.from({ length: 4 }, () => ({ description: 'd'.repeat(2500) }));
		const fitted = fitEmbedBudget(embeds, 6000);
		expect(fitted.reduce((acc, e) => acc + embedTextLength(e), 0)).toBeLessThanOrEqual(6000);
		expect(fitted.length).toBeLessThan(embeds.length);
	});

	it('trunca a descrição do último embed em vez de descartá-lo', () => {
		const fitted = fitEmbedBudget([{ description: 'd'.repeat(7000) }], 6000);
		expect(fitted[0]?.description?.length).toBeLessThanOrEqual(6000);
	});
});

describe('embeds de bridge', () => {
	it('monta o embed do Discord com autor e rodapé', () => {
		const e = buildDiscordBridgeEmbed({
			authorName: 'Jonas',
			authorIconUrl: 'https://cdn.example.com/a.png',
			description: 'olá',
			footerText: '🕒 01/01/2026 · Papo',
			colorHex: '#5865F2'
		});
		expect(e.author?.name).toBe('Jonas');
		expect(e.author?.icon_url).toBe('https://cdn.example.com/a.png');
		expect(e.description).toBe('olá');
		expect(e.color).toBe(0x5865f2);
	});

	it('usa o avatar do Discord como ícone do autor no embed do Papo', () => {
		const e = buildPapoBridgeEmbed({
			authorName: 'Jonas',
			authorIconUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
			description: 'olá',
			footerText: '🕒 · Discord'
		});
		// nada de avatar na thumbnail: o card do Papo desenha a thumbnail em largura total
		expect(e.thumbnail).toBeUndefined();
		expect(e.author?.name).toBe('Jonas');
		expect(e.author?.icon_url).toBe('https://cdn.discordapp.com/avatars/1/a.png');
		expect(e.site_name).toBe('Jonas');
	});

	it('mantém imagem de conteúdo na thumbnail do embed do Papo', () => {
		const e = buildPapoBridgeEmbed({
			authorName: 'Jonas',
			authorIconUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
			description: 'olá',
			footerText: '🕒 · Discord',
			thumbnailUrl: 'https://cdn.example.com/foto.png'
		});
		expect(e.thumbnail?.url).toBe('https://cdn.example.com/foto.png');
		expect(e.site_name).toBe('Jonas');
	});

	it('ignora cor inválida no embed do Papo', () => {
		const e = buildPapoBridgeEmbed({ authorName: 'a', description: 'b', footerText: 'c', colorHex: 'não-cor' });
		expect(e.color).toBeUndefined();
	});
});
