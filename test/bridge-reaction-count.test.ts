import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { settleQueue } from './helpers/settle.js';
import type { Config } from '../src/config.js';

/**
 * Contagem mesclada e proteção contra eco.
 *
 * Cada lado guarda só a contagem humana da sua mensagem (o espelho do bridge é
 * descontado antes de gravar), então o resumo soma os dois lados: 3 no Discord
 * + 2 no Papo = 5. E a reação que o próprio bridge aplica nunca vira reação
 * humana do outro lado: no Discord o evento do próprio bot é filtrado na origem
 * e o espelho é marcado antes da chamada; no Papo o eco do `react_update` é
 * consumido pelo marcador de self-reaction.
 */

const cfg: Config = {
	papo: {
		baseUrl: 'http://localhost',
		wsUrl: 'ws://localhost/ws',
		username: 'u',
		password: 'p',
		refreshHours: 12,
		backfillOnStart: false,
		rateLimitRps: 0,
		rateBurst: 1
	},
	discord: { token: 'token', maxFileBytes: 20_000_000, maxMessagesPer5s: 5 },
	bridge: {
		dataDir: ':memory:',
		dbPath: ':memory:',
		mediaPort: 0,
		timezone: 'UTC',
		emojiAutoImport: false,
		propagateMentions: false,
		maxAttempts: 5,
		backoffBaseMs: 20,
		backoffMaxMs: 60
	}
};

interface EmbedSnapshot {
	description?: string;
}

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u', nickname: null })),
		whoami: async () => ({ id: 'bot', username: 'bot' }),
		ensureSession: async () => true,
		reacts: [] as string[],
		addReaction: async (_channelId: string, id: string) => void api.reacts.push(id),
		unreacts: [] as string[],
		removeReaction: async (_channelId: string, id: string) => void api.unreacts.push(id),
		papoEdits: [] as EmbedSnapshot[][],
		editMessage: async (_id: string, _content: string, embeds?: EmbedSnapshot[]) => {
			api.papoEdits.push(embeds ?? []);
			return {};
		}
	};
	const discord = {
		reacts: [] as { messageId: string; emoji: string }[],
		unreacts: [] as { messageId: string; emoji: string }[],
		edits: [] as { messageId: string; embeds?: EmbedSnapshot[] }[],
		react: async (_channelId: string, messageId: string, emoji: string) => void discord.reacts.push({ messageId, emoji }),
		unreact: async (_channelId: string, messageId: string, emoji: string) => void discord.unreacts.push({ messageId, emoji }),
		edit: async (_channelId: string, messageId: string, options: unknown) =>
			void discord.edits.push({ messageId, embeds: (options as { embeds?: EmbedSnapshot[] }).embeds }),
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		loadUnavailableEmojis: async () => 0,
		channelName: () => 'geral',
		roleName: () => undefined,
		destroy: async () => {}
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, { close: () => {}, connect: () => {} } as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });

	const map = (direction: 'papo_to_discord' | 'discord_to_papo', papoId: string, discordId: string) =>
		store.mapMessage({
			link_id: link.id,
			direction,
			papo_message_id: papoId,
			discord_message_id: discordId,
			rendered: 'oi',
			bridge_embed: { description: 'oi', footer: { text: '🕒 · Papo' } },
			footer_base: '🕒 · Papo'
		});

	const settle = (quietMs = 700) => settleQueue(outbox, quietMs, 6000);
	const react = (messageId: string, count: number) =>
		({ type: 'react_update', message_id: messageId, emoji_id: null, unicode: '👍', count }) as never;
	const discordReact = (messageId: string, count: number, add = true) =>
		bridge.onDiscordReaction(messageId, '111', '👍', null, false, add, count);

	return { store, outbox, bridge, link, api, discord, settle, map, react, discordReact };
};

