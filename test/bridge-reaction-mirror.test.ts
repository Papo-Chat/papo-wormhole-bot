import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { settleQueue } from './helpers/settle.js';
import type { Config } from '../src/config.js';

/**
 * P1.2: o desconto da reação do próprio bridge.
 * O espelho pode estar na mensagem observada nos dois sentidos — o que define o desconto é o
 * registro em `mirror_reactions` (lado, mensagem, emoji), não a direção do `message_map`.
 * Reações add/remove que não mudam nada também não são chamadas: no Papo elas deixariam um
 * marcador de eco pendente, pronto para engolir a próxima reação legítima.
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

const BOT_ID = 'bot-1';

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
		edits: [] as string[],
		editMessage: async (id: string) => void api.edits.push(id)
	};
	const discord = {
		selfId: BOT_ID,
		reacts: [] as { messageId: string; emoji: string }[],
		unreacts: [] as { messageId: string; emoji: string }[],
		react: async (_channelId: string, messageId: string, emoji: string) => void discord.reacts.push({ messageId, emoji }),
		unreact: async (_channelId: string, messageId: string, emoji: string) => void discord.unreacts.push({ messageId, emoji }),
		edit: async () => {},
		isSelf: (id?: string | null) => id === BOT_ID,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		loadUnavailableEmojis: async () => 0,
		channelName: () => 'geral',
		roleName: () => undefined,
		destroy: async () => {}
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, { close: () => {}, connect: () => {} } as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const settle = (quietMs = 700) => settleQueue(outbox, quietMs, 6000);

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

	const mirror = (side: 'papo' | 'discord', destinationMessageId: string, emoji = 'u:👍') =>
		store.markMirrorReaction({ linkId: link.id, side, destinationMessageId, emoji });

	const react = (messageId: string, count: number) =>
		({ type: 'react_update', message_id: messageId, emoji_id: null, unicode: '👍', count }) as never;

	return { store, outbox, bridge, link, api, discord, settle, map, mirror, react };
};

describe('P1.2: desconto do espelho nos dois sentidos', () => {
	it('reação na mensagem original do Papo desconta o espelho aplicado ali (papo → discord)', async () => {
		const { store, bridge, link, discord, settle, map, mirror, react } = fixture();
		map('papo_to_discord', 'pm1', '9999');
		// o espelho do bridge vive na mensagem original do Papo (reação que nasceu no Discord)
		mirror('papo', 'pm1');

		// uma pessoa reagiu no Papo: a contagem 2 inclui o espelho, sobra 1 humana
		bridge.onPapoEvent(react('pm1', 2));
		await settle();
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['9999']);
		expect(discord.unreacts).toEqual([]);

		// ela removeu a dela: só o espelho resta, então nada humana sustenta o espelho no Discord
		bridge.onPapoEvent(react('pm1', 1));
		await settle();
		expect(discord.unreacts.map((r) => r.messageId)).toEqual(['9999']);
		expect(store.hasMirrorReaction({ linkId: link.id, side: 'discord', destinationMessageId: '9999', emoji: 'u:👍' })).toBe(false);
	});

	it('reação na mensagem original do Discord desconta o espelho aplicado ali (discord → papo)', async () => {
		const { bridge, api, settle, map, mirror } = fixture();
		map('discord_to_papo', 'pm2', '8888');
		// o espelho do bridge vive na mensagem original do Discord (reação que nasceu no Papo)
		mirror('discord', '8888');

		await bridge.onDiscordReaction('8888', '111', '👍', null, false, true, 2);
		await settle();
		expect(api.reacts).toEqual(['pm2']);
		expect(api.unreacts).toEqual([]);

		// contagem 1 é só a reação do bot: sem humana, o espelho no Papo sai junto
		await bridge.onDiscordReaction('8888', '111', '👍', null, false, false, 1);
		await settle();
		expect(api.unreacts).toEqual(['pm2']);
	});

	it('contagem da cópia Papo desconta a reação do próprio bridge', async () => {
		const { bridge, discord, settle, map, mirror } = fixture();
		map('discord_to_papo', 'pm2', '8888');
		mirror('papo', 'pm2');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm2', emoji_id: null, unicode: '👍', count: 2 } as never);
		await settle();
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['8888']);

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm2', emoji_id: null, unicode: '👍', count: 1 } as never);
		await settle();
		expect(discord.unreacts.map((r) => r.messageId)).toEqual(['8888']);
	});

	it('contagem 3 → 2 → 1 mantém o espelho enquanto há reação humana', async () => {
		const { bridge, discord, settle, map, mirror } = fixture();
		map('papo_to_discord', 'pm1', '9999');
		mirror('papo', 'pm1');

		// 3 = espelho + duas pessoas; 2 = espelho + uma; 1 = só o espelho do bridge
		for (const count of [3, 2, 1]) {
			bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: null, unicode: '👍', count } as never);
			await settle();
		}

		// a primeira humana é espelhada; a segunda não duplica; só a ausência derruba o espelho
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['9999']);
		expect(discord.unreacts.map((r) => r.messageId)).toEqual(['9999']);
	});
});

describe('P1.2: chamada redundante evitada (marcador de eco pendente)', () => {
	it('add já sincronizado no Papo não é chamado e não deixa eco pendente', async () => {
		const { store, bridge, link, api, discord, settle, map, mirror } = fixture();
		map('discord_to_papo', 'pm2', '8888');
		// o espelho no Papo já está aplicado: adicionar de novo não mudaria nada
		mirror('papo', 'pm2');

		await bridge.onDiscordReaction('8888', '111', '👍', null, false, true, 1);
		await settle();
		expect(api.reacts).toEqual([]);
		expect(store.isSelfReaction({ linkId: link.id, destinationMessageId: 'pm2', emoji: 'u:👍', withinSeconds: 60 })).toBe(false);

		// a próxima reação legítima no Papo não pode ser consumida como eco do bot
		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm2', emoji_id: null, unicode: '👍', count: 2 } as never);
		await settle();
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['8888']);
	});

	it('remove que não tem espelho aplicado não é chamado no Papo', async () => {
		const { bridge, api, settle, map } = fixture();
		map('discord_to_papo', 'pm2', '8888');

		await bridge.onDiscordReaction('8888', '111', '👍', null, false, false, 0);
		await settle();
		expect(api.unreacts).toEqual([]);
	});

	it('add já sincronizado no Discord não é chamado', async () => {
		const { bridge, discord, settle, map, mirror } = fixture();
		map('papo_to_discord', 'pm1', '9999');
		mirror('discord', '9999');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: null, unicode: '👍', count: 1 } as never);
		await settle();
		expect(discord.reacts).toEqual([]);
	});

	it('remove já sincronizado no Discord não é chamado', async () => {
		const { bridge, discord, settle, map } = fixture();
		map('papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: null, unicode: '👍', count: 0 } as never);
		await settle();
		expect(discord.unreacts).toEqual([]);
	});
});
