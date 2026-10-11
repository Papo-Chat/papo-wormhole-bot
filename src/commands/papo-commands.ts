import { ApplicationCommandOptionType, ChannelType, type Client, type Guild } from 'discord.js';
import type { Logger } from 'pino';
import { scoped } from '../logger.js';
import {
  ArgError,
  commands,
  execute,
  type ChannelRef,
  type CommandArgs,
  type CommandContext,
  type CommandDeps,
  type CommandOutput,
  type UserRef
} from './commands.js';

/**
 * Comandos digitados no Papo: a primeira linha de uma mensagem começando com `/<comando>`.
 *
 *   /online
 *   /link-channel papo_channel:geral discord_channel:#geral
 *   /link-channel geral #geral
 *   /link-server "Cyber Asilo"
 *   /bridge-config discord_channel:#geral mode:to_papo reactions:false
 *
 * Só comandos conhecidos são consumidos; `/shrug` e afins seguem como mensagem comum.
 */

export interface PapoCommandInput {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  /** Instante de criação no Papo; mensagens antigas (backfill após restart) não reexecutam. */
  createdAt?: string | number | Date | null;
}

export interface PapoCommandOptions {
  client: Client;
  /** Envia o texto de resposta no canal do comando. */
  reply: (text: string) => Promise<void>;
  /** Ids (uuid) de usuários do Papo autorizados a rodar comandos de configuração. */
  adminIds?: Iterable<string>;
  maxAgeMs?: number;
  logger?: Logger;
}

const DEFAULT_MAX_AGE_MS = 120_000;
const MAX_REPLY_CHARS = 8000; // limite do Papo: 8192
const SNOWFLAKE = /^\d{17,20}$/;

const seen = new Map<string, number>();

function remember(id: string, now: number): boolean {
  for (const [key, ts] of seen) if (now - ts > 10 * 60_000) seen.delete(key);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

function adminSet(explicit?: Iterable<string>): Set<string> {
  const raw = explicit ? [...explicit] : (process.env.WORMHOLE_PAPO_ADMIN_IDS ?? '').split(',');
  return new Set(raw.map((v) => v.trim().toLowerCase()).filter(Boolean));
}

/* --------------------------------------------- parsing ------------------------------------------ */

interface OptionSpec {
  name: string;
  type: ApplicationCommandOptionType;
}

function specsOf(commandName: string): OptionSpec[] | null {
  const cmd = commands.find((c) => c.name === commandName);
  if (!cmd) return null;
  return (cmd.options ?? []).map((o) => ({ name: o.name, type: o.type }));
}

function tokenize(line: string): string[] {
  return [...line.matchAll(/(?:[A-Za-z_]+:)?"[^"]*"|\S+/g)].map((m) => m[0]);
}

const unquote = (v: string): string => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v);

export function parsePapoCommand(content: string): { name: string; values: Map<string, string>; specs: OptionSpec[] } | null {
  const firstLine = content.trimStart().split('\n', 1)[0] ?? '';
  const head = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i.exec(firstLine.trim());
  if (!head) return null;
  const name = head[1]!.toLowerCase();
  const specs = specsOf(name);
  if (!specs) return null;

  const known = new Set(specs.map((s) => s.name));
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokenize(head[2] ?? '')) {
    const kv = /^([A-Za-z_]+):([\s\S]*)$/.exec(token);
    if (kv && known.has(kv[1]!.toLowerCase())) values.set(kv[1]!.toLowerCase(), unquote(kv[2]!));
    else positional.push(unquote(token));
  }

  const free = specs.filter((s) => !values.has(s.name));
  free.forEach((spec, idx) => {
    if (!positional.length) return;
    const isLast = idx === free.length - 1;
    // última opção de texto livre absorve o resto (ex.: `/link-server Cyber Asilo`)
    values.set(spec.name, isLast && spec.type === ApplicationCommandOptionType.String ? positional.splice(0).join(' ') : positional.shift()!);
  });

  return { name, values, specs };
}

function parseBoolean(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'sim', 's', 'on', 'yes'].includes(v)) return true;
  if (['false', '0', 'nao', 'não', 'n', 'off', 'no'].includes(v)) return false;
  throw new ArgError(`valor inválido para ${name}: use true ou false`);
}

/* ---------------------------------- resolução de alvos no Discord ------------------------------- */

function pickGuild(client: Client): Guild | null {
  const configured = process.env.DISCORD_GUILD_ID;
  if (configured) return client.guilds.cache.get(configured) ?? null;
  return client.guilds.cache.size === 1 ? (client.guilds.cache.first() ?? null) : null;
}

