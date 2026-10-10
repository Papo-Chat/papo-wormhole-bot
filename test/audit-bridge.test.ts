import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox, type OutboxRow } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { settleQueue } from './helpers/settle.js';
import { PapoApiError } from '../src/papo/types.js';
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

const BOT_ID = 'bot-1';
const PAPO_USER = 'papo-user-1';

interface EmbedLike {
	description?: string;
	footer?: { text?: string };
}

interface FakeDiscord {
	selfId: string;
	sendAttempts: { channelId: string; footers: string[] }[];
	edits: { messageId: string; embeds: EmbedLike[] }[];
	deletes: string[];
	reacts: { messageId: string; emoji: string }[];
	unreacts: { messageId: string; emoji: string }[];
	pins: { messageId: string; pinned: boolean }[];
	recent: { id: string; footers: string[]; createdAt: number }[];
	destroyed: number;
	send: (channelId: string, options: { embeds?: EmbedLike[] }) => Promise<{ id: string }>;
	edit: (channelId: string, messageId: string, options: { embeds?: EmbedLike[] }) => Promise<void>;
	delete: (channelId: string, messageId: string) => Promise<void>;
	react: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	unreact: (channelId: string, messageId: string, emoji: string) => Promise<void>;
	setPin: (channelId: string, messageId: string, pinned: boolean) => Promise<void>;
	recentByAuthor: (channelId: string, userId: string, limit: number) => Promise<{ id: string; footers: string[]; createdAt: number }[]>;
	destroy: () => Promise<void>;
	isSelf: (id?: string | null) => boolean;
	fetchMessage: (channelId: string, messageId: string) => Promise<unknown>;
	loadUnavailableEmojis: () => Promise<number>;
	guildsCached: () => boolean;
	findGuildEmoji: () => undefined;
}

const fakeDiscord = (): FakeDiscord => {
	const discord: FakeDiscord = {
		selfId: BOT_ID,
		sendAttempts: [],
		edits: [],
		deletes: [],
		reacts: [],
		unreacts: [],
		pins: [],
		recent: [],
		destroyed: 0,
		send: async (channelId, options) => {
			discord.sendAttempts.push({ channelId, footers: (options.embeds ?? []).map((e) => e.footer?.text ?? '') });
			return { id: `d${discord.sendAttempts.length}` };
		},
		edit: async (_channelId, messageId, options) => void discord.edits.push({ messageId, embeds: options.embeds ?? [] }),
		delete: async (_channelId, messageId) => void discord.deletes.push(messageId),
		react: async (_channelId, messageId, emoji) => void discord.reacts.push({ messageId, emoji }),
		unreact: async (_channelId, messageId, emoji) => void discord.unreacts.push({ messageId, emoji }),
		setPin: async (_channelId, messageId, pinned) => void discord.pins.push({ messageId, pinned }),
		recentByAuthor: async () => discord.recent,
		destroy: async () => void discord.destroyed++,
		isSelf: (id) => id === BOT_ID,
		fetchMessage: async (_channelId, messageId) => ({ id: messageId, channelId: '111', author: { id: 'user-1' }, content: 'texto' }),
		loadUnavailableEmojis: async () => 0,
		guildsCached: () => true,
		findGuildEmoji: () => undefined
	};
	return discord;
};

const transient = (message: string) => Object.assign(new Error(message), { status: 503 });

const fixture = (discord: FakeDiscord = fakeDiscord()) => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: cfg.bridge.maxAttempts, baseMs: cfg.bridge.backoffBaseMs, maxMs: cfg.bridge.backoffMaxMs });
	const ws = { closed: 0, close: () => void ws.closed++, connect: () => {} };
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u', nickname: null })),
		whoami: async () => ({ id: 'bot', username: 'bot' }),
		ensureSession: async () => true,
		sent: [] as { embeds?: EmbedLike[] }[],
		sendMessage: async (input: { embeds?: EmbedLike[] }) => {
			api.sent.push(input);
			return { id: 'pm-new', channel_id: 'chan-1', author_id: 'bot', content: null, created_at: new Date().toISOString() };
		},
		edits: [] as { id: string; embeds: EmbedLike[] }[],
		editMessage: async (id: string, _content: string, embeds: EmbedLike[]) => void api.edits.push({ id, embeds }),
		deleted: [] as string[],
		deleteMessage: async (id: string) => void api.deleted.push(id),
		reacts: [] as string[],
		addReaction: async (_channelId: string, id: string) => void api.reacts.push(id),
		unreacts: [] as string[],
		removeReaction: async (_channelId: string, id: string) => void api.unreacts.push(id),
		pins: [] as { id: string; pinned: boolean }[],
		setPin: async (_channelId: string, id: string, pinned: boolean) => void api.pins.push({ id, pinned }),
		recent: [] as { id: string; author_id: string; created_at: string; embeds?: { footer?: { text?: string } }[] }[],
		listMessages: async () => ({ messages: api.recent })
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, ws as never, discord as never, {} as never);
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const settle = (quietMs = 700) => settleQueue(outbox, quietMs, 5000);
	return { db, store, outbox, bridge, link, api, ws, discord, settle };
};

