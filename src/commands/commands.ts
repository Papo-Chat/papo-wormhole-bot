import {
  ChannelType,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
  type BaseMessageOptions,
  type ChatInputCommandInteraction,
  type Client,
  type Guild
} from 'discord.js';
import type { Logger } from 'pino';
import type { PapoUserSummary } from '../papo/types.js';
import { scoped } from '../logger.js';
import type { Store } from '../db/store.js';
import type { PapoApi } from '../papo/api.js';
import type { Bridge } from '../bridge/bridge.js';
import type { Outbox } from '../db/outbox.js';
import type { OutboxState } from '../db/outbox.js';
import { isUuid, matchChannel, matchServer, matchUser, type Resolved } from './resolve.js';

export const commands = [
  new SlashCommandBuilder().setName('online').setDescription('Quem está online na plataforma inversa'),
  new SlashCommandBuilder()
    .setName('link-channel')
    .setDescription('Linka um canal do Papo a um canal do Discord')
    .addStringOption((o) => o.setName('papo_channel').setDescription('nome do canal do Papo (ex.: geral) ou id (uuid)').setRequired(true))
    .addChannelOption((o) =>
      o.setName('discord_channel').setDescription('Canal do Discord').addChannelTypes(ChannelType.GuildText,ChannelType.PublicThread).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder()
    .setName('unlink-channel')
    .setDescription('Remove o link de um canal')
    .addChannelOption((o) =>
      o.setName('discord_channel').setDescription('Canal do Discord').addChannelTypes(ChannelType.GuildText,ChannelType.PublicThread).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder()
    .setName('link-server')
    .setDescription('Associa o servidor Papo ao servidor Discord')
    .addStringOption((o) => o.setName('papo_server').setDescription('nome do servidor Papo (ex.: Cyber Asilo) ou id (uuid)').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder()
    .setName('link-user')
    .setDescription('Mapeia um usuário do Papo a um usuário do Discord')
    .addStringOption((o) => o.setName('papo_user').setDescription('usuário do Papo (ex.: jonas ou apelido) ou id (uuid)').setRequired(true))
    .addUserOption((o) => o.setName('discord_user').setDescription('Usuário do Discord').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder()
    .setName('unlink-user')
    .setDescription('Remove o mapeamento de um usuário Discord')
    .addUserOption((o) => o.setName('discord_user').setDescription('Usuário do Discord').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder().setName('bridges').setDescription('Lista os canal-links e seu estado'),
  new SlashCommandBuilder()
    .setName('bridge-config')
    .setDescription('Ajusta as flags de um canal-link')
    .addChannelOption((o) =>
      o.setName('discord_channel').setDescription('Canal do Discord').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .addStringOption((o) => o.setName('mode').setDescription('both | to_discord | to_papo').addChoices(
      { name: 'both', value: 'both' },
      { name: 'to_discord', value: 'to_discord' },
      { name: 'to_papo', value: 'to_papo' }
    ))
    .addBooleanOption((o) => o.setName('attachments').setDescription('bridge de anexos'))
    .addBooleanOption((o) => o.setName('embeds').setDescription('bridge de embeds/previews'))
    .addBooleanOption((o) => o.setName('reactions').setDescription('bridge de reações'))
    .addBooleanOption((o) => o.setName('edits').setDescription('bridge de edições'))
    .addBooleanOption((o) => o.setName('deletes').setDescription('bridge de deleções'))
    .addBooleanOption((o) => o.setName('pins').setDescription('bridge de pins'))
    .addBooleanOption((o) => o.setName('mentions').setDescription('propagar menções reais'))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder().setName('status').setDescription('Saúde da sessão, fila e últimos erros'),
  new SlashCommandBuilder()
    .setName('retry')
    .setDescription('Re-enfileira itens falhos/mortos da fila')
    .addBooleanOption((o) => o.setName('dead').setDescription('Incluir também itens marcados como mortos'))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pausa o bridge de um canal')
    .addChannelOption((o) =>
      o.setName('discord_channel').setDescription('Canal do Discord').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Retoma o bridge de um canal')
    .addChannelOption((o) =>
      o.setName('discord_channel').setDescription('Canal do Discord').addChannelTypes(ChannelType.GuildText).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
  new SlashCommandBuilder().setName('help').setDescription('Como configurar o bridge')
].map((c) => c.toJSON());

export interface CommandDeps {
  store: Store;
  api: PapoApi;
  bridge: Bridge;
  outbox: Outbox;
  logger?: Logger;
}

export async function registerCommands(client: Client, guild: Guild | undefined, log: Logger = scoped('commands')): Promise<void> {
  if (guild) {
    await guild.commands.set(commands);
    log.info({ guild: guild.name }, 'slash commands registrados');
    return;
  }
  await client.application?.commands.set(commands);
  log.info('slash commands registrados globalmente');
}

const flagColumns = {
  attachments: 'bridge_attachments',
  embeds: 'bridge_embeds',
  reactions: 'bridge_reactions',
  edits: 'bridge_edits',
  deletes: 'bridge_deletes',
  pins: 'bridge_pins',
  mentions: 'propagate_mentions'
} as const;

const MODES = ['both', 'to_discord', 'to_papo'] as const;

/** Comandos que exigem permissão de gerenciamento (no Discord, `ManageChannels` via default_member_permissions). */
export const MANAGE_COMMANDS: ReadonlySet<string> = new Set([
  'link-channel',
  'unlink-channel',
  'link-server',
  'link-user',
  'unlink-user',
  'bridge-config',
  'retry',
  'pause',
  'resume'
]);

/* ------------------------------------------------------------------------------------------------
 * Núcleo independente de plataforma
 *
 * `execute` recebe um contexto (Discord ou Papo) e devolve uma saída neutra. Cada adaptador
 * (handleCommand abaixo, handlePapoCommand em papo-commands.ts) converte argumentos de entrada e
 * saída para o formato da sua plataforma.
 * ---------------------------------------------------------------------------------------------- */

export interface ChannelRef {
  id: string;
  name: string | null;
}

export interface UserRef {
  id: string;
  username: string;
  displayName: string;
}

export interface CommandOutput {
  content?: string;
  sections?: { title: string; body: string }[];
  ephemeral?: boolean;
}

/** Erro de argumento: vira uma resposta curta ao usuário, sem stack nos logs. */
export class ArgError extends Error {}

export interface CommandArgs {
  string(name: string): string | null;
  boolean(name: string): boolean | null;
  channel(name: string): Promise<ChannelRef | null>;
  user(name: string): Promise<UserRef | null>;
}

export interface CommandContext {
  platform: 'discord' | 'papo';
  name: string;
  client: Client;
  /** Servidor Discord do contexto (na interação, o da interação; no Papo, o servidor configurado). */
  guild: Guild | null;
  args: CommandArgs;
  /** Autorizado a rodar os comandos de MANAGE_COMMANDS. No Discord quem filtra é o próprio Discord. */
  canManage: boolean;
  /** Papo: id do autor do comando, usado na mensagem de permissão negada. */
  authorId?: string;
  /** Discord: reconhece a interação (3 s). Papo: no-op. */
  defer(): Promise<void>;
  fmtChannel(c: ChannelRef): string;
  fmtUser(u: UserRef): string;
}

function need<T>(value: T | null, name: string): T {
  if (value === null) throw new ArgError(`argumento obrigatório ausente: ${name}`);
  return value;
}

/* ------------------------------ /online: lista só os outros membros ----------------------------- */

interface OnlineRow {
  name: string;
  status: string;
  id?: string;
}

interface SelfIdentity {
  ids: Set<string>;
  names: Set<string>;
}

const SNOWFLAKE = /^\d{17,20}$/;
const looksLikeId = (v: string): boolean => isUuid(v) || SNOWFLAKE.test(v.trim());
const norm = (v: string): string => v.trim().toLowerCase();

/**
 * Remove a própria conta do bridge e resolve linhas cujo "nome" é um uuid/snowflake cru.
 * Id que não resolve para um nome é descartado: mostrar o id não diz nada a quem lê.
 */
async function visibleOnline(
  rows: readonly OnlineRow[],
  self: SelfIdentity,
  resolve: (ids: string[]) => Promise<Map<string, string>>
): Promise<OnlineRow[]> {
  const candidates = rows.filter((r) => {
    const id = r.id?.trim() || (looksLikeId(r.name) ? r.name.trim() : null);
    if (id && self.ids.has(id.toLowerCase())) return false;
    return !self.names.has(norm(r.name));
  });

  const unresolved = [...new Set(candidates.filter((r) => looksLikeId(r.name)).map((r) => norm(r.name)))];
  const names = unresolved.length ? await resolve(unresolved.slice(0, 50)) : new Map<string, string>();

  const out: OnlineRow[] = [];
  for (const r of candidates) {
    if (!looksLikeId(r.name)) {
      out.push(r);
      continue;
    }
    const name = names.get(norm(r.name));
    if (!name || self.names.has(norm(name))) continue;
    out.push({ ...r, name });
  }
  return out;
}

let papoSelfCache: { id: string; names: string[] } | undefined;

async function papoSelf(api: PapoApi, bridge: Bridge): Promise<SelfIdentity> {
  const self: SelfIdentity = { ids: new Set(), names: new Set() };
  const envName = process.env.PAPO_USERNAME;
  if (envName) self.names.add(norm(envName));

  const id = bridge.selfPapoUserId ? String(bridge.selfPapoUserId) : null;
  if (!id) return self;
  self.ids.add(id.toLowerCase());

  if (papoSelfCache?.id !== id) {
    try {
      const profile = (await api.profilesBatch([id])).find((p) => norm(p.id) === norm(id));
      if (profile) {
        papoSelfCache = { id, names: [profile.username, profile.nickname ?? ''].filter(Boolean) };
      }
    } catch {
      /* sem o perfil ainda vale o filtro por id */
    }
  }
  if (papoSelfCache?.id === id) for (const n of papoSelfCache.names) self.names.add(norm(n));
  return self;
}

function discordSelf(client: Client, guild: Guild | null): SelfIdentity {
  const self: SelfIdentity = { ids: new Set(), names: new Set() };
  const me = client.user;
  if (me) {
    self.ids.add(me.id);
    self.names.add(norm(me.username));
    self.names.add(norm(me.displayName));
  }
  const member = guild?.members.me;
  if (member) self.names.add(norm(member.displayName));
  return self;
}

async function resolvePapoNames(api: PapoApi, store: Store, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let n = 0; n < ids.length; n += 50) {
    try {
      for (const p of await api.profilesBatch(ids.slice(n, n + 50))) {
        map.set(norm(p.id), p.nickname || p.username);
        store.upsertPapoUser({ id: p.id, username: p.username, nickname: p.nickname ?? null });
      }
    } catch {
      /* lote que falha só deixa esses ids sem nome */
    }
  }
  return map;
}

async function resolveDiscordNames(client: Client, guild: Guild | null, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const member = guild ? await guild.members.fetch(id).catch(() => null) : null;
      if (member) {
        map.set(id, member.displayName);
        return;
      }
      const user = await client.users.fetch(id).catch(() => null);
      if (user) map.set(id, user.displayName);
    })
  );
  return map;
}

const formatOnline = (rows: readonly OnlineRow[]): string =>
  rows.length ? rows.slice(0, 40).map((r) => `${r.status === 'online' ? '🟢' : '🌙'} ${r.name}`).join('\n') : '_ninguém_';

/* ------------------------------------------- execução ------------------------------------------- */

export async function execute(ctx: CommandContext, deps: CommandDeps): Promise<CommandOutput> {
  const { store, api, bridge, outbox } = deps;
  const { args } = ctx;

  if (MANAGE_COMMANDS.has(ctx.name) && !ctx.canManage) {
    const who = ctx.authorId ? ` (seu id: \`${ctx.authorId}\`)` : '';
    return {
      content: `⛔ sem permissão para \`/${ctx.name}\`${who}. Peça a um administrador do bridge para incluir seu id em \`WORMHOLE_PAPO_ADMIN_IDS\`.`,
      ephemeral: true
    };
  }

  switch (ctx.name) {
    case 'online': {
      await ctx.defer();
      const [papo, discord] = await Promise.all([
        visibleOnline(bridge.papoOnline(), await papoSelf(api, bridge), (ids) => resolvePapoNames(api, store, ids)),
        visibleOnline(bridge.discordOnline(), discordSelf(ctx.client, ctx.guild), (ids) =>
          resolveDiscordNames(ctx.client, ctx.guild, ids)
        )
      ]);
      return {
        sections: [
          { title: 'Online no Papo', body: formatOnline(papo) },
          { title: 'Online no Discord', body: formatOnline(discord) }
        ]
      };
    }

    case 'link-channel': {
      const input = need(args.string('papo_channel'), 'papo_channel');
      const discordChannel = need(await args.channel('discord_channel'), 'discord_channel');
      await ctx.defer();
      const resolved = matchChannel(await api.listChannels(), input);
      if (!resolved.ok) return { content: `❌ canal do Papo não resolvido: ${resolved.message}` };
      const link = store.upsertChannelLink({ papo_channel_id: resolved.value.id, discord_channel_id: discordChannel.id });
      void bridge.drain();
      return {
        content:
          `✅ linkado: Papo #${resolved.value.name} ↔ Discord ${ctx.fmtChannel(discordChannel)} (mode=${link.mode})` +
          `\n\`${resolved.value.id}\``
      };
    }

    case 'unlink-channel': {
      const discordChannel = need(await args.channel('discord_channel'), 'discord_channel');
      const removed = store.removeChannelLink(discordChannel.id);
      return { content: removed ? '🔗 link removido.' : 'nenhum link para esse canal', ephemeral: !removed };
    }

    case 'link-server': {
      const input = need(args.string('papo_server'), 'papo_server');
      if (!ctx.guild) return { content: 'use em um servidor Discord', ephemeral: true };
      await ctx.defer();
      const resolved = matchServer(await api.getServer(), input);
      if (!resolved.ok) return { content: `❌ servidor Papo não resolvido: ${resolved.message}` };
      store.upsertServerLink(resolved.value.id, ctx.guild.id);
      return { content: `✅ servidor Papo ${resolved.value.name} ↔ Discord ${ctx.guild.name}\n\`${resolved.value.id}\`` };
    }

    case 'link-user': {
      const input = need(args.string('papo_user'), 'papo_user');
      const discordUser = need(await args.user('discord_user'), 'discord_user');
      await ctx.defer();
      let resolved: Resolved<PapoUserSummary>;
      if (isUuid(input)) {
        const [profile] = await api.profilesBatch([input.trim()]);
        resolved = profile
          ? { ok: true, value: profile, by: 'uuid' }
          : { ok: false, message: `nenhum usuário do Papo com o uuid ${input.trim()}.` };
      } else {
        resolved = matchUser(await api.listAllUsers(), input);
      }
      if (!resolved.ok) return { content: `❌ usuário do Papo não resolvido: ${resolved.message}` };
      const papo = resolved.value;
      store.upsertPapoUser({ id: papo.id, username: papo.username, nickname: papo.nickname ?? null });
      store.upsertDiscordUser({ id: discordUser.id, username: discordUser.username, display_name: discordUser.displayName });
      store.linkUser(papo.id, discordUser.id);
      return { content: `✅ ${papo.nickname ?? papo.username} (@${papo.username}) ↔ ${ctx.fmtUser(discordUser)}` };
    }

    case 'unlink-user': {
      const discordUser = need(await args.user('discord_user'), 'discord_user');
      const n = store.unlinkUser(discordUser.id);
      return { content: n ? '🔗 mapeamento removido.' : 'nenhum mapeamento', ephemeral: !n };
    }

    case 'bridges': {
      const links = store.listChannelLinks();
      if (!links.length) return { content: 'nenhum canal linkado ainda. Use `/link-channel`.', ephemeral: true };
      await ctx.defer();
      // nome em vez de uuid só para leitura; se o Papo estiver inacessível, mostra o id
      const names = new Map((await api.listChannels().catch(() => [])).map((c) => [c.id, c.name]));
      const lines = links.map(
        (l) =>
          `• ${ctx.fmtChannel({ id: l.discord_channel_id, name: null })} ↔ Papo #${names.get(l.papo_channel_id) ?? l.papo_channel_id} — ${l.mode}` +
          `${l.paused ? ' (pausado)' : ''} · anexos:${l.bridge_attachments ? '✅' : '⛔'} embeds:${l.bridge_embeds ? '✅' : '⛔'} reações:${l.bridge_reactions ? '✅' : '⛔'}`
      );
      return { sections: [{ title: 'Canais linkados', body: lines.join('\n') }] };
    }

    case 'bridge-config': {
      const discordChannel = need(await args.channel('discord_channel'), 'discord_channel');
      const link = store.getChannelLinkByDiscord(discordChannel.id);
      if (!link) return { content: 'esse canal não está linkado.', ephemeral: true };
      const mode = args.string('mode');
      if (mode && !(MODES as readonly string[]).includes(mode)) {
        throw new ArgError(`mode inválido: use ${MODES.join(' | ')}`);
      }
      const flags: [string, boolean][] = [];
      for (const option of Object.keys(flagColumns)) {
        const value = args.boolean(option);
        if (value !== null) flags.push([option, value]);
      }
      if (mode) store.setChannelLinkFlag(link.id, 'mode', mode as never);
      for (const [option, value] of flags) {
        store.setChannelLinkFlag(link.id, flagColumns[option as keyof typeof flagColumns], value ? 1 : 0);
      }
      return { content: '✅ configuração atualizada.' };
    }

    case 'status': {
      const counts = outbox.counts();
      const audit = store.recentAudit(5);
      return {
        sections: [
          {
            title: 'Fila (outbox)',
            body: Object.entries(counts)
              .map(([state, n]) => `${state}: ${n}`)
              .join('\n')
          },
          {
            title: 'Sessão',
            body:
              `Papo: ${api.authenticated ? 'autenticada' : '❌ sem sessão'}\n` +
              `Discord: ${bridge.selfPapoUserId ? 'conectado' : 'conectado'}`
          },
          {
            title: 'Últimos eventos',
            body: audit.length ? audit.map((a) => `${a.ts} [${a.level}] ${a.event}`).join('\n') : '_vazio_'
          }
        ]
      };
    }

    case 'retry': {
      const states: OutboxState[] = args.boolean('dead') ? ['failed', 'dead'] : ['failed'];
      const n = outbox.requeueAll(states);
      void bridge.drain();
      return { content: `♻️ ${n} job(s) re-enfileirado(s).` };
    }

    case 'pause':
    case 'resume': {
      const discordChannel = need(await args.channel('discord_channel'), 'discord_channel');
      const link = store.getChannelLinkByDiscord(discordChannel.id);
      if (!link) return { content: 'esse canal não está linkado.', ephemeral: true };
      store.setChannelLinkFlag(link.id, 'paused', ctx.name === 'pause' ? 1 : 0);
      if (ctx.name === 'resume') void bridge.drain();
      return { content: ctx.name === 'pause' ? '⏸️ bridge pausado.' : '▶️ bridge retomado.' };
    }

    case 'help': {
      const lines = [
        '**1.** `/link-server papo_server:<nome do servidor>`',
        '**2.** `/link-channel papo_channel:<nome do canal> discord_channel:#canal`',
        '**3.** opcional: `/link-user papo_user:<usuário> discord_user:@alguém`, `/bridge-config`, `/pause`',
        '**4.** `/bridges` e `/status` para acompanhar a fila',
        '',
        'Em `papo_server`, `papo_channel` e `papo_user` serve o nome (`Cyber Asilo`, `#geral`, `@jonas`) ou o uuid.',
        'Nome ambíguo: o bot lista as opções e aí o uuid resolve.',
        '',
        'Mensagens, anexos, previews de link, edições, deleções e reações viajam nos dois sentidos.'
      ];
      if (ctx.platform === 'papo') {
        lines.push(
          '',
          '**No Papo:** digite o comando como primeira linha da mensagem. Os argumentos aceitam `chave:valor` ou ordem posicional; use aspas em valores com espaço (`papo_server:"Cyber Asilo"`).',
          'Em `discord_channel` e `discord_user` serve menção, id ou nome. Comandos de configuração exigem id listado em `WORMHOLE_PAPO_ADMIN_IDS`.'
        );
      }
      return { sections: [{ title: 'Papo Wormhole', body: lines.join('\n') }] };
    }

    default:
      return { content: 'comando desconhecido', ephemeral: true };
  }
}

/* ----------------------------------------- adaptador Discord ------------------------------------ */

/**
 * O Discord exige a primeira resposta da interação em 3 s; depois disso o token expira
 * e o callback vira `10062 Unknown interaction`. Comandos que consultam o Papo chamam
 * `deferReply()` antes de qualquer chamada e entregam o resultado por `editReply`.
 */
async function respond(i: ChatInputCommandInteraction, payload: BaseMessageOptions, ephemeral = false): Promise<void> {
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
  if (i.deferred) {
    await i.editReply(payload);
    return;
  }
  if (i.replied) {
    await i.followUp({ ...payload, flags });
    return;
  }
  await i.reply({ ...payload, flags });
}

function toDiscordPayload(out: CommandOutput): BaseMessageOptions {
  const payload: BaseMessageOptions = {};
  if (out.content) payload.content = out.content;
  if (out.sections?.length) payload.embeds = out.sections.map((s) => ({ title: s.title, description: s.body }));
  return payload;
}

export async function handleCommand(i: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
  const log = deps.logger ?? scoped('commands');

  const ctx: CommandContext = {
    platform: 'discord',
    name: i.commandName,
    client: i.client,
    guild: i.guild,
    canManage: true,
    args: {
      string: (n) => i.options.getString(n),
      boolean: (n) => i.options.getBoolean(n),
      channel: async (n) => {
        const c = i.options.getChannel(n);
        return c ? { id: c.id, name: c.name ?? null } : null;
      },
      user: async (n) => {
        const u = i.options.getUser(n);
        return u ? { id: u.id, username: u.username, displayName: u.displayName } : null;
      }
    },
    defer: async () => {
      if (!i.deferred && !i.replied) await i.deferReply();
    },
    fmtChannel: (c) => `<#${c.id}>`,
    fmtUser: (u) => `<@${u.id}>`
  };

  try {
    const out = await execute(ctx, deps);
    await respond(i, toDiscordPayload(out), out.ephemeral);
  } catch (err) {
    if (err instanceof ArgError) {
      await respond(i, { content: `❌ ${err.message}` }, true).catch(() => undefined);
      return;
    }
    log.error({ err, command: i.commandName }, 'comando falhou');
    await respond(i, { content: '⚠️ erro interno; veja os logs.' }, true).catch(() => undefined);
  }
}