async function resolveChannel(client: Client, guild: Guild | null, input: string): Promise<ChannelRef> {
  const raw = input.trim();
  const id = /^<#(\d+)>$/.exec(raw)?.[1] ?? (SNOWFLAKE.test(raw) ? raw : null);

  if (id) {
    const ch = client.channels.cache.get(id) ?? (await client.channels.fetch(id).catch(() => null));
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new ArgError(`canal do Discord não encontrado ou não é de texto: ${raw}`);
    }
    return { id: ch.id, name: ch.name };
  }

  if (!guild) throw new ArgError('servidor Discord não identificado; informe o canal por menção ou id (ou defina DISCORD_GUILD_ID).');

  const wanted = raw.replace(/^#/, '').toLowerCase();
  const texts = [...guild.channels.cache.values()].flatMap((c) => (c.type === ChannelType.GuildText ? [c] : []));
  const exact = texts.filter((c) => c.name.toLowerCase() === wanted);
  const matches = exact.length ? exact : texts.filter((c) => c.name.toLowerCase().includes(wanted));
  if (matches.length === 1) return { id: matches[0]!.id, name: matches[0]!.name };
  if (!matches.length) throw new ArgError(`nenhum canal de texto do Discord casa com "${raw}".`);
  throw new ArgError(
    `"${raw}" casa com mais de um canal: ${matches.slice(0, 5).map((c) => `#${c.name}`).join(', ')}. Use a menção ou o id.`
  );
}

async function resolveUser(client: Client, guild: Guild | null, input: string): Promise<UserRef> {
  const raw = input.trim();
  const id = /^<@!?(\d+)>$/.exec(raw)?.[1] ?? (SNOWFLAKE.test(raw) ? raw : null);
  const toRef = (u: { id: string; username: string; displayName: string }): UserRef => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName
  });

  if (id) {
    const user = await client.users.fetch(id).catch(() => null);
    if (!user) throw new ArgError(`usuário do Discord não encontrado: ${raw}`);
    return toRef(user);
  }

  if (!guild) throw new ArgError('servidor Discord não identificado; informe o usuário por menção ou id (ou defina DISCORD_GUILD_ID).');

  const wanted = raw.replace(/^@/, '').toLowerCase();
  const found = [...(await guild.members.search({ query: wanted, limit: 10 })).values()];
  const exact = found.filter(
    (m) => m.user.username.toLowerCase() === wanted || m.displayName.toLowerCase() === wanted
  );
  const matches = exact.length ? exact : found;
  if (matches.length === 1) return toRef(matches[0]!.user);
  if (!matches.length) throw new ArgError(`nenhum membro do Discord casa com "${raw}".`);
  throw new ArgError(
    `"${raw}" casa com mais de um membro: ${matches.slice(0, 5).map((m) => `@${m.user.username}`).join(', ')}. Use a menção ou o id.`
  );
}

/* ------------------------------------------- saída ---------------------------------------------- */

function renderText(out: CommandOutput): string {
  const parts: string[] = [];
  if (out.content) parts.push(out.content);
  for (const s of out.sections ?? []) parts.push(`**${s.title}**\n${s.body}`);
  const text = parts.join('\n\n') || 'ok';
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text;
}

/* ------------------------------------------ adaptador ------------------------------------------- */

/**
 * Executa o comando se `msg` for um comando conhecido. Devolve `true` quando a mensagem foi
 * consumida: o bridge não deve encaminhá-la ao Discord.
 */
export async function handlePapoCommand(msg: PapoCommandInput, deps: CommandDeps, opts: PapoCommandOptions): Promise<boolean> {
  const parsed = parsePapoCommand(msg.content);
  if (!parsed) return false;

  const log = opts.logger ?? deps.logger ?? scoped('papo-commands');
  const now = Date.now();

  if (!remember(msg.id, now)) return true; // entrega duplicada do mesmo evento

  const created = msg.createdAt ? new Date(msg.createdAt).getTime() : NaN;
  if (Number.isFinite(created) && now - created > (opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    log.info({ message: msg.id, command: parsed.name }, 'comando antigo do Papo ignorado (backfill)');
    return true;
  }

  const { client } = opts;
  const guild = pickGuild(client);
  const { values } = parsed;

  const args: CommandArgs = {
    string: (n) => values.get(n) ?? null,
    boolean: (n) => {
      const v = values.get(n);
      return v === undefined ? null : parseBoolean(n, v);
    },
    channel: async (n) => {
      const v = values.get(n);
      return v === undefined ? null : resolveChannel(client, guild, v);
    },
    user: async (n) => {
      const v = values.get(n);
      return v === undefined ? null : resolveUser(client, guild, v);
    }
  };

  const ctx: CommandContext = {
    platform: 'papo',
    name: parsed.name,
    client,
    guild,
    args,
    canManage: adminSet(opts.adminIds).has(msg.authorId.toLowerCase()),
    authorId: msg.authorId,
    defer: async () => undefined,
    fmtChannel: (c) => `#${c.name ?? (client.channels.cache.get(c.id) as { name?: string } | undefined)?.name ?? c.id}`,
    fmtUser: (u) => `@${u.displayName}`
  };

  let text: string;
  try {
    text = renderText(await execute(ctx, deps));
  } catch (err) {
    if (err instanceof ArgError) {
      text = `❌ ${err.message}`;
    } else {
      log.error({ err, command: parsed.name }, 'comando do Papo falhou');
      text = '⚠️ erro interno; veja os logs.';
    }
  }

  await opts.reply(text).catch((err: unknown) => log.error({ err, command: parsed.name }, 'falha ao responder no Papo'));
  return true;
}
