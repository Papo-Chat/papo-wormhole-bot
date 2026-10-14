import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GatewayIntentBits } from 'discord.js';
import { DiscordBridge, buildSendPayload } from '../src/discord/bridge.js';

describe('payload de envio (discord.js 14)', () => {
	it('usa reply.messageReference: messageReference na raiz é ignorado pela lib', () => {
		const payload = buildSendPayload({ content: 'oi', replyTo: '1234' });
		expect(payload.reply).toEqual({ messageReference: '1234', failIfNotExists: false });
		expect('messageReference' in payload).toBe(false);
	});

	it('nunca propaga menções (anti-ping)', () => {
		expect(buildSendPayload({ content: '<@123> oi' }).allowedMentions).toEqual({ parse: [] });
	});

	it('mapeia arquivos para AttachmentPayload', () => {
		const payload = buildSendPayload({ files: [{ name: 'a.txt', buffer: Buffer.from('x') }] });
		expect(payload.files).toEqual([{ attachment: expect.any(Buffer), name: 'a.txt' }]);
	});

	it('omite embeds e files vazios', () => {
		const payload = buildSendPayload({ embeds: [], files: [] });
		expect(payload.embeds).toBeUndefined();
		expect(payload.files).toBeUndefined();
	});
});

describe('edit de mensagem: anexos preservados', () => {
	const stub = (attachments: { id: string; name: string }[]) => {
		const bridge = new DiscordBridge({ token: 'x', handlers: {} });
		const payloads: { attachments?: unknown; files?: unknown }[] = [];
		bridge.fetchMessage = async () =>
			({
				attachments,
				edit: async (options: unknown) => void payloads.push(options as never)
			}) as never;
		return { bridge, payloads };
	};

	it('redeclara os anexos existentes: o Discord apaga o que não vem no edit', async () => {
		const { bridge, payloads } = stub([{ id: '111', name: 'foto.png' }]);

		await bridge.edit('111', '222', {
			embeds: [{ description: 'novo texto' }],
			files: [{ name: 'avatar-aa.png', buffer: Buffer.from('a') }]
		});

		expect(payloads[0]?.attachments).toEqual([{ id: '111' }]);
		expect(payloads[0]?.files).toEqual([{ attachment: expect.any(Buffer), name: 'avatar-aa.png' }]);
		await bridge.destroy();
	});

	it('anexo reenviado não é mantido em duplicidade', async () => {
		const { bridge, payloads } = stub([
			{ id: '111', name: 'foto.png' },
			{ id: '222', name: 'avatar-aa.png' }
		]);

		await bridge.edit('111', '222', {
			embeds: [{ description: 'novo texto' }],
			files: [{ name: 'avatar-aa.png', buffer: Buffer.from('a') }]
		});

		expect(payloads[0]?.attachments).toEqual([{ id: '111' }]);
		await bridge.destroy();
	});

	it('edit só de embed mantém os anexos da mensagem', async () => {
		const { bridge, payloads } = stub([{ id: '111', name: 'foto.png' }]);

		await bridge.edit('111', '222', { embeds: [{ description: 'novo texto' }] });

		expect(payloads[0]?.attachments).toEqual([{ id: '111' }]);
		expect(payloads[0]?.files).toBeUndefined();
		await bridge.destroy();
	});
});

describe('intents do bridge', () => {
	it('inclui GuildMessageReactions: sem ele nenhum evento de reação chega', () => {
		const bridge = new DiscordBridge({ token: 'x', handlers: {} });
		const intents = bridge.client.options.intents;
		expect(intents.has(GatewayIntentBits.Guilds)).toBe(true);
		expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(true);
		expect(intents.has(GatewayIntentBits.GuildMessageReactions)).toBe(true);
		expect(intents.has(GatewayIntentBits.MessageContent)).toBe(true);
		expect(intents.has(GatewayIntentBits.GuildPresences)).toBe(false);
		void bridge.destroy();
	});

	it('liga GuildPresences quando presences: true', () => {
		const bridge = new DiscordBridge({ token: 'x', handlers: {}, presences: true });
		expect(bridge.client.options.intents.has(GatewayIntentBits.GuildPresences)).toBe(true);
		void bridge.destroy();
	});
});

describe('link de mensagem (reply de webhook)', () => {
	it('compõe o link permanente a partir do guild do canal', () => {
		const bridge = new DiscordBridge({ token: 'x', handlers: {} });
		bridge.client.channels.cache.set('222', { guildId: '999' } as never);
		expect(bridge.messageLink('222', '333')).toBe('https://discord.com/channels/999/222/333');
		void bridge.destroy();
	});

	it('sem guild conhecido não inventa link', () => {
		const bridge = new DiscordBridge({ token: 'x', handlers: {} });
		expect(bridge.messageLink('222', '333')).toBeUndefined();
		void bridge.destroy();
	});
});

