import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { avatarAttachmentName } from '../src/bridge/embeds.js';
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

/** sha do avatar anexado na mensagem ponte (sem media server público). */
const AVATAR_SHA = 'e69964cab988485291ba1701da0b1101ee4e4220b87612fcef2041afa6c2559c';
const AVATAR_REF = `attachment://avatar-${AVATAR_SHA}.png`;

interface EmbedSnapshot {
	author?: { name: string; icon_url?: string };
	title?: string;
	description?: string;
	footer?: { text: string };
}

interface FakeDiscord {
	edits: { messageId: string; embeds?: EmbedSnapshot[]; files?: { name: string }[] }[];
	isSelf: (id?: string | null) => boolean;
	edit: (channelId: string, messageId: string, options: unknown) => Promise<void>;
	react: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	unreact: (channelId: string, messageId: string, emoji: string) => Promise<void>;
}

const fakeDiscord = (): FakeDiscord => {
	const edits: FakeDiscord['edits'] = [];
	return {
		edits,
		isSelf: () => false,
		edit: async (_c, messageId, options) => {
			const o = options as { embeds?: EmbedSnapshot[]; files?: { name: string; buffer: Buffer }[] };
			edits.push({ messageId, embeds: o.embeds, files: o.files?.map((f) => ({ name: f.name })) });
		},
		react: async () => {},
		unreact: async () => {}
	};
};

const fixture = (discord: FakeDiscord) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, {
		maxAttempts: cfg.bridge.maxAttempts,
		baseMs: cfg.bridge.backoffBaseMs,
		maxMs: cfg.bridge.backoffMaxMs
	});
	const api = { editMessage: async () => ({}) };
	const media = {
		readFor: (sha: string) => (sha === AVATAR_SHA ? Buffer.from('avatar') : undefined),
		extFor: () => 'png'
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, {} as never, discord as never, media as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	store.mapMessage({
		link_id: link.id,
		direction: 'papo_to_discord',
		papo_message_id: 'pm1',
		discord_message_id: '9999',
		rendered: 'oi',
		bridge_embed: {
			author: { name: 'Jenoso', icon_url: AVATAR_REF },
			description: 'oi',
			footer: { text: '🕒 18:09 · Papo' }
		},
		footer_base: '🕒 18:09 · Papo'
	});
	const settle = async (): Promise<void> => {
		// `onPapoEvent` é fire-and-forget: dá tempo do job entrar na fila antes de esvaziar.
		await new Promise((r) => setTimeout(r, 40));
		const until = Date.now() + 1200;
		while (Date.now() < until && (outbox.counts().in_flight > 0 || outbox.counts().pending > 0)) {
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	return { store, outbox, bridge, link, settle };
};

describe('edição no Papo → cópia no Discord', () => {
	it('re-renderiza o card com o autor e o avatar salvos (não descarta o embed)', async () => {
		const discord = fakeDiscord();
		const { bridge, settle } = fixture(discord);

		bridge.onPapoEvent({
			type: 'message_edit',
			id: 'pm1',
			channel_id: 'chan-1',
			content: 'editado',
			edited_at: '2026-10-09T18:10:00Z'
		});
		await settle();

		expect(discord.edits).toHaveLength(1);
		const embed = discord.edits[0]!.embeds?.[0];
		expect(embed?.author).toEqual({ name: 'Jenoso', icon_url: AVATAR_REF });
		expect(embed?.description).toBe('editado');
		expect(embed?.footer?.text).toContain('✏️ editado · ');
		expect(embed?.footer?.text).toContain('🕒 18:09 · Papo');
	});

	it('reenvia o anexo de avatar que o embed referencia', async () => {
		const discord = fakeDiscord();
		const { bridge, settle } = fixture(discord);

		bridge.onPapoEvent({
			type: 'message_edit',
			id: 'pm1',
			channel_id: 'chan-1',
			content: 'editado',
			edited_at: '2026-10-09T18:10:00Z'
		});
		await settle();

		expect(discord.edits[0]!.files).toEqual([{ name: avatarAttachmentName(AVATAR_SHA, 'png') }]);
	});

	it('grava o texto novo no snapshot: o refresh de rodapé não reenvia o texto antigo', async () => {
		const discord = fakeDiscord();
		const { store, bridge, settle } = fixture(discord);

		bridge.onPapoEvent({
			type: 'message_edit',
			id: 'pm1',
			channel_id: 'chan-1',
			content: 'editado',
			edited_at: '2026-10-09T18:10:00Z'
		});
		await settle();

		const map = store.findMapByPapo('pm1')[0]!;
		expect(map.rendered).toBe('editado');
		expect((JSON.parse(map.bridge_embed!) as EmbedSnapshot).description).toBe('editado');

		bridge.onPapoEvent({ type: 'react_update', message_id: 'pm1', emoji_id: null, unicode: '👍', count: 2 });
		await settle();

		const last = discord.edits.at(-1)!.embeds?.[0];
		expect(last?.description).toContain('👍 2');
		expect(last?.description).toContain('editado');
		expect(last?.footer?.text).not.toContain('👍');
	});

	it('preview de link do Papo entra atrás do card da ponte', async () => {
		const discord = fakeDiscord();
		const { bridge, settle } = fixture(discord);

		bridge.onPapoEvent({
			type: 'message_embeds_update',
			channel_id: 'chan-1',
			message_id: 'pm1',
			embeds: [{ id: 'e1', source_type: 'link', title: 'Link', url: 'https://example.com' }]
		});
		await settle();

		const embeds = discord.edits[0]!.embeds ?? [];
		expect(embeds).toHaveLength(2);
		expect(embeds[0]?.author?.name).toBe('Jenoso');
		expect(embeds[1]?.title).toBe('Link');
	});
});
