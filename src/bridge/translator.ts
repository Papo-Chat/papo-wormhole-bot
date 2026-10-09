/**
 * Tradução de conteúdo entre os dialetos de markdown de Discord e Papo.
 *
 * Papo (frontend aero): CommonMark + GFM via `marked` (strikethrough e tabelas),
 * `breaks: true`, sem HTML cru, sem `__sublinhado__`, sem spoiler `||`, sem menção de
 * canal/role. Menção de usuário usa o formato canônico `@mention(<@uuid>)` e emoji custom
 * usa shortcode `:name:` (regex do frontend: `/:([A-Za-z0-9_]+):/`).
 */

import { clampText } from './limits.js';

export interface EmojiToken {
	/** Token pronto para o conteúdo do Discord (`<:name:id>` ou `![name](url)`). */
	token: string;
}

export interface TranslateResolvers {
	/** discord user id → rótulo exibível (displayName/username). */
	discordUserLabel?: (discordUserId: string) => string | undefined;
	/** discord user id → uuid do usuário Papo linkado. */
	papoUserIdForDiscord?: (discordUserId: string) => string | undefined;
	/** papo user id → snowflake do usuário Discord linkado. */
	discordUserIdForPapo?: (papoUserId: string) => string | undefined;
	/** papo user id → rótulo (nickname > username). */
	papoUserLabel?: (papoUserId: string) => string | undefined;
	discordChannelLabel?: (discordChannelId: string) => string | undefined;
	discordRoleLabel?: (discordRoleId: string) => string | undefined;
	/** nome do emoji → token Discord. */
	discordEmoji?: (name: string) => EmojiToken | undefined;
	/** nome do emoji → nome canônico no Papo (quando existe). */
	papoEmojiName?: (name: string) => string | undefined;
	propagateMentions?: boolean;
	timezone?: string;
}

const DISCORD_EMOJI_RE = /<a?:([A-Za-z0-9_]+):(\d+)>/g;
const DISCORD_USER_RE = /<@!?(\d+)>/g;
const DISCORD_CHANNEL_RE = /<#(\d+)>/g;
const DISCORD_ROLE_RE = /<@&(\d+)>/g;
const DISCORD_TIMESTAMP_RE = /<t:(-?\d{1,12})(?::[A-Za-z])?>/g;
const PAPO_MENTION_RE = /@mention\(<@([0-9a-fA-F-]{16,})>\)/g;
const PAPO_SHORTCODE_RE = /:([A-Za-z0-9_]{1,32}):/g;

export function formatDate(isoOrEpoch: string | number, timezone = 'America/Sao_Paulo'): string {
	const date = typeof isoOrEpoch === 'number' ? new Date(isoOrEpoch * 1000) : new Date(isoOrEpoch);
	if (Number.isNaN(date.getTime())) return String(isoOrEpoch);
	try {
		return new Intl.DateTimeFormat('pt-BR', {
			timeZone: timezone,
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(date);
	} catch {
		return date.toISOString();
	}
}

/** Discord → Papo. */
export function discordToPapoContent(content: string, r: TranslateResolvers = {}): string {
	if (!content) return '';
	let out = content;

	// timestamps relativos do Discord não existem no Papo → data absoluta
	out = out.replace(DISCORD_TIMESTAMP_RE, (_m, epoch: string) => formatDate(Number(epoch), r.timezone));

	// emoji custom do Discord → shortcode do Papo
	out = out.replace(DISCORD_EMOJI_RE, (raw, name: string) => {
		const known = r.papoEmojiName?.(name);
		return known ? `:${known}:` : `:${name}:`;
	});

	// menções
	out = out.replace(DISCORD_ROLE_RE, (raw, id: string) => r.discordRoleLabel?.(id) ?? raw);
	out = out.replace(DISCORD_CHANNEL_RE, (raw, id: string) => (r.discordChannelLabel?.(id) ? `#${r.discordChannelLabel!(id)}` : raw));
	out = out.replace(DISCORD_USER_RE, (raw, id: string) => {
		if (r.propagateMentions) {
			const papoId = r.papoUserIdForDiscord?.(id);
			if (papoId) return `@mention(<@${papoId}>)`;
		}
		const label = r.discordUserLabel?.(id);
		return label ? `@${label}` : raw;
	});

	// sublinhado do Discord não existe no Papo
	out = out.replace(/__([^_\n]{1,400})__/g, '**$1**');

	// spoiler `||x||` não é renderizado pelo Papo
	out = out.replace(/\|\|([\s\S]{1,2000}?)\|\|/g, (_m, inner: string) => `**spoiler:** ${inner}`);

	// @everyone/@here são neutralizados: a conta do bridge pode ter `everyone_message` no
	// Papo, e o texto atravessaria como ping em massa. Zero-width preserva a aparência.
	out = out.replace(/@(everyone|here)\b/g, '@\u200b$1');

	return out;
}

/** Papo → Discord. */
export function papoToDiscordContent(content: string, r: TranslateResolvers = {}): string {
	if (!content) return '';
	let out = content;

	out = out.replace(PAPO_MENTION_RE, (raw, id: string) => {
		if (r.propagateMentions) {
			const discordId = r.discordUserIdForPapo?.(id);
			if (discordId) return `<@${discordId}>`;
		}
		const label = r.papoUserLabel?.(id);
		return label ? `@${label}` : raw;
	});

	out = out.replace(PAPO_SHORTCODE_RE, (raw, name: string) => {
		const token = r.discordEmoji?.(name);
		return token ? token.token : raw;
	});

	return out;
}

/**
 * Remove sintaxe do Discord que não tem equivalente no Papo (componentes, stickers,
 * menções de slash command), preservando o texto legível.
 */
export function stripUnsupportedDiscord(content: string): string {
	return content
		.replace(/\[[^\]\n]{0,80}\]\(https?:\/\/discord\.com\/channels\/[^\s)]+\)/g, (m) => m)
		.replace(/<\/[a-z_]+:\d+>/g, '')
		.replace(/\n{3,}/g, '\n\n');
}

/** Rótulo de autor no formato do bridge (nickname > username). */
export function authorLabel(nickname?: string | null, username?: string | null, fallback = 'usuário'): string {
	const label = nickname?.trim() || username?.trim();
	return label ? clampText(label, 256) : fallback;
}