const map = (
	store: Store,
	linkId: number,
	direction: 'papo_to_discord' | 'discord_to_papo',
	papoId: string,
	discordId: string
) =>
	store.mapMessage({
		link_id: linkId,
		direction,
		papo_message_id: papoId,
		discord_message_id: discordId,
		rendered: 'oi',
		bridge_embed: { description: 'oi', footer: { text: '🕒 · Papo' } },
		footer_base: '🕒 · Papo'
	});

const papoMessage = (id: string, content = 'olá') => ({
	type: 'message',
	id,
	channel_id: 'chan-1',
	author_id: PAPO_USER,
	content,
	created_at: new Date().toISOString(),
	attachments: []
});

const discordMessage = (id: string, content: string, editedTimestamp: number) => ({
	id,
	channelId: '111',
	partial: false,
	channel: { isThread: () => false },
	author: { id: 'user-1', username: 'jenga', displayName: 'Jenga', displayAvatarURL: () => '' },
	member: { displayName: 'Jenga' },
	content,
	createdAt: new Date(editedTimestamp - 10_000),
	createdTimestamp: editedTimestamp - 10_000,
	editedTimestamp,
	attachments: [],
	embeds: []
});

const react = (messageId: string, count: number) =>
	({ type: 'react_update', message_id: messageId, emoji_id: null, unicode: '👍', count }) as never;

describe('P1.1 / P1.7: transição de estado 1→0→1', () => {
	it('reação do Papo reaplica no Discord depois de ser removida', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent(react('pm1', 1));
		await settle();
		bridge.onPapoEvent(react('pm1', 0));
		await settle();
		bridge.onPapoEvent(react('pm1', 1));
		await settle();

		expect(discord.reacts.map((r) => r.emoji)).toEqual(['👍', '👍']);
		expect(discord.unreacts.map((r) => r.emoji)).toEqual(['👍']);
	});

	it('reações seguidas enquanto o worker está ocupado viram um único job', async () => {
		const discord = fakeDiscord();
		discord.send = async () => {
			discord.sendAttempts.push({ channelId: '111', footers: [] });
			await new Promise((r) => setTimeout(r, 400));
			return { id: 'd-slow' };
		};
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		// o worker do link está ocupado criando outra cópia: as transições se acumulam na fila
		bridge.onPapoEvent(papoMessage('pm0') as never);
		await new Promise((r) => setTimeout(r, 60));
		bridge.onPapoEvent(react('pm1', 1));
		bridge.onPapoEvent(react('pm1', 0));
		bridge.onPapoEvent(react('pm1', 1));
		await settle();

		expect(outbox.list('done').filter((r) => r.kind === 'reaction')).toHaveLength(1);
		expect(discord.reacts).toHaveLength(1);
		expect(discord.unreacts).toEqual([]);
	});

	it('reação do Discord reaplica no Papo depois de ser removida', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, api, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		await bridge.onDiscordReaction('8888', '111', '👍', null, false, true, 1);
		await settle();
		await bridge.onDiscordReaction('8888', '111', '👍', null, false, false, 0);
		await settle();
		await bridge.onDiscordReaction('8888', '111', '👍', null, false, true, 1);
		await settle();

		expect(api.reacts).toEqual(['pm2', 'pm2']);
		expect(api.unreacts).toEqual(['pm2']);
	});

	it('contagem da cópia Discord desconta a reação do próprio bridge', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, api, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');
		// o espelho do bridge está na cópia Discord
		store.markMirrorReaction({ linkId: link.id, side: 'discord', destinationMessageId: '9999', emoji: 'u:👍' });

		// outra pessoa reagiu na cópia: a contagem 2 inclui o espelho
		await bridge.onDiscordReaction('9999', '111', '👍', null, false, true, 2);
		await settle();
		expect(api.reacts).toEqual(['pm1']);

		// ela removeu a dela: sobra só o espelho, então nada humana justifica o espelho no Papo
		await bridge.onDiscordReaction('9999', '111', '👍', null, false, false, 1);
		await settle();
		expect(api.unreacts).toEqual(['pm1']);
	});

	it('pino true→false→true reflete as três transições no Discord', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, settle } = fixture(discord);
		store.setChannelLinkFlag(link.id, 'bridge_pins', 1);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		for (const pinned of [true, false, true]) {
			bridge.onPapoEvent({ type: 'message_pin', message_id: 'pm1', is_pinned: pinned } as never);
			await settle(200);
		}

		expect(discord.pins).toEqual([
			{ messageId: '9999', pinned: true },
			{ messageId: '9999', pinned: false },
			{ messageId: '9999', pinned: true }
		]);
	});
});