describe('threads', () => {
	it('encaminha threadCreate e threadUpdate para os handlers do bridge', () => {
		const events: unknown[][] = [];
		const bridge = new DiscordBridge({
			token: 'x',
			handlers: {
				onThreadCreate: (threadId, parentId, name) => events.push(['create', threadId, parentId, name]),
				onThreadUpdate: (threadId, parentId, name, archived) => events.push(['update', threadId, parentId, name, archived])
			}
		});
		bridge.client.emit('threadCreate', { id: '333', parentId: '111', name: 'conversa' } as never, true);
		bridge.client.emit(
			'threadUpdate',
			{ id: '333', parentId: '111', name: 'conversa', archived: false } as never,
			{ id: '333', parentId: '111', name: 'conversa', archived: true } as never
		);
		expect(events).toEqual([
			['create', '333', '111', 'conversa'],
			['update', '333', '111', 'conversa', true]
		]);
		void bridge.destroy();
	});

	it('thread não linkada não é conferida como thread', () => {
		const bridge = new DiscordBridge({ token: 'x', handlers: {} });
		bridge.client.channels.cache.set('222', { guildId: '999' } as never);
		expect(bridge.isThread('222')).toBe(false);
		void bridge.destroy();
	});
});

describe('refresh de link de anexo (assinatura vencida)', () => {
	const url = 'https://cdn.discordapp.com/attachments/111/222/image0-6.gif';
	const json = (payload: unknown, status = 200) =>
		new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

	/** O bridge chama o endpoint uma ou duas vezes (a forma do token pode ser trocada). */
	const withFetch = (respond: (call: number, body: Record<string, unknown>) => Response) => {
		const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
			calls.push({ url: String(input), body, authorization: new Headers(init?.headers).get('authorization') });
			return respond(calls.length, body);
		}) as never;
		const bridge = new DiscordBridge({ token: 'TOKEN', handlers: {} });
		const run = async () => {
			try {
				return await bridge.refreshMediaUrl(url);
			} finally {
				globalThis.fetch = original;
				await bridge.destroy();
			}
		};
		return { calls, run };
	};

	it('pede a assinatura nova no endpoint do Discord', async () => {
		const { calls, run } = withFetch(() => json({ refreshed_urls: [{ original: url, refreshed: `${url}?ex=68f0a1b2&is=68ef4f62&hm=beef` }] }));
		expect(await run()).toBe(`${url}?ex=68f0a1b2&is=68ef4f62&hm=beef`);
		expect(calls[0]?.url).toBe('https://discord.com/api/v9/attachments/refresh-urls');
		expect(calls[0]?.body).toEqual({ attachment_urls: [url] });
		expect(calls[0]?.authorization).toBe('Bot TOKEN');
	});

	it('403 com `Bot <token>` tenta o token cru: o endpoint é do cliente', async () => {
		const { calls, run } = withFetch((call) =>
			call === 1 ? json({ code: 40333 }, 403) : json({ refreshed_urls: [{ original: url, refreshed: `${url}?ex=1&is=1&hm=aa` }] })
		);
		expect(await run()).toBe(`${url}?ex=1&is=1&hm=aa`);
		expect(calls.map((c) => c.authorization)).toEqual(['Bot TOKEN', 'TOKEN']);
	});

	it('aceita a resposta indexada pelo sha256 do caminho (`asset_lookup`)', async () => {
		const key = createHash('sha256').update('/attachments/111/222/image0-6.gif').digest('hex');
		const { run } = withFetch(() => json({ asset_lookup: { [key]: { updated: `${url}?ex=2&is=2&hm=bb`, expires_at: '2026-10-15T00:00:00+00:00' } } }));
		expect(await run()).toBe(`${url}?ex=2&is=2&hm=bb`);
	});

	it('resposta sem link utilizável não inventa nada', async () => {
		const { run } = withFetch(() => json({}));
		expect(await run()).toBeUndefined();
	});

	it('recusa do endpoint não derruba o envio', async () => {
		const { run } = withFetch(() => json({ code: 429 }, 429));
		expect(await run()).toBeUndefined();
	});

	it('sem token não há o que renovar', async () => {
		const bridge = new DiscordBridge({ token: '', handlers: {} });
		expect(await bridge.refreshMediaUrl(url)).toBeUndefined();
		await bridge.destroy();
	});
});
