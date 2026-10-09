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
