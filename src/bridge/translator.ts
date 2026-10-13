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
	/** username/nickname → uuid do usuário Papo (resolução por nome; só quando `mentions` ligado). */
	papoUserIdForName?: (name: string) => string | undefined;
	/** username/nickname → snowflake do usuário Discord (resolução por nome; só quando `mentions` ligado). */
	discordUserIdForName?: (name: string) => string | undefined;
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
/**
 * `@nome` em texto puro (digitado sem autocomplete). `(?<!\w)` deixa de fora e-mail
 * (`foo@bar`) e sufixos de token; o lookahead exige o fim do token. `mention` é a
 * sintaxe canônica do Papo — nunca é candidato a nome.
 */
const PLAIN_MENTION_RE = /(?<![\w</.])@([A-Za-z0-9_.]{2,32})(?![A-Za-z0-9_.])/g;
const RESERVED_MENTION_WORDS = new Set(['mention', 'everyone', 'here']);

/** Rótulo de menção que não pôde ser resolvida (mesma convenção de `authorLabel`). */
const UNKNOWN_LABEL = 'usuário';

/** ids de menção de usuário no conteúdo do Discord (para resolver rótulo antes de traduzir). */
export const discordUserMentionIds = (content: string): string[] =>
	[...content.matchAll(DISCORD_USER_RE)].flatMap((m) => (m[1] ? [m[1]] : []));

/** ids de menção no formato canônico do Papo. */
export const papoMentionIds = (content: string): string[] =>
	[...content.matchAll(PAPO_MENTION_RE)].flatMap((m) => (m[1] ? [m[1]] : []));

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
	// `@nome` em texto puro (digitado sem autocomplete): com `mentions` ligado, tenta o
	// usuário correspondente no Papo. Roda antes das menções estruturadas para não
	// re-processar rótulos que estas produzem.
	out = out.replace(PLAIN_MENTION_RE, (raw, name: string) => {
		if (!r.propagateMentions) return raw;
		const wanted = name.replace(/\.+$/, ''); // pontuação final não é parte do nome
		if (!wanted || RESERVED_MENTION_WORDS.has(wanted.toLowerCase())) return raw;
		const papoId = r.papoUserIdForName?.(wanted);
		return papoId ? `@mention(<@${papoId}>)${name.slice(wanted.length)}` : raw;
	});
	out = out.replace(DISCORD_ROLE_RE, (raw, id: string) => r.discordRoleLabel?.(id) ?? raw);
	out = out.replace(DISCORD_CHANNEL_RE, (raw, id: string) => (r.discordChannelLabel?.(id) ? `#${r.discordChannelLabel!(id)}` : raw));
	out = out.replace(DISCORD_USER_RE, (_raw, id: string) => {
		if (r.propagateMentions) {
			const papoId = r.papoUserIdForDiscord?.(id);
			if (papoId) return `@mention(<@${papoId}>)`;
			// sem link de conta: o nome do usuário Discord pode casar com um usuário do
			// Papo (item 28) — username/nickname exato e único vira menção real
			const label = r.discordUserLabel?.(id);
			const byName = label ? r.papoUserIdForName?.(label) : undefined;
			if (byName) return `@mention(<@${byName}>)`;
		}
		// snowflake não diz nada a quem lê o Papo: sem link-user o rótulo vem do cache de
		// usuários Discord, e o último recurso é `@usuário` (nunca o id cru).
		const label = r.discordUserLabel?.(id);
		return label ? `@${label}` : `@${UNKNOWN_LABEL}`;
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

	// `@nome` em texto puro: com `mentions` ligado, tenta o usuário correspondente no
	// Discord. Roda antes da menção canônica para não re-processar rótulos dela.
	out = out.replace(PLAIN_MENTION_RE, (raw, name: string) => {
		if (!r.propagateMentions) return raw;
		const wanted = name.replace(/\.+$/, ''); // pontuação final não é parte do nome
		if (!wanted || RESERVED_MENTION_WORDS.has(wanted.toLowerCase())) return raw;
		const discordId = r.discordUserIdForName?.(wanted);
		return discordId ? `<@${discordId}>${name.slice(wanted.length)}` : raw;
	});

	out = out.replace(PAPO_MENTION_RE, (_raw, id: string) => {
		if (r.propagateMentions) {
			const discordId = r.discordUserIdForPapo?.(id);
			if (discordId) return `<@${discordId}>`;
			// sem link de conta: o nome do usuário Papo pode casar com um membro do guild
			const label = r.papoUserLabel?.(id);
			const byName = label ? r.discordUserIdForName?.(label) : undefined;
			if (byName) return `<@${byName}>`;
		}
		// uuid do Papo não significa nada no Discord: rótulo do cache, senão `@usuário`
		const label = r.papoUserLabel?.(id);
		return label ? `@${label}` : `@${UNKNOWN_LABEL}`;
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
