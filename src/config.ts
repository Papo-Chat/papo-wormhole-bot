import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// .env é opcional: carregado quando existe (Node >= 20.6 tem loadEnvFile).
try {
	const envPath = process.env.WORMHOLE_ENV_FILE ?? '.env';
	if (existsSync(envPath)) process.loadEnvFile(envPath);
} catch (err) {
	throw new Error(`falha ao ler o arquivo .env: ${(err as Error).message}`);
}

const Bool = z
	.enum(['1', '0', 'true', 'false', 'yes', 'no'])
	.transform((v) => v === '1' || v === 'true' || v === 'yes');

const EnvSchema = z.object({
	// ── Papo ──────────────────────────────────────────────
	PAPO_BASE_URL: z.url({ message: 'PAPO_BASE_URL deve ser uma URL absoluta' }),
	PAPO_WS_URL: z.string().optional(),
	PAPO_USERNAME: z.string().min(1),
	PAPO_PASSWORD: z.string().min(1),
	/**
	 * Senha de acesso ao servidor (servidores privados). Vazia/comentada = servidor público.
	 */
	PAPO_SERVER_PASSWORD: z
		.string()
		.optional()
		.transform((v) => (v && v.trim() ? v.trim() : undefined)),
	PAPO_REFRESH_HOURS: z.coerce.number().int().min(1).max(23).default(12),
	PAPO_BACKFILL_ON_START: Bool.default(true),
	/** Teto de requisições ao Papo (o backend limita por IP: 10/s, rajada 20). */
	PAPO_RATE_LIMIT_RPS: z.coerce.number().int().min(0).max(100).default(8),
	PAPO_RATE_BURST: z.coerce.number().int().min(1).max(100).default(12),

	// ── Discord ───────────────────────────────────────────
	DISCORD_TOKEN: z.string().min(20),
	DISCORD_GUILD_ID: z.string().optional(),
	/** Limite de upload assumido no lado Discord (bytes). Padrão: 20 MB (free). */
	DISCORD_MAX_FILE_BYTES: z.coerce.number().int().min(1024).default(20 * 1024 * 1024),
	DISCORD_MAX_MESSAGES_PER_5S: z.coerce.number().int().min(1).default(4),
	/** Quantidade máxima de webhooks do bridge por canal (Discord permite até 15). */
	WEBHOOK_BUDGET: z.coerce.number().int().min(1).max(15).default(15),

	// ── Bridge ────────────────────────────────────────────
	/** URL pública (HTTPS) do media server; sem ela o avatar do Papo não tem ícone no Discord. */
	WORMHOLE_MEDIA_BASE_URL: z.string().optional(),
	WORMHOLE_MEDIA_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
	WORMHOLE_DATA_DIR: z.string().default('./data'),
	WORMHOLE_DB_PATH: z.string().optional(),
	WORMHOLE_ADMIN_CHANNEL_ID: z.string().optional(),
	WORMHOLE_TIMEZONE: z.string().default('America/Sao_Paulo'),
	WORMHOLE_EMOJI_AUTO_IMPORT: Bool.default(true),
	WORMHOLE_PROPAGATE_MENTIONS: Bool.default(false),
	WORMHOLE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(12),
	WORMHOLE_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(1000),
	WORMHOLE_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).default(900_000),
	WORMHOLE_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
});

export interface Config {
	papo: {
		baseUrl: string;
		wsUrl: string;
		username: string;
		password: string;
		/** Senha do servidor (obrigatória quando `GET /server` → `public: false`). */
		serverPassword?: string;
		refreshHours: number;
		backfillOnStart: boolean;
		rateLimitRps: number;
		rateBurst: number;
	};
	discord: {
		token: string;
		guildId?: string;
		maxFileBytes: number;
		maxMessagesPer5s: number;
		webhookBudget?: number;
	};
	bridge: {
		dataDir: string;
		dbPath: string;
		mediaBaseUrl?: string;
		mediaPort: number;
		adminChannelId?: string;
		timezone: string;
		emojiAutoImport: boolean;
		propagateMentions: boolean;
		maxAttempts: number;
		backoffBaseMs: number;
		backoffMaxMs: number;
	};
}

function toWsUrl(httpUrl: string): string {
	const u = new URL(httpUrl);
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
	u.pathname = join(u.pathname.replace(/\/+$/, ''), 'ws');
	return u.toString();
}

export function loadConfig(): Config {
	const parsed = EnvSchema.safeParse(process.env);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
		throw new Error(`configuração inválida:\n${issues}`);
	}
	const e = parsed.data;
	const dataDir = e.WORMHOLE_DATA_DIR;
	return {
		papo: {
			baseUrl: e.PAPO_BASE_URL.replace(/\/+$/, ''),
			wsUrl: e.PAPO_WS_URL ?? toWsUrl(e.PAPO_BASE_URL),
			username: e.PAPO_USERNAME,
			password: e.PAPO_PASSWORD,
			serverPassword: e.PAPO_SERVER_PASSWORD,
			refreshHours: e.PAPO_REFRESH_HOURS,
			backfillOnStart: e.PAPO_BACKFILL_ON_START,
			rateLimitRps: e.PAPO_RATE_LIMIT_RPS,
			rateBurst: e.PAPO_RATE_BURST
		},
		discord: {
			token: e.DISCORD_TOKEN,
			guildId: e.DISCORD_GUILD_ID,
			maxFileBytes: e.DISCORD_MAX_FILE_BYTES,
			maxMessagesPer5s: e.DISCORD_MAX_MESSAGES_PER_5S,
			webhookBudget: e.WEBHOOK_BUDGET
		},
		bridge: {
			dataDir,
			dbPath: e.WORMHOLE_DB_PATH ?? join(dataDir, 'wormhole.sqlite'),
			mediaBaseUrl: e.WORMHOLE_MEDIA_BASE_URL?.replace(/\/+$/, ''),
			mediaPort: e.WORMHOLE_MEDIA_PORT,
			adminChannelId: e.WORMHOLE_ADMIN_CHANNEL_ID,
			timezone: e.WORMHOLE_TIMEZONE,
			emojiAutoImport: e.WORMHOLE_EMOJI_AUTO_IMPORT,
			propagateMentions: e.WORMHOLE_PROPAGATE_MENTIONS,
			maxAttempts: e.WORMHOLE_MAX_ATTEMPTS,
			backoffBaseMs: e.WORMHOLE_BACKOFF_BASE_MS,
			backoffMaxMs: e.WORMHOLE_BACKOFF_MAX_MS,
		}
	};
}
