import { loadConfig } from './config.js';
import { logger, scoped } from './logger.js';
import { openDb } from './db/index.js';
import { Store } from './db/store.js';
import { Outbox } from './db/outbox.js';
import { PapoApi } from './papo/api.js';
import { PapoWs } from './papo/ws.js';
import { DiscordBridge } from './discord/bridge.js';
import { MediaStore, startMediaServer } from './bridge/media.js';
import { Bridge } from './bridge/bridge.js';
import { handleCommand, registerCommands } from './commands/commands.js';

const log = scoped('main');

async function main(): Promise<void> {
	const cfg = loadConfig();

	const db = openDb(cfg.bridge.dbPath);
	const store = new Store(db);
	const outbox = new Outbox(db, {
		maxAttempts: cfg.bridge.maxAttempts,
		baseMs: cfg.bridge.backoffBaseMs,
		maxMs: cfg.bridge.backoffMaxMs
	});

	const api = new PapoApi({
		baseUrl: cfg.papo.baseUrl,
		username: cfg.papo.username,
		password: cfg.papo.password,
		serverPassword: cfg.papo.serverPassword,
		rateLimitRps: cfg.papo.rateLimitRps,
		rateBurst: cfg.papo.rateBurst
	});
	const media = new MediaStore(store, cfg.bridge.dataDir);

	let bridge: Bridge;

	const discord = new DiscordBridge({
		token: cfg.discord.token,
		presences: true,
		store,
		handlers: {
			onMessage: (m) => void bridge.onDiscordMessage(m).catch((err) => log.error({ err }, 'discord message falhou')),
			onMessageEdit: (b, a) =>
				void bridge.onDiscordEdit(b, a).catch((err) => log.error({ err }, 'discord edit falhou')),
			onMessageDelete: (m) =>
				void bridge.onDiscordDelete(m).catch((err) => log.error({ err }, 'discord delete falhou')),
			onReactionAdd: (messageId, channelId, name, id, animated, count) =>
				void bridge.onDiscordReaction(messageId, channelId, name, id, animated, true, count).catch((err) => log.error({ err }, 'reaction add')),
			onReactionRemove: (messageId, channelId, name, id, count) =>
				void bridge.onDiscordReaction(messageId, channelId, name, id, false, false, count).catch((err) => log.error({ err }, 'reaction remove')),
			onPresence: (_guild, userId, status) => bridge.onDiscordPresence(userId, status),
			onThreadCreate: (threadId, parentId, name) =>
				void bridge.onDiscordThreadCreate(threadId, parentId, name).catch((err) => log.error({ err }, 'thread create falhou')),
			onThreadUpdate: (threadId, parentId, name, archived) => bridge.onDiscordThreadUpdate(threadId, parentId, name, archived),
			onReady: async () => {
				try {
					const guild = cfg.discord.guildId
						? discord.client.guilds.cache.get(cfg.discord.guildId) ?? (await discord.client.guilds.fetch(cfg.discord.guildId))
						: discord.firstGuild;
					await registerCommands(discord.client, guild);
				} catch (err) {
					log.error({ err }, 'falha ao registrar slash commands');
				}
				try {
					// emojis apagados/indisponíveis ficam no cache do gateway e estouram 10014 na reação
					const blocked = await discord.loadUnavailableEmojis();
					if (blocked) log.info({ blocked }, 'emojis indisponíveis no guild: excluídos das reações');
				} catch (err) {
					log.debug({ err }, 'lista de emojis do guild não carregada');
				}
			}
		}
	});

	const ws = new PapoWs({
		url: cfg.papo.wsUrl,
		getCookie: () => api.authCookie,
		onEvent: (e) => bridge.onPapoEvent(e),
		onClose: async () => {
			// sessão pode ter caído junto com a conexão
			await api.ensureSession().catch((err) => log.error({ err }, 're-auth falhou'));
		}
	});

	bridge = new Bridge(cfg, store, outbox, api, ws, discord, media);

	discord.client.on('interactionCreate', (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		void handleCommand(interaction, { store, api, bridge, outbox }).catch((err) =>
			log.error({ err, command: interaction.commandName }, 'slash command falhou')
		);
	});

	if (cfg.bridge.mediaBaseUrl) {
		const server = startMediaServer(media, cfg.bridge.mediaPort);
		log.info({ port: cfg.bridge.mediaPort }, 'media server ativo');
		process.on('exit', () => server.close());
	}

	await bridge.start();
	store.audit('info', 'boot', { links: store.listChannelLinks().length });

	// keep-alive da sessão Papo (JWT expira em 24h)
	const refreshTimer = setInterval(async () => {
		try {
			// refresh que falha por 429/5xx não é sucesso: `ensureSession` refaz o login
			await api.ensureSession();
			log.debug('sessão Papo verificada/rotacionada');
		} catch (err) {
			log.error({ err }, 'refresh de sessão falhou');
		}
	}, cfg.papo.refreshHours * 3600_000);

	// tick de retry da fila
	const drainTimer = setInterval(() => void bridge.drain().catch((err) => log.error({ err }, 'drain falhou')), 15_000);

	let closing = false;
	const shutdown = async (signal: string) => {
		if (closing) return;
		closing = true;
		log.info({ signal }, 'encerrando');
		clearInterval(refreshTimer);
		clearInterval(drainTimer);
		// para a ingestão e aguarda os workers antes de fechar o banco: fechar o SQLite no
		// meio de um envio deixaria job em voo e mapa não gravado
		await bridge.stop().catch((err) => log.error({ err }, 'encerramento do bridge falhou'));
		db.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown('SIGINT'));
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('unhandledRejection', (reason) => log.error({ reason }, 'unhandled rejection'));
}

main().catch((err) => {
	logger.fatal({ err }, 'falha ao iniciar');
	process.exit(1);
});
