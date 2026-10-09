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
			o.setName('discord_channel').setDescription('Canal do Discord').addChannelTypes(ChannelType.GuildText).setRequired(true)
		)
		.setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),
	new SlashCommandBuilder()
		.setName('unlink-channel')
		.setDescription('Remove o link de um canal')
		.addChannelOption((o) =>
			o.setName('discord_channel').setDescription('Canal do Discord').addChannelTypes(ChannelType.GuildText).setRequired(true)
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

export async function handleCommand(i: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
	const log = deps.logger ?? scoped('commands');
	const { store, api, bridge, outbox } = deps;
	const reply = (payload: BaseMessageOptions, ephemeral = false): Promise<void> => respond(i, payload, ephemeral);

	try {
		switch (i.commandName) {
			case 'online': {
				const papo = bridge.papoOnline();
				const discord = bridge.discordOnline();
				const fmt = (rows: { name: string; status: string }[]) =>
					rows.length ? rows.slice(0, 40).map((r) => `${r.status === 'online' ? '🟢' : '🌙'} ${r.name}`).join('\n') : '_ninguém_';
				await reply({
					embeds: [
						{ title: 'Online no Papo', description: fmt(papo) },
						{ title: 'Online no Discord', description: fmt(discord) }
					]
				});
				return;
			}

			case 'link-channel': {
				const input = i.options.getString('papo_channel', true);
				const discordChannel = i.options.getChannel('discord_channel', true);
				await i.deferReply();
				const resolved = matchChannel(await api.listChannels(), input);
				if (!resolved.ok) {
					await reply({ content: `❌ canal do Papo não resolvido: ${resolved.message}` });
					return;
				}
				const link = store.upsertChannelLink({ papo_channel_id: resolved.value.id, discord_channel_id: discordChannel.id });
				await reply({
					content:
						`✅ linkado: Papo #${resolved.value.name} ↔ Discord <#${discordChannel.id}> (mode=${link.mode})` +
						`\n\`${resolved.value.id}\``
				});
				void bridge.drain();
				return;
			}

			case 'unlink-channel': {
				const discordChannel = i.options.getChannel('discord_channel', true);
				const removed = store.removeChannelLink(discordChannel.id);
				await reply({ content: removed ? '🔗 link removido.' : 'nenhum link para esse canal' }, !removed);
				return;
			}

			case 'link-server': {
				const input = i.options.getString('papo_server', true);
				if (!i.guild) {
					await reply({ content: 'use em um servidor Discord' }, true);
					return;
				}
				await i.deferReply();
				const resolved = matchServer(await api.getServer(), input);
				if (!resolved.ok) {
					await reply({ content: `❌ servidor Papo não resolvido: ${resolved.message}` });
					return;
				}
				store.upsertServerLink(resolved.value.id, i.guild.id);
				await reply({
					content: `✅ servidor Papo ${resolved.value.name} ↔ Discord ${i.guild.name}\n\`${resolved.value.id}\``
				});
				return;
			}

			case 'link-user': {
				const input = i.options.getString('papo_user', true);
				const discordUser = i.options.getUser('discord_user', true);
				await i.deferReply();
				let resolved: Resolved<PapoUserSummary>;
				if (isUuid(input)) {
					const [profile] = await api.profilesBatch([input.trim()]);
					resolved = profile
						? { ok: true, value: profile, by: 'uuid' }
						: { ok: false, message: `nenhum usuário do Papo com o uuid ${input.trim()}.` };
				} else {
					resolved = matchUser(await api.listAllUsers(), input);
				}
				if (!resolved.ok) {
					await reply({ content: `❌ usuário do Papo não resolvido: ${resolved.message}` });
					return;
				}
				const papo = resolved.value;
				store.upsertPapoUser({ id: papo.id, username: papo.username, nickname: papo.nickname ?? null });
				store.upsertDiscordUser({ id: discordUser.id, username: discordUser.username, display_name: discordUser.displayName });
				store.linkUser(papo.id, discordUser.id);
				await reply({ content: `✅ ${papo.nickname ?? papo.username} (@${papo.username}) ↔ ${discordUser}` });
				return;
			}

			case 'unlink-user': {
				const discordUser = i.options.getUser('discord_user', true);
				const n = store.unlinkUser(discordUser.id);
				await reply({ content: n ? '🔗 mapeamento removido.' : 'nenhum mapeamento' }, !n);
				return;
			}

			case 'bridges': {
				const links = store.listChannelLinks();
				if (!links.length) {
					await reply({ content: 'nenhum canal linkado ainda. Use `/link-channel`.' }, true);
					return;
				}
				await i.deferReply();
				// nome em vez de uuid só para leitura; se o Papo estiver inacessível, mostra o id
				const names = new Map((await api.listChannels().catch(() => [])).map((c) => [c.id, c.name]));
				const lines = links.map(
					(l) =>
						`• <#${l.discord_channel_id}> ↔ Papo #${names.get(l.papo_channel_id) ?? l.papo_channel_id} — ${l.mode}` +
						`${l.paused ? ' (pausado)' : ''} · anexos:${l.bridge_attachments ? '✅' : '⛔'} embeds:${l.bridge_embeds ? '✅' : '⛔'} reações:${l.bridge_reactions ? '✅' : '⛔'}`
				);
				await reply({ embeds: [{ title: 'Canais linkados', description: lines.join('\n') }] });
				return;
			}

			case 'bridge-config': {
				const discordChannel = i.options.getChannel('discord_channel', true);
				const link = store.getChannelLinkByDiscord(discordChannel.id);
				if (!link) {
					await reply({ content: 'esse canal não está linkado.' }, true);
					return;
				}
				const mode = i.options.getString('mode');
				if (mode) store.setChannelLinkFlag(link.id, 'mode', mode as never);
				for (const [option, column] of Object.entries(flagColumns)) {
					const value = i.options.getBoolean(option);
					if (value !== null) store.setChannelLinkFlag(link.id, column, value ? 1 : 0);
				}
				await reply({ content: '✅ configuração atualizada.' });
				return;
			}

			case 'status': {
				const counts = outbox.counts();
				const audit = store.recentAudit(5);
				const embeds = [
					{
						title: 'Fila (outbox)',
						description: Object.entries(counts)
							.map(([state, n]) => `${state}: ${n}`)
							.join('\n')
					},
					{
						title: 'Sessão',
						description:
							`Papo: ${api.authenticated ? 'autenticada' : '❌ sem sessão'}\n` +
							`Discord: ${bridge.selfPapoUserId ? 'conectado' : 'conectado'}`
					},
					{
						title: 'Últimos eventos',
						description: audit.length ? audit.map((a) => `${a.ts} [${a.level}] ${a.event}`).join('\n') : '_vazio_'
					}
				];
				await reply({ embeds });
				return;
			}

			case 'retry': {
				const states: OutboxState[] = i.options.getBoolean('dead') ? ['failed', 'dead'] : ['failed'];
				const n = outbox.requeueAll(states);
				await reply({ content: `♻️ ${n} job(s) re-enfileirado(s).` });
				void bridge.drain();
				return;
			}

			case 'pause':
			case 'resume': {
				const discordChannel = i.options.getChannel('discord_channel', true);
				const link = store.getChannelLinkByDiscord(discordChannel.id);
				if (!link) {
					await reply({ content: 'esse canal não está linkado.' }, true);
					return;
				}
				store.setChannelLinkFlag(link.id, 'paused', i.commandName === 'pause' ? 1 : 0);
				await reply({ content: i.commandName === 'pause' ? '⏸️ bridge pausado.' : '▶️ bridge retomado.' });
				if (i.commandName === 'resume') void bridge.drain();
				return;
			}

			case 'help': {
				await reply({
					embeds: [
						{
							title: 'Papo Wormhole',
							description: [
								'**1.** `/link-server papo_server:<nome do servidor>`',
								'**2.** `/link-channel papo_channel:<nome do canal> discord_channel:#canal`',
								'**3.** opcional: `/link-user papo_user:<usuário> discord_user:@alguém`, `/bridge-config`, `/pause`',
								'**4.** `/bridges` e `/status` para acompanhar a fila',
								'',
								'Em `papo_server`, `papo_channel` e `papo_user` serve o nome (`Cyber Asilo`, `#geral`, `@jonas`) ou o uuid.',
								'Nome ambíguo: o bot lista as opções e aí o uuid resolve.',
								'',
								'Mensagens, anexos, previews de link, edições, deleções e reações viajam nos dois sentidos.'
							].join('\n')
						}
					]
				});
				return;
			}

			default:
				await reply({ content: 'comando desconhecido' }, true);
		}
	} catch (err) {
		log.error({ err, command: i.commandName }, 'comando falhou');
		await respond(i, { content: '⚠️ erro interno; veja os logs.' }, true).catch(() => undefined);
	}
}