describe('P1.2: marca de eco de uso único', () => {
	it('o eco da própria reação não vira segunda chamada, e a próxima reação legítima passa', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, api, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		// o Papo transmite o `react_update` antes de devolver o POST
		api.addReaction = async (_channelId: string, id: string) => {
			api.reacts.push(id);
			bridge.onPapoEvent(react('pm2', 1));
		};

		await bridge.onDiscordReaction('8888', '111', '👍', null, false, true, 1);
		await settle();
		expect(api.reacts).toEqual(['pm2']);
		expect(discord.reacts).toEqual([]);

		// outra pessoa reagiu no Papo com o mesmo emoji: não é eco
		bridge.onPapoEvent(react('pm2', 2));
		await settle();
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['8888']);
	});

	it('falha da API limpa a marca para que o retry reconheça o próprio eco', async () => {
		const discord = fakeDiscord();
		const { store, bridge, link, api, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		api.addReaction = async () => {
			throw new PapoApiError('HTTP 403', 403);
		};
		await bridge.onDiscordReaction('8888', '111', '👍', null, false, true, 1);
		await settle();

		expect(store.isSelfReaction({ linkId: link.id, destinationMessageId: 'pm2', emoji: 'u:👍', withinSeconds: 60 })).toBe(false);

		// a marca sumiu: a próxima reação legítima no Papo é propagada
		api.addReaction = async (_channelId: string, id: string) => void api.reacts.push(id);
		bridge.onPapoEvent(react('pm2', 1));
		await settle();
		expect(discord.reacts.map((r) => r.messageId)).toEqual(['8888']);
	});
});

describe('P1.3: delete que chega antes do mapeamento', () => {
	it('delete sem mapa não gera job e impede a criação posterior da cópia', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, settle } = fixture(discord);

		bridge.onPapoEvent({ type: 'message_delete', id: 'pm9', channel_id: 'chan-1' } as never);
		await settle(200);
		expect(outbox.list('pending').filter((r) => r.kind === 'delete')).toEqual([]);
		expect(store.isTombstoned('papo', 'pm9')).toBe(true);

		bridge.onPapoEvent(papoMessage('pm9') as never);
		await settle(200);
		expect(discord.sendAttempts).toEqual([]);
		expect(store.findMapByPapo('pm9')).toEqual([]);
	});

	it('delete do Discord sem mapa tombstoneia e não apaga nada no Papo', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, api, settle } = fixture(discord);

		await bridge.onDiscordDelete(discordMessage('9999', 'texto', Date.now()) as never);
		await settle(200);

		expect(outbox.list('pending').filter((r) => r.kind === 'delete')).toEqual([]);
		expect(store.isTombstoned('discord', '9999')).toBe(true);
		expect(api.deleted).toEqual([]);
	});

	it('delete durante o envio apaga a cópia recém-criada', async () => {
		const discord = fakeDiscord();
		discord.send = async () => {
			discord.sendAttempts.push({ channelId: '111', footers: [] });
			await new Promise((r) => setTimeout(r, 120));
			return { id: 'd-late' };
		};
		const { store, bridge, settle } = fixture(discord);

		bridge.onPapoEvent(papoMessage('pm1') as never);
		await new Promise((r) => setTimeout(r, 40));
		bridge.onPapoEvent({ type: 'message_delete', id: 'pm1', channel_id: 'chan-1' } as never);
		await settle();

		expect(discord.deletes).toEqual(['d-late']);
		expect(store.findMapByPapo('pm1')[0]?.deleted).toBe(1);
	});
});

