import type { DiscordEmbedPayload } from './embeds.js';
import type { PapoEmbedInput } from '../papo/types.js';

/** Descritor leve de attachment: o download acontece na execução do job (retry-friendly). */
export const EXTRA_CHUNK_BASE = 1000;

export interface SourceRef {
	side: 'papo' | 'discord';
	id: string;
	name: string;
	mime?: string | null;
	sizeBytes: number;
	/** URL direta (CDN do Discord) ou link público do Papo, para fallback. */
	url?: string;
	/**
	 * Variante `.gif` deduzida do mesmo arquivo, tentada antes da URL principal: é o que devolve
	 * a animação quando o player do Discord só expõe o mp4 em loop. Só vale se vier um GIF.
	 */
	gifVariant?: string;
	moderationStatus?: string;
}

/** Arquivo já materializado no cache de mídia. */
export interface FileRef {
	sha256: string;
	name: string;
	mime?: string;
	part?: boolean;
}

export interface ToDiscordMessageJob {
	kind: 'message';
	linkId: number;
	papoChannelId: string;
	discordChannelId: string;
	papoMessageId: string;
	chunkIndex: number;
	chunkTotal: number;
	description: string;
	/** Autor Papo (usado para a URL pública do avatar). Jobs antigos do outbox podem não ter. */
	authorId?: string;
	authorName: string;
	authorIconSha?: string;
	authorUrl?: string;
	colorHex?: string;
	timestamp: string;
	notes: string[];
	sources: SourceRef[];
	linkEmbeds?: DiscordEmbedPayload[];
	/** Mensagem Papo respondida (origem); a cópia Discord é resolvida na execução do job. */
	replyRefPapoId?: string;
}

export interface ToPapoMessageJob {
	kind: 'message';
	linkId: number;
	papoChannelId: string;
	discordChannelId: string;
	discordMessageId: string;
	chunkIndex: number;
	chunkTotal: number;
	authorName: string;
	content: string;
	footerBase: string;
	bridgeEmbed?: PapoEmbedInput;
	linkEmbeds?: PapoEmbedInput[];
	notes: string[];
	sources: SourceRef[];
	/**
	 * Instante da mensagem no Discord. A reconciliação de um envio incerto só aceita uma
	 * cópia posterior à origem: uma cópia antiga do mesmo rodapé não pode ser confundida
	 * com a que este job tentou criar.
	 */
	timestamp: string;
	/** Mensagem Discord respondida (origem); a cópia Papo é resolvida na execução do job. */
	replyRefDiscordId?: string;
}

export interface EditJob {
	kind: 'edit';
	side: 'papo' | 'discord';
	linkId: number;
	sourceMessageId: string;
	targetChannelId: string;
	chunkIndex: number;
	chunkTotal: number;
	text: string;
	/**
	 * Revisão monotônica da edição na origem (timestamp ISO). Na execução, uma edição mais
	 * antiga que a última aplicada é descartada: a fila serializa a execução, não a ordem
	 * cronológica dos eventos de origem.
	 */
	revision?: string;
}

export interface DeleteJob {
	kind: 'delete';
	side: 'papo' | 'discord';
	linkId: number;
	sourceMessageId: string;
}

/**
 * Reação pendente. Os campos de emoji são os valores **da origem** (`emojiId`/`emojiName`
 * do Papo, ou `emojiId`/`emojiName`/`unicode` do Discord): a conversão para o formato do
 * destino acontece na execução do job, quando o destino está acessível.
 */
export interface ReactionJob {
	kind: 'reaction';
	side: 'papo' | 'discord';
	linkId: number;
	sourceMessageId: string;
	targetChannelId: string;
	/** id do emoji custom na origem. */
	emojiId?: string;
	/** nome do emoji custom na origem. */
	emojiName?: string;
	animated?: boolean;
	/** emoji unicode (na origem). */
	unicode?: string;
	/** contagem absoluta observada na origem. */
	count: number;
	add: boolean;
}

export interface PinJob {
	kind: 'pin';
	side: 'papo' | 'discord';
	linkId: number;
	sourceMessageId: string;
	targetChannelId: string;
	pinned: boolean;
}

export type BridgeJob =
	| ToDiscordMessageJob
	| ToPapoMessageJob
	| EditJob
	| DeleteJob
	| ReactionJob
	| PinJob;

export const isToDiscordMessage = (j: BridgeJob): j is ToDiscordMessageJob =>
	j.kind === 'message' && j.linkId !== undefined && 'discordChannelId' in j && 'description' in j;

export const isToPapoMessage = (j: BridgeJob): j is ToPapoMessageJob =>
	j.kind === 'message' && 'content' in j;
