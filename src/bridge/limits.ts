/** Limites verificados nos dois lados.
 * Papo: confirmados no backend (`internal/services/messages.go`, `attachments.go`,
 * `handlers/emojis.go`) e no frontend (`src/lib/utils/upload.ts`, `src/types/api.ts`).
 * Discord: File Attachments FAQ (ago/2026) + limites de embed da API.
 */

export const PAPO_LIMITS = {
	contentMax: 8192,
	embedsPerMessage: 10,
	embedTotalChars: 6000,
	embedTitleMax: 256,
	embedDescriptionMax: 4192,
	embedFieldsMax: 25,
	embedFieldNameMax: 256,
	embedFieldValueMax: 1024,
	embedFooterMax: 2048,
	embedAuthorMax: 256,
	embedUrlMax: 2048,
	attachmentsPerMessage: 10,
	attachmentMaxBytes: 100 * 1024 * 1024,
	attachmentNameMax: 128,
	emojiMaxBytes: 256 * 1024,
	emojiNameMax: 32,
	emojiMaxCount: 500,
	reactionTypesMax: 20,
	pinsPerChannelMax: 100
} as const;

export const DISCORD_LIMITS = {
	contentMax: 2000,
	embedsPerMessage: 10,
	embedTotalChars: 6000,
	embedTitleMax: 256,
	embedDescriptionMax: 4096,
	embedFieldsMax: 25,
	embedFieldNameMax: 256,
	embedFieldValueMax: 1024,
	embedFooterMax: 2048,
	embedAuthorMax: 256,
	attachmentsPerMessage: 10
} as const;

/** Orçamento de texto por chunk de embed (deixa folga para footer/fields). */
export const EMBED_CHUNK_CHARS = 3600;

/** Tamanho-alvo das partes ao particionar um arquivo que não cabe no destino. */
export const PART_TARGET_BYTES = 19 * 1024 * 1024;

export const clampText = (value: string, max: number): string =>
	Array.from(value).length <= max ? value : `${Array.from(value).slice(0, max - 1).join('')}…`;

export const isImageMime = (mime?: string | null): boolean => Boolean(mime?.startsWith('image/'));
export const isVideoMime = (mime?: string | null): boolean => Boolean(mime?.startsWith('video/'));

/** MIMEs que o Papo aceita como imagem de embed/emoji. */
export const PAPO_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const PAPO_VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/ogg'];
