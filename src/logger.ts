import { pino, type Logger } from 'pino';

let cached: Logger | undefined;

export function createLogger(level = process.env.WORMHOLE_LOG_LEVEL ?? 'info'): Logger {
	if (cached) return cached;
	cached = pino({
		level,
		base: { component: 'wormhole' },
		formatters: { level: (label) => ({ level: label }) },
		timestamp: pino.stdTimeFunctions.isoTime
	});
	return cached;
}

export const logger = createLogger();

/** Child logger scoped to a subsystem (papo, discord, bridge, outbox...). */
export function scoped(component: string): Logger {
	return logger.child({ component });
}
