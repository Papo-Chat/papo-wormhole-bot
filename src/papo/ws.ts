import WebSocket from 'ws';
import type { Logger } from 'pino';
import { scoped } from '../logger.js';
import type { PapoWsEvent } from './types.js';

export interface PapoWsOptions {
	url: string;
	/** Lido a cada handshake (o cookie muda quando a sessão é rotacionada). */
	getCookie: () => string | undefined;
	onEvent: (event: PapoWsEvent) => void;
	onOpen?: () => void;
	onClose?: (reason: string) => void;
	logger?: Logger;
	heartbeatMs?: number;
	/** Janela sem heartbeat_ack que força reconexão. */
	ackTimeoutMs?: number;
	maxBackoffMs?: number;
}

/**
 * Cliente WebSocket do Papo (`GET /ws`).
 * - handshake usa o cookie `Auth` atual;
 * - keep-alive: `{type:"heartbeat"}` → `{type:"heartbeat_ack"}`;
 * - reconexão com backoff exponencial (a sessão é revalidada antes de cada tentativa).
 */
export class PapoWs {
	private ws?: WebSocket;
	private heartbeatTimer?: NodeJS.Timeout;
	private ackTimer?: NodeJS.Timeout;
	private reconnectTimer?: NodeJS.Timeout;
	private attempts = 0;
	private closed = false;
	private readonly log: Logger;
	private readonly heartbeatMs: number;
	private readonly ackTimeoutMs: number;
	private readonly maxBackoffMs: number;

	constructor(private opts: PapoWsOptions) {
		this.log = opts.logger ?? scoped('papo:ws');
		this.heartbeatMs = opts.heartbeatMs ?? 20_000;
		this.ackTimeoutMs = opts.ackTimeoutMs ?? 30_000;
		this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		this.closed = false;
		const cookie = this.opts.getCookie();
		if (!cookie) {
			this.log.warn('sem cookie Auth; nova tentativa em 5s');
			this.scheduleReconnect();
			return;
		}

		let ws: WebSocket;
		try {
			ws = new WebSocket(this.opts.url, { headers: { Cookie: cookie } });
		} catch (err) {
			this.log.error({ err }, 'falha ao abrir o WebSocket');
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;

		ws.on('open', () => {
			this.attempts = 0;
			this.log.info('conectado');
			this.startHeartbeat();
			this.opts.onOpen?.();
		});

		ws.on('message', (raw) => {
			let event: PapoWsEvent;
			try {
				event = JSON.parse(String(raw)) as PapoWsEvent;
			} catch {
				this.log.warn({ raw: String(raw).slice(0, 200) }, 'evento WS inválido');
				return;
			}
			if (event.type === 'heartbeat_ack') {
				this.clearAckTimer();
				return;
			}
			this.opts.onEvent(event);
		});

		ws.on('error', (err) => {
			this.log.error({ err }, 'erro no WebSocket');
		});

		ws.on('close', (code, reason) => {
			this.stopHeartbeat();
			const why = `code=${code} ${String(reason ?? '')}`.trim();
			this.log.warn({ why }, 'WebSocket fechado');
			this.opts.onClose?.(why);
			if (!this.closed) this.scheduleReconnect();
		});
	}

	close(): void {
		this.closed = true;
		this.stopHeartbeat();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.ws?.close();
		this.ws = undefined;
	}

	send(payload: unknown): void {
		if (!this.connected) return;
		this.ws!.send(JSON.stringify(payload));
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.send({ type: 'heartbeat' });
			this.armAckTimer();
		}, this.heartbeatMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
		this.clearAckTimer();
	}

	private armAckTimer(): void {
		this.clearAckTimer();
		this.ackTimer = setTimeout(() => {
			this.log.warn('sem heartbeat_ack; forçando reconexão');
			this.ws?.terminate();
		}, this.ackTimeoutMs);
	}

	private clearAckTimer(): void {
		if (this.ackTimer) clearTimeout(this.ackTimer);
		this.ackTimer = undefined;
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return;
		this.attempts += 1;
		const delay = Math.min(this.maxBackoffMs, 1000 * 2 ** Math.min(this.attempts, 6));
		this.log.info({ delay, attempts: this.attempts }, 'reconectando');
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
	}
}
