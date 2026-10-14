import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';
import { Outbox } from '../src/db/outbox.js';
import { Bridge } from '../src/bridge/bridge.js';
import { settleQueue } from './helpers/settle.js';
import { formatDate } from '../src/bridge/translator.js';
import { copySignature } from '../src/bridge/signature.js';
import type { Config } from '../src/config.js';

/**
 * P1.1: reconciliação de envio incerto.
 * O rodapé com a data arredondada ao minuto não identifica a cópia: duas mensagens do mesmo
 * minuto têm o mesmo rodapé. A assinatura derivada da origem é o que reconhece a cópia certa,
 * e a tentativa remota só é registrada imediatamente antes do envio.
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
const PAPO_BOT = 'papo-bot';

const transient = (message: string) => Object.assign(new Error(message), { status: 503 });

interface PapoRecent {
	id: string;
	author_id: string;
	created_at: string;
	embeds?: { footer?: { text?: string } }[];
}

const fixture = () => {
	const db = openDb(':memory:');
	const store = new Store(db);
	const outbox = new Outbox(db, { maxAttempts: cfg.bridge.maxAttempts, baseMs: 20, maxMs: 60 });
	const api = {
		listAllEmojis: async () => [],
		summariesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u' })),
		profilesBatch: async (ids: string[]) => ids.map((id) => ({ id, username: 'u', nickname: null })),
		whoami: async () => ({ id: PAPO_BOT, username: 'bot' }),
		ensureSession: async () => true,
		sent: [] as { embeds?: { description?: string; footer?: { text?: string } }[] }[],
		sendMessage: async (input: { embeds?: { description?: string; footer?: { text?: string } }[] }) => {
			api.sent.push(input);
			return { id: `pm${api.sent.length}`, channel_id: 'chan-1', author_id: PAPO_BOT, content: null, created_at: new Date().toISOString() };
		},
		recent: [] as PapoRecent[],
		listCalls: 0,
		listMessages: async () => {
			api.listCalls += 1;
			return { messages: api.recent };
		}
	};
	const discord = {
		selfId: BOT_ID,
		sendAttempts: [] as { footers: string[] }[],
		recent: [] as { id: string; footers: string[]; createdAt: number }[],
		recentCalls: 0,
		send: async (_channelId: string, options: { embeds?: { footer?: { text?: string } }[] }) => {
			const footers = (options.embeds ?? []).map((e) => e.footer?.text ?? '');
			discord.sendAttempts.push({ footers });
			return { id: `d${discord.sendAttempts.length}` };
		},
		recentByAuthor: async () => {
			discord.recentCalls += 1;
			return discord.recent;
		},
		isSelf: (id?: string | null) => id === BOT_ID,
		guildsCached: () => true,
		findGuildEmoji: () => undefined,
		loadUnavailableEmojis: async () => 0,
		channelName: () => 'geral',
		roleName: () => undefined,
		edit: async () => {},
		delete: async () => {},
		react: async () => {},
		unreact: async () => {},
		fetchMessage: async () => undefined,
		destroy: async () => {}
	};
	const bridge = new Bridge(cfg, store, outbox, api as never, { close: () => {}, connect: () => {} } as never, discord as never, {} as never);
	(bridge as unknown as { papoUserId: string }).papoUserId = PAPO_BOT;
	const link = store.upsertChannelLink({ papo_channel_id: 'chan-1', discord_channel_id: '111' });
	const settle = (quietMs = 700) => settleQueue(outbox, quietMs, 6000);
	return { store, outbox, bridge, link, api, discord, settle };
};

/** Duas mensagens criadas no mesmo minuto: o rodapé datado é idêntico nelas. */
const SAME_MINUTE = Date.parse('2026-10-09T18:09:05Z');
const stamp = formatDate(SAME_MINUTE, 'UTC');

const discordMessage = (id: string, content: string) => ({
	id,
	channelId: '111',
	channel: { isThread: () => false },
	author: { id: 'user-1', username: 'jenga', displayName: 'Jenga', displayAvatarURL: () => '' },
	member: { displayName: 'Jenga' },
	content,
	createdAt: new Date(SAME_MINUTE),
	createdTimestamp: SAME_MINUTE,
	attachments: [],
	embeds: []
});