describe('P1.5: envio de resultado incerto não duplica a cópia', () => {
	it('reconhece a cópia já criada no Discord em vez de enviar de novo', async () => {
		const discord = fakeDiscord();
		let createdFooter: string | undefined;
		discord.send = async (channelId, options) => {
			const footers = (options.embeds ?? []).map((e) => e.footer?.text ?? '');
			discord.sendAttempts.push({ channelId, footers });
			createdFooter = footers[0];
			// o Discord aceitou e o bridge perdeu a resposta: a cópia existe
			discord.recent.push({ id: 'd-existing', footers, createdAt: Date.now() });
			throw transient('socket hang up');
		};
		const { store, bridge, settle } = fixture(discord);

		bridge.onPapoEvent(papoMessage('pm1') as never);
		await settle();

		expect(discord.sendAttempts).toHaveLength(1);
		expect(createdFooter).toBeTruthy();
		expect(store.findMapByPapo('pm1')[0]?.discord_message_id).toBe('d-existing');
	});

	it('reconhece a cópia já criada no Papo em vez de enviar de novo', async () => {
		const discord = fakeDiscord();
		const { store, bridge, api, settle } = fixture(discord);
		// a identidade do bot é o que permite reconhecer a cópia como mensagem nossa
		(bridge as unknown as { papoUserId: string }).papoUserId = 'bot';
		let created: { id: string; embeds: EmbedLike[] } | undefined;
		api.sendMessage = async (input) => {
			api.sent.push(input);
			created = { id: 'pm-existing', embeds: input.embeds ?? [] };
			api.recent.push({
				id: 'pm-existing',
				author_id: 'bot',
				created_at: new Date().toISOString(),
				embeds: input.embeds
			});
			throw transient('socket hang up');
		};

		await bridge.onDiscordMessage(discordMessage('dm-1', 'teste', Date.now()) as never);
		await settle();

		expect(api.sent).toHaveLength(1);
		expect(created).toBeDefined();
		expect(store.findMapByDiscord('dm-1')[0]?.papo_message_id).toBe('pm-existing');
	});

	it('parada do bridge aguarda o worker em voo terminar', async () => {
		const discord = fakeDiscord();
		const { outbox, bridge, ws, settle } = fixture(discord);
		let done = false;
		discord.send = async () => {
			discord.sendAttempts.push({ channelId: '111', footers: [] });
			await new Promise((r) => setTimeout(r, 200));
			done = true;
			return { id: 'd-slow' };
		};

		bridge.onPapoEvent(papoMessage('pm1') as never);
		await new Promise((r) => setTimeout(r, 40));
		await bridge.stop();

		expect(done).toBe(true);
		expect(outbox.counts().done).toBe(1);
		expect(ws.closed).toBe(1);
		expect(discord.destroyed).toBe(1);
		await settle(100);
	});

	it('depois da parada nenhum evento novo entra na fila', async () => {
		const discord = fakeDiscord();
		const { outbox, bridge, settle } = fixture(discord);
		await bridge.stop();

		bridge.onPapoEvent(react('pm1', 1));
		await bridge.onDiscordReaction('8888', '111', '👍', null, false, true, 1);
		await settle(100);

		expect(outbox.counts().pending).toBe(0);
	});
});

describe('P1.6: flush de eventos adiados é transacional', () => {
	it('falha ao enfileirar devolve os eventos adiados para o próximo flush', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);

		bridge.onPapoEvent(react('pm1', 2));
		await settle(200);
		expect(store.peekDeferredEvents('papo', 'pm1')).toHaveLength(1);

		const original = outbox.enqueue.bind(outbox);
		outbox.enqueue = (input: Parameters<Outbox['enqueue']>[0]): OutboxRow extends never ? never : ReturnType<Outbox['enqueue']> => {
			if (input.kind === 'reaction') throw new Error('enqueue falhou');
			return original(input);
		};

		map(store, link.id, 'papo_to_discord', 'pm1', '9999');
		const flush = (bridge as unknown as { flushDeferred: (s: 'papo', id: string, linkId: number) => void }).flushDeferred;
		expect(() => flush.call(bridge, 'papo', 'pm1', link.id)).toThrow('enqueue falhou');
		expect(store.peekDeferredEvents('papo', 'pm1')).toHaveLength(1);

		outbox.enqueue = original;
		flush.call(bridge, 'papo', 'pm1', link.id);
		await settle(200);
		expect(store.peekDeferredEvents('papo', 'pm1')).toEqual([]);
		expect(discord.reacts.map((r) => r.emoji)).toEqual(['👍']);
	});
});

