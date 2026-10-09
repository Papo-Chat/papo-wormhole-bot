/** Tipos do backend Papo (espelho de openapi.yml). */

export interface PapoServer {
	id: string;
	name: string;
	owner_id: string;
	public?: boolean;
	owner_username?: string;
	created_at?: string;
	channel_count?: number;
	member_count?: number;
	role_count?: number;
}

export interface PapoChannel {
	id: string;
	name: string;
	type: 'text' | 'category' | 'voice';
	position: number;
	topic?: string | null;
	created_at?: string;
}

export interface PapoAttachment {
	id: string;
	mime_type: string;
	original_file_name: string;
	size_bytes: number;
	thumbnail_id?: string | null;
	created_at?: string;
	moderation_status?: 'pending' | 'processing' | 'clean' | 'sensitive' | 'blocked' | 'failed';
}

export interface PapoEmbedMedia {
	url?: string | null;
	mime_type?: string | null;
	width?: number | null;
	height?: number | null;
	size_bytes?: number | null;
}

export interface PapoEmbedAuthor {
	name?: string | null;
	url?: string | null;
	media?: PapoEmbedMedia | null;
}

export interface PapoEmbedFooter {
	text?: string | null;
	icon?: PapoEmbedMedia | null;
}

export interface PapoEmbedField {
	position?: number;
	name: string;
	value: string;
	inline?: boolean;
}

export interface PapoEmbed {
	id: string;
	source_type: 'link' | 'custom';
	fetch_method?: 'opengraph' | 'oembed' | 'manual';
	provider?: string | null;
	site_name?: string | null;
	url?: string | null;
	title?: string | null;
	description?: string | null;
	color?: string | null;
	author?: PapoEmbedAuthor | null;
	thumbnail?: PapoEmbedMedia | null;
	image?: PapoEmbedMedia | null;
	video?: PapoEmbedMedia | null;
	footer?: PapoEmbedFooter | null;
	fields?: PapoEmbedField[];
	embed_url?: string | null;
	created_at?: string;
	fetched_at?: string | null;
}

/** Embed customizado aceito por POST /messages e PUT /messages/{id}. */
export interface PapoEmbedInput {
	title?: string;
	description?: string;
	url?: string;
	color?: string;
	site_name?: string;
	author?: { name?: string; url?: string; icon_url?: string };
	footer?: { text?: string };
	thumbnail?: { url: string; mime_type?: string };
	image?: { url: string; mime_type?: string };
	video?: { url: string; mime_type?: string };
	fields?: { name: string; value: string; inline?: boolean }[];
}

export interface PapoReactionSummary {
	emoji_id: string | null;
	unicode: string | null;
	count: number;
}

export interface PapoMessage {
	id: string;
	channel_id: string;
	author_id: string;
	content: string | null;
	created_at: string;
	edited_at?: string | null;
	reply_to?: string | null;
	attachments?: PapoAttachment[];
	embeds?: PapoEmbed[];
	reactions?: PapoReactionSummary[] | null;
	user_reactions?: { id: string; emoji_id: string | null; unicode: string | null }[];
}

export interface PapoMessageList {
	channel_id: string;
	messages: PapoMessage[];
	has_more: boolean;
}

export interface PapoEmoji {
	id: string;
	name: string;
	format: 'GIF' | 'JPEG' | 'JPG' | 'PNG' | 'WEBP';
	image_blob?: string;
	created_by?: string;
	created_at?: string;
}

export interface PapoUserSummary {
	id: string;
	username: string;
	nickname?: string | null;
	banned?: boolean;
	status?: 'away' | 'busy' | null;
	status_message?: string | null;
	created_at?: string;
}

export interface PapoUserProfile {
	id: string;
	username: string;
	nickname?: string | null;
	avatar_blob?: string | null;
	avatar_format?: string | null;
	banner_media?: string | null;
	description?: string | null;
	status?: 'away' | 'busy' | null;
	created_at?: string;
}

export interface PapoWhoami {
	id: string;
	username: string;
	nickname?: string | null;
	[extra: string]: unknown;
}

/** Evento WS outbound `message` (sem embeds/reactions). */
export interface PapoWsMessageEvent {
	type: 'message';
	id: string;
	channel_id: string;
	author_id: string;
	content: string | null;
	reply_to?: string | null;
	attachments?: PapoAttachment[];
	created_at: string;
}

export interface PapoWsEditEvent {
	type: 'message_edit';
	id: string;
	channel_id: string;
	content: string | null;
	edited_at: string;
}

export interface PapoWsDeleteEvent {
	type: 'message_delete';
	id: string;
	channel_id: string;
}

export interface PapoWsEmbedsEvent {
	type: 'message_embeds_update';
	channel_id: string;
	message_id: string;
	/** `null` quando a mensagem ficou sem embeds (confirmado em execução). */
	embeds: PapoEmbed[] | null;
}

export interface PapoWsReactEvent {
	type: 'react_update';
	message_id: string;
	emoji_id: string | null;
	unicode: string | null;
	count: number;
}

export interface PapoWsModerationEvent {
	type: 'attachment_moderation_update';
	channel_id: string;
	message_id: string;
	attachment_id: string;
	status: string;
}

export interface PapoWsPinEvent {
	type: 'message_pin';
	message_id: string;
	is_pinned: boolean;
}

export interface PapoWsPresenceEvent {
	type: 'presence_update';
	user_id: string;
	status: 'online' | 'offline' | 'away' | 'busy';
	status_message?: string | null;
	typing?: boolean;
	nickname?: string | null;
}

export interface PapoWsPresenceSyncEvent {
	type: 'presence_sync';
	members: { user_id: string; status: string; status_message?: string | null; user_voice?: string[] }[];
}

export interface PapoWsAvatarEvent {
	type: 'avatar_update';
	user_id: string;
}

export interface PapoWsErrorEvent {
	type: 'error';
	message: string;
	code?: string;
}

export type PapoWsEvent =
	| PapoWsMessageEvent
	| PapoWsEditEvent
	| PapoWsDeleteEvent
	| PapoWsEmbedsEvent
	| PapoWsReactEvent
	| PapoWsModerationEvent
	| PapoWsPinEvent
	| PapoWsPresenceEvent
	| PapoWsPresenceSyncEvent
	| PapoWsAvatarEvent
	| PapoWsErrorEvent
	| { type: string; [k: string]: unknown };

/** RFC 7807. */
export interface PapoProblem {
	type?: string;
	title?: string;
	status?: number;
	detail?: string;
	instance?: string;
}

export class PapoApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly problem?: PapoProblem,
		readonly requestId?: string
	) {
		super(message);
		this.name = 'PapoApiError';
	}

	/** Erro transitório: vale retry. 4xx de payload/permissão não. */
	get transient(): boolean {
		return this.status >= 500 || this.status === 429 || this.status === 0;
	}
}