const papoMessage = (id: string, content = 'olá') => ({
	type: 'message',
	id,
	channel_id: 'chan-1',
	author_id: 'papo-user-1',
	content,
	created_at: new Date(SAME_MINUTE).toISOString(),
	attachments: []
});

describe('P1.1: reconciliação reconhece a cópia pela assinatura', () => {
	it('cópia antiga do mesmo minuto não é tomada pela mensagem nova (Papo)', async () => {
		const { store, outbox, bridge, api, settle } = fixture();
		// existe no Papo uma cópia antiga com exatamente o mesmo rodapé datado, sem assinatura
		api.recent.push({
			id: 'pm-old',
			author_id: PAPO_BOT,
			// posterior à origem e no mesmo minuto: só a assinatura distingue as duas
			created_at: new Date(SAME_MINUTE + 15_000).toISOString(),
			embeds: [{ footer: { text: `🕒 ${stamp} · Discord` } }]
		});

		let first = true;
		api.sendMessage = async (input) => {
			api.sent.push(input);
			if (first) {
				first = false;
				// o Papo aceitou e o bridge perdeu a resposta: nada foi criado de fato
				throw transient('socket hang up');
			}
			return { id: 'pm-new', channel_id: 'chan-1', author_id: PAPO_BOT, content: null, created_at: new Date().toISOString() };
		};

		await bridge.onDiscordMessage(discordMessage('dm-2', 'segunda mensagem') as never);
		await settle();

		// a reconciliação não pode associar o job à cópia antiga
		expect(api.sent).toHaveLength(2);
		expect(store.findMapByDiscord('dm-2')[0]?.papo_message_id).toBe('pm-new');
		expect(outbox.counts().dead).toBe(0);
	});

	it('a cópia certa é reconhecida pela assinatura mesmo com outro rodapé igual (Papo)', async () => {
		const { store, bridge, api, settle } = fixture();
		const signature = copySignature('discord', 'dm-1', 0, 0);
		let attempts = 0;
		api.sendMessage = async (input) => {
			attempts += 1;
			api.sent.push(input);
			if (attempts === 1) {
				// envio aceito pelo Papo, resposta perdida: a cópia existe com a nossa assinatura
				api.recent.push({
					id: 'pm-old',
					author_id: PAPO_BOT,
					created_at: new Date().toISOString(),
					embeds: [{ footer: { text: `🕒 ${stamp} · Discord` } }]
				});
				api.recent.push({
					id: 'pm-copy',
					author_id: PAPO_BOT,
					created_at: new Date().toISOString(),
					embeds: [{ footer: { text: `🕒 ${stamp} · Discord · ${signature}` } }]
				});
				throw transient('socket hang up');
			}
			return { id: 'pm-errada', channel_id: 'chan-1', author_id: PAPO_BOT, content: null, created_at: new Date().toISOString() };
		};

		await bridge.onDiscordMessage(discordMessage('dm-1', 'primeira mensagem') as never);
		await settle();

		// a cópia existente foi reconhecida: o envio não foi repetido
		expect(api.sent).toHaveLength(1);
		expect(store.findMapByDiscord('dm-1')[0]?.papo_message_id).toBe('pm-copy');
	});

	it('cópia antiga do mesmo minuto não é tomada pela mensagem nova (Discord)', async () => {
		const { store, bridge, discord, settle } = fixture();
		discord.recent.push({ id: 'd-old', footers: [`🕒 ${stamp} · Papo`], createdAt: SAME_MINUTE + 15_000 });

		let first = true;
		discord.send = async (_channelId, options) => {
			const footers = (options.embeds ?? []).map((e) => e.footer?.text ?? '');
			discord.sendAttempts.push({ footers });
			if (first) {
				first = false;
				throw transient('socket hang up');
			}
			return { id: 'd-new' };
		};

		bridge.onPapoEvent(papoMessage('pm1') as never);
		await settle();

		expect(discord.sendAttempts).toHaveLength(2);
		expect(store.findMapByPapo('pm1')[0]?.discord_message_id).toBe('d-new');
	});

	it('a cópia certa é reconhecida pela assinatura no Discord', async () => {
		const { store, bridge, discord, settle } = fixture();
		const signature = copySignature('papo', 'pm1', 0, 0);
		let attempts = 0;
		discord.send = async (_channelId, options) => {
			attempts += 1;
			const footers = (options.embeds ?? []).map((e) => e.footer?.text ?? '');
			discord.sendAttempts.push({ footers });
			if (attempts === 1) {
				discord.recent.push({ id: 'd-old', footers: [`🕒 ${stamp} · Papo`], createdAt: SAME_MINUTE + 15_000 });
				discord.recent.push({ id: 'd-copy', footers: [`🕒 ${stamp} · Papo · ${signature}`], createdAt: SAME_MINUTE + 1_000 });
				throw transient('socket hang up');
			}
			return { id: 'd-errada' };
		};

		bridge.onPapoEvent(papoMessage('pm1') as never);
		await settle();

		expect(discord.sendAttempts).toHaveLength(1);
		expect(store.findMapByPapo('pm1')[0]?.discord_message_id).toBe('d-copy');
	});
});