describe('contagem mesclada de reações (soma dos dois lados)', () => {
	it('3 reações no Discord + 2 no Papo mostram 5 no resumo da cópia', async () => {
		const { bridge, discord, settle, map, react, discordReact } = fixture();
		map('papo_to_discord', 'pm1', '9999');

		// duas pessoas reagem no Papo: o bridge espelha na cópia Discord
		bridge.onPapoEvent(react('pm1', 1));
		await settle();
		bridge.onPapoEvent(react('pm1', 2));
		await settle();

		// três pessoas reagem no Discord: a contagem observada inclui o espelho do bot (2, 3, 4)
		await discordReact('9999', 2);
		await settle();
		await discordReact('9999', 3);
		await settle();
		await discordReact('9999', 4);
		await settle();

		const last = discord.edits.at(-1);
		expect(last?.messageId, JSON.stringify(discord.edits)).toBe('9999');
		expect(last?.embeds?.[0]?.description, last?.embeds?.[0]?.description).toContain('👍 5');
	});

	it('remoção de uma reação humana reduz a soma', async () => {
		const { bridge, discord, settle, map, react, discordReact } = fixture();
		map('papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent(react('pm1', 1));
		await settle();
		await discordReact('9999', 2); // uma humana no Discord + espelho → bot reage no Papo
		await settle();
		bridge.onPapoEvent(react('pm1', 2)); // eco do self-react no Papo: consumido
		await settle();

		// a pessoa do Papo remove a dela: sobra só o espelho na mensagem do Papo
		bridge.onPapoEvent(react('pm1', 1));
		await settle();

		const last = discord.edits.at(-1);
		expect(last?.embeds?.[0]?.description, last?.embeds?.[0]?.description).toContain('👍 1');
	});
});

describe('eco da reação do próprio bridge não vira reação humana', () => {
	it('reação no Papo espelha só no Discord: nada é aplicado de novo na mensagem original do Papo', async () => {
		const { bridge, api, discord, settle, map, react, discordReact } = fixture();
		map('papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent(react('pm1', 1));
		await settle();
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['9999']);
		expect(api.reacts).toEqual([]);

		// um evento do Discord que observe só a reação do bot (contagem 1, espelho registrado)
		// não pode disparar self-react na mensagem original do Papo
		await discordReact('9999', 1);
		await settle();
		expect(api.reacts).toEqual([]);
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['9999']);
	});

	it('reação no Discord espelha no Papo e o eco do Papo não volta ao Discord', async () => {
		const { bridge, api, discord, settle, map, react, discordReact } = fixture();
		map('discord_to_papo', 'pm2', '8888');

		await discordReact('8888', 1);
		await settle();
		expect(api.reacts).toEqual(['pm2']);

		// eco do `react_update` gerado pela nossa própria chamada: consumido pelo marcador
		bridge.onPapoEvent(react('pm2', 1));
		await settle();
		expect(discord.reacts).toEqual([]);
	});

	it('espelho marcado antes da chamada: evento humano concorrente desconta a reação em voo do bot', async () => {
		const { bridge, api, discord, settle, map, react, discordReact } = fixture();
		map('papo_to_discord', 'pm1', '9999');

		// o react no Discord fica em voo enquanto o evento humano chega com a contagem
		// já incluindo a reação do bot (1)
		let release = () => {};
		const inFlight: string[] = [];
		discord.react = (_channelId: string, messageId: string) =>
			new Promise<undefined>((res) => {
				inFlight.push(messageId);
				release = () => res(undefined);
			});

		bridge.onPapoEvent(react('pm1', 1));
		await new Promise((r) => setTimeout(r, 30)); // deixa o job alcançar o react em voo
		expect(inFlight, 'job não alcançou o react em voo').toEqual(['9999']);
		await discordReact('9999', 1);
		release();
		await settle();

		// o espelho em voo foi descontado: sem reação humana do lado Discord, nada é
		// aplicado na mensagem original do Papo
		expect(api.reacts).toEqual([]);
		expect(inFlight).toEqual(['9999']);
	});
});
