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