describe('P1.1: tentativa remota registrada imediatamente antes do envio', () => {
	it('falha ao preparar o anexo não empurra o job para a reconciliação', async () => {
		const { store, outbox, bridge, api, discord, settle } = fixture();
		const originalFetch = globalThis.fetch;
		let first = true;
		globalThis.fetch = async () => {
			if (first) {
				first = false;
				// o CDN do Discord respondeu mal: o anexo volta para a fila, a mensagem não morre
				return new Response(null, { status: 503 });
			}
			return new Response(Buffer.from('conteúdo'), { status: 200 });
		};

		try {
			await bridge.onDiscordMessage({
				...discordMessage('dm-1', 'com anexo'),
				attachments: [{ id: 'a1', name: 'nota.txt', contentType: 'text/plain', size: 9, url: 'https://cdn.example.com/nota.txt' }]
			} as never);
			await settle();

			// nenhuma mensagem chegou ao destino: não há o que reconciliar na nova tentativa
			expect(api.listCalls).toBe(0);
			expect(discord.recentCalls).toBe(0);
			expect(api.sent).toHaveLength(1);
			expect(store.findMapByDiscord('dm-1')[0]?.papo_message_id).toBe('pm1');
			expect(outbox.counts().dead).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('anexo que não existe na origem não derruba a mensagem: vira aviso, sem reconciliação', async () => {
		const { outbox, bridge, api, settle } = fixture();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(null, { status: 404 });
		try {
			await bridge.onDiscordMessage({
				...discordMessage('dm-1', 'anexo sumido'),
				attachments: [{ id: 'a1', name: 'nota.txt', contentType: 'text/plain', size: 9, url: 'https://cdn.example.com/nota.txt' }]
			} as never);
			await settle();

			// perder o arquivo não é motivo para perder a mensagem: o texto chega com o aviso
			expect(outbox.counts().dead).toBe(0);
			expect(api.sent).toHaveLength(1);
			expect(api.sent[0]!.embeds?.[0]?.description).toContain('não está mais disponível');
			// nada foi enviado antes de falhar: não há duplicata a reconciliar
			expect(api.listCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('depois de um envio realmente tentado a reconciliação passa a consultar o destino', async () => {
		const { bridge, api, settle } = fixture();
		let first = true;
		api.sendMessage = async (input) => {
			api.sent.push(input);
			if (first) {
				first = false;
				throw transient('socket hang up');
			}
			return { id: 'pm1', channel_id: 'chan-1', author_id: PAPO_BOT, content: null, created_at: new Date().toISOString() };
		};

		await bridge.onDiscordMessage(discordMessage('dm-1', 'texto') as never);
		await settle();

		// a segunda execução sabe que houve tentativa remota e procura a cópia antes de enviar
		expect(api.listCalls).toBeGreaterThanOrEqual(1);
		expect(api.sent).toHaveLength(2);
	});
});
