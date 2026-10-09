import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import type { Config } from '../src/config.js';

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

const PAPO_USER = '68c858a1-8d68-44d1-b7a5-05d95089fb97';
const DISCORD_USER = '206552277044035584';

interface DiscordSend {
	channelId: string;
	embeds?: { description?: string }[];
}

const fixture = (opts: { propagateMentions?: boolean } = {}) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
	const sends: DiscordSend[] = [];
	const papoSent: { embeds?: { description?: string }[] }[] = [];
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'jenga', nickname: 'Jenga' })),
		sendMessage: async (input: { embeds?: { description?: string }[] }) => {
			papoSent.push(input);
			return { id: 'pm-new', channel_id: 'chan-1', author_id: 'bot', content: null, created_at: new Date().toISOString() };
		}
	};
	const discord = {
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		channelName: () => 'geral',
		send: async (channelId: string, options: DiscordSend) => {
			sends.push(options);
			return { id: 'd1' };
		}
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	if (opts.propagateMentions) store.setChannelLinkFlag(link.id, 'propagate_mentions', 1);
	store.upsertPapoUser({ id: PAPO_USER, username: 'jenga', nickname: 'Jenga' });
	store.upsertDiscordUser({ id: DISCORD_USER, username: 'jenga', display_name: 'Jenga' });
	store.linkUser(PAPO_USER, DISCORD_USER);
	const settle = async (): Promise<void> => {
		// `onPapoEvent` é fire-and-forget: dá tempo do job entrar na fila antes de esvaziar.
		await new Promise((r) => setTimeout(r, 60));
		const until = Date.now() + 1200;
		while (Date.now() < until && (outbox.counts().in_flight > 0 || outbox.counts().pending > 0)) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	return { store, outbox, bridge, link, sends, papoSent, settle };
};

const papoMessage = (content: string) => ({
	type: 'message',
	id: 'pm-1',
	channel_id: 'chan-1',
	author_id: PAPO_USER,
	content,
	created_at: '2026-10-09T18:09:00Z',
	attachments: []
});

const discordMessage = (content: string) => ({
	id: 'dm-1',
	channelId: '111',
	channel: { isThread: () => false },
	author: {
		id: 'user-1',
		username: 'jenga',
		displayName: 'Jenga',
		avatar: 'hash',
		displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-1/hash.png'
	},
	member: { displayName: 'Jenga' },
	content,
	createdAt: new Date(),
	attachments: [],
	embeds: []
});

const descriptionOf = (embeds?: { description?: string }[]): string => embeds?.[0]?.description ?? '';

describe('menção propaga pelo flag do link, não só pelo env global', () => {
	it('link com propagate_mentions converte a menção do Papo em ping do Discord', async () => {
		const { bridge, sends, settle } = fixture({ propagateMentions: true });

		bridge.onPapoEvent(papoMessage(`olá @mention(<@${PAPO_USER}>)`) as never);
		await settle();

		expect(descriptionOf(sends[0]?.embeds)).toBe(`olá <@${DISCORD_USER}>`);
	});

	it('sem o flag do link a menção vira rótulo e não ping', async () => {
		const { bridge, sends, settle } = fixture();

		bridge.onPapoEvent(papoMessage(`olá @mention(<@${PAPO_USER}>)`) as never);
		await settle();

		const description = descriptionOf(sends[0]?.embeds);
		expect(description).not.toContain(`<@${DISCORD_USER}>`);
		expect(description).toContain('@Jenga');
	});

	it('link com propagate_mentions converte o ping do Discord em menção do Papo', async () => {
		const { bridge, papoSent, settle } = fixture({ propagateMentions: true });

		await bridge.onDiscordMessage(discordMessage(`olá <@${DISCORD_USER}>`) as never);
		await settle();

		expect(descriptionOf(papoSent[0]?.embeds)).toBe(`olá @mention(<@${PAPO_USER}>)`);
	});

	it('sem o flag do link o ping do Discord vira rótulo', async () => {
		const { bridge, papoSent, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage(`olá <@${DISCORD_USER}>`) as never);
		await settle();

		const description = descriptionOf(papoSent[0]?.embeds);
		expect(description).not.toContain('@mention(');
		expect(description).toContain('@Jenga');
	});
});
