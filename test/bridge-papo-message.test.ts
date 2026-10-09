import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import type { Config } from '../src/config.js';
import type { PapoEmbedInput } from '../src/papo/types.js';

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

interface Sent {
	channelId: string;
	content?: string | null;
	embeds?: PapoEmbedInput[];
}

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: 5, baseMs: 20, maxMs: 60 });
	const sent: Sent[] = [];
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u', nickname: null })),
		sendMessage: async (input: Sent) => {
			sent.push(input);
			return { id: 'pm-new', channel_id: 'chan-1', author_id: 'bot', content: null, created_at: new Date().toISOString() };
		}
	};
	const discord = {
		isSelf: () => false,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		send: async () => ({ id: 'd1' })
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const settle = async (): Promise<void> => {
		const until = Date.now() + 1200;
		while (Date.now() < until && (outbox.counts().in_flight > 0 || outbox.counts().pending > 0)) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	return { store, outbox, bridge, link, sent, settle };
};

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

describe('mensagem no Papo sem content: o texto vai no embed', () => {
	it('envia a mensagem sem content e com o texto no description do embed', async () => {
		const { bridge, sent, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('teste') as never);
		await settle();

		expect(sent.length).toBe(1);
		expect(sent[0]!.content).toBeUndefined();
		const embed = sent[0]!.embeds?.[0];
		expect(embed?.description).toBe('teste');
		// linha de topo do card do Papo: nome do autor Discord + avatar no selo
		expect(embed?.site_name).toBe('Jenga');
		expect(embed?.author?.name).toBe('Jenga');
		expect(embed?.author?.icon_url).toBe('https://cdn.discordapp.com/avatars/user-1/hash.png');
		expect(embed?.thumbnail).toBeUndefined();
	});

	it('mensagem só com anexo continua sendo enviada (embed + anexo, sem content)', async () => {
		const { bridge, sent, settle } = fixture();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(Buffer.from('conteúdo do arquivo'), { status: 200 });
		const message = discordMessage('');
		(message as never as { attachments: unknown[] }).attachments = [
			{ id: 'a1', name: 'nota.txt', contentType: 'text/plain', size: 12, url: 'https://cdn.example.com/nota.txt' }
		];

		try {
			await bridge.onDiscordMessage(message as never);
			await settle();
		} finally {
			globalThis.fetch = originalFetch;
		}

		expect(sent.length).toBe(1);
		expect(sent[0]!.content).toBeUndefined();
		expect(sent[0]!.embeds?.[0]?.description).toBe('');
	});

	it('texto longo é particionado no limite do embed, não no limite do content', async () => {
		const { bridge, sent, settle } = fixture();

		await bridge.onDiscordMessage(discordMessage('a'.repeat(5000)) as never);
		await settle();

		expect(sent.length).toBe(2);
		for (const m of sent) {
			expect(m.content).toBeUndefined();
			expect((m.embeds?.[0]?.description ?? '').length).toBeLessThanOrEqual(4192);
		}
	});
});