describe('P1.8: edição fora de ordem', () => {
	it('edição mais antiga não sobrescreve a cópia Discord (Papo→Discord)', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent({
			type: 'message_edit',
			id: 'pm1',
			channel_id: 'chan-1',
			content: 'novo',
			edited_at: '2026-10-09T12:00:00Z'
		} as never);
		bridge.onPapoEvent({
			type: 'message_edit',
			id: 'pm1',
			channel_id: 'chan-1',
			content: 'velho',
			edited_at: '2026-10-09T11:00:00Z'
		} as never);
		await settle(200);

		expect(discord.edits.map((e) => e.messageId)).toEqual(['9999']);
		expect(discord.edits[0]!.embeds[0]?.description).toContain('novo');
		expect(store.findMapByPapo('pm1')[0]?.edit_revision).toBe('2026-10-09T12:00:00Z');
		expect(outbox.counts().pending).toBe(0);
		expect(outbox.counts().dead).toBe(0);
	});

	it('edição obsoleta executada depois do estado mais recente é ignorada (Papo→Discord)', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');

		bridge.onPapoEvent({
			type: 'message_edit',
			id: 'pm1',
			channel_id: 'chan-1',
			content: 'novo',
			edited_at: '2026-10-09T12:00:00Z'
		} as never);
		await settle(200);

		outbox.enqueue({
			linkId: link.id,
			direction: 'to_discord',
			kind: 'edit',
			dedupeKey: 'papo-edit:pm1:0:atrasada',
			revision: '2026-10-09T10:00:00Z',
			payload: {
				job: {
					kind: 'edit',
					side: 'papo',
					linkId: link.id,
					sourceMessageId: 'pm1',
					targetChannelId: '111',
					chunkIndex: 0,
					chunkTotal: 1,
					text: 'velho',
					revision: '2026-10-09T10:00:00Z'
				}
			}
		});
		await bridge.drain();
		await settle(200);

		expect(discord.edits.map((e) => e.messageId)).toEqual(['9999']);
		expect(store.findMapByPapo('pm1')[0]?.edit_revision).toBe('2026-10-09T12:00:00Z');
	});

	it('edição mais antiga não sobrescreve a cópia no Papo (Discord→Papo)', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, api, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');
		const now = Date.now();

		await bridge.onDiscordEdit(undefined as never, discordMessage('8888', 'novo', now) as never);
		await bridge.onDiscordEdit(undefined as never, discordMessage('8888', 'velho', now - 60_000) as never);
		await settle(200);

		expect(api.edits.map((e) => e.id)).toEqual(['pm2']);
		expect(api.edits[0]!.embeds[0]?.description).toContain('novo');
		expect(store.findMapByDiscord('8888')[0]?.edit_revision).toBe(new Date(now).toISOString());
		expect(outbox.counts().pending).toBe(0);
		expect(outbox.counts().dead).toBe(0);
	});
});

describe('P2.1: resumo de reações agrupa sem perder a última contagem', () => {
	it('três contagens seguidas geram um único refresh com a contagem final', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, api, settle } = fixture(discord);
		map(store, link.id, 'discord_to_papo', 'pm2', '8888');

		for (const count of [1, 2, 3]) bridge.onPapoEvent(react('pm2', count));
		await settle();

		const footerJobs = outbox.list('done').filter((r) => r.kind === 'edit');
		expect(footerJobs).toHaveLength(1);
		expect(api.edits.map((e) => e.id)).toEqual(['pm2']);
		expect(api.edits[0]!.embeds[0]?.description).toContain('👍 3');
	});

	it('reação que falha reagenda o refresh do rodapé', async () => {
		const discord = fakeDiscord();
		const { store, outbox, bridge, link, settle } = fixture(discord);
		map(store, link.id, 'papo_to_discord', 'pm1', '9999');
		discord.react = async () => {
			throw transient('HTTP 503');
		};

		bridge.onPapoEvent(react('pm1', 1));
		await settle();

		// a reação não chegou ao Discord, mas o resumo do embed foi reescrito na mesma
		expect(discord.reacts).toEqual([]);
		expect(outbox.list('done').filter((r) => r.kind === 'reaction')).toEqual([]);
		expect(outbox.list('done').filter((r) => r.kind === 'edit').length).toBeGreaterThanOrEqual(1);
	});
});
