import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { Store } from '../src/db/store.js';

const PAPO_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const fixture = () => {
	const db = openDb(':memory:');
	return { db, store: new Store(db) };
};

describe('channel links', () => {
	it('cria e recupera por Papo, Discord e id', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		expect(link.mode).toBe('both');
		expect(link.bridge_attachments).toBe(1);
		expect(link.bridge_pins).toBe(0);
		expect(store.getChannelLinkByDiscord('111')?.id).toBe(link.id);
		expect(store.getChannelLinkById(link.id)?.papo_channel_id).toBe('p1');
	});

	it('upsert substitui o canal Discord do mesmo canal Papo', () => {
		const { store } = fixture();
		store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		const updated = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '222', mode: 'to_discord' });
		expect(updated.discord_channel_id).toBe('222');
		expect(updated.mode).toBe('to_discord');
		expect(store.listChannelLinks().length).toBe(1);
	});

	it('altera flags individualmente', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.setChannelLinkFlag(link.id, 'paused', 1);
		store.setChannelLinkFlag(link.id, 'propagate_mentions', 1);
		const after = store.getChannelLinkById(link.id)!;
		expect(after.paused).toBe(1);
		expect(after.propagate_mentions).toBe(1);
		expect(after.bridge_embeds).toBe(1);
	});

	it('recusa flags desconhecidas', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		expect(() => store.setChannelLinkFlag(link.id, 'id' as never, 1)).toThrow(/flag desconhecida/);
	});

	it('remove por canal Discord', () => {
		const { store } = fixture();
		store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		expect(store.removeChannelLink('111')).toBe(true);
		expect(store.removeChannelLink('111')).toBe(false);
	});
});

describe('cursor Papo por link (fila começa no link)', () => {
	it('semeia o cursor no instante em que o link é criado', () => {
		const { store } = fixture();
		const hourAgo = new Date(Date.now() - 3600_000).toISOString();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		const cursor = store.getPapoCursor(link.id);
		expect(cursor).toBeDefined();
		expect((cursor ?? '') >= hourAgo).toBe(true);
	});

	it('relinkar o mesmo canal não move o cursor', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.setPapoCursor(link.id, '2026-01-01T00:00:00.000Z');
		const updated = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '222' });
		expect(updated.id).toBe(link.id);
		expect(store.getPapoCursor(link.id)).toBe('2026-01-01T00:00:00.000Z');
	});

	it('unlink limpa o cursor', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.removeChannelLink('111');
		expect(store.getPapoCursor(link.id)).toBeUndefined();
	});
});

describe('message map', () => {
	it('mapeia nos dois sentidos e consulta por cada lado', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.mapMessage({ link_id: link.id, direction: 'papo_to_discord', papo_message_id: 'pm1', discord_message_id: 'dm1' });
		expect(store.findMapByPapo('pm1')[0]?.discord_message_id).toBe('dm1');
		expect(store.findMapByDiscord('dm1')[0]?.papo_message_id).toBe('pm1');
	});

	it('deduplica chunks repetidos (idempotência de reenvio)', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.mapMessage({ link_id: link.id, direction: 'papo_to_discord', papo_message_id: 'pm1', discord_message_id: 'dm1', chunk_index: 0 });
		store.mapMessage({ link_id: link.id, direction: 'papo_to_discord', papo_message_id: 'pm1', discord_message_id: 'dm2', chunk_index: 0 });
		const rows = store.findMapByPapo('pm1');
		expect(rows.length).toBe(1);
		expect(rows[0]?.discord_message_id).toBe('dm1');
	});

	it('guarda chunks separados da mesma mensagem', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		for (let i = 0; i < 3; i++) {
			store.mapMessage({
				link_id: link.id,
				direction: 'papo_to_discord',
				papo_message_id: 'pm1',
				discord_message_id: `dm${i}`,
				chunk_index: i,
				chunk_total: 3
			});
		}
		expect(store.findMapByPapo('pm1').map((r) => r.chunk_index)).toEqual([0, 1, 2]);
	});

	it('marca deleção sem apagar o histórico', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.mapMessage({ link_id: link.id, direction: 'discord_to_papo', papo_message_id: 'pm1', discord_message_id: 'dm1' });
		store.markMapDeleted(undefined, 'dm1');
		const row = store.findMapByDiscord('dm1')[0];
		expect(row?.deleted).toBe(1);
		expect(row?.papo_message_id).toBe('pm1');
	});

	it('cascade remove o mapa quando o link é removido', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.mapMessage({ link_id: link.id, direction: 'papo_to_discord', papo_message_id: 'pm1', discord_message_id: 'dm1' });
		store.removeChannelLink('111');
		expect(store.findMapByPapo('pm1').length).toBe(0);
	});
});

describe('usuários e links de usuário', () => {
	it('mantém nickname e avatar entre atualizações', () => {
		const { store } = fixture();
		store.upsertPapoUser({ id: PAPO_UUID, username: 'ze', nickname: 'Zé', avatar_sha: 'abc' });
		store.upsertPapoUser({ id: PAPO_UUID, username: 'ze2' });
		const user = store.getPapoUser(PAPO_UUID)!;
		expect(user.username).toBe('ze2');
		expect(user.nickname).toBe('Zé');
		expect(user.avatar_sha).toBe('abc');
	});

	it('linka e deslinka usuário', () => {
		const { store } = fixture();
		store.upsertPapoUser({ id: PAPO_UUID, username: 'ze' });
		store.upsertDiscordUser({ id: '111', username: 'ze_br', display_name: 'Zé' });
		store.linkUser(PAPO_UUID, '111');
		store.linkUser(PAPO_UUID, '111'); // idempotente
		expect(store.getLinkByDiscordUser('111')?.papo_user_id).toBe(PAPO_UUID);
		expect(store.getLinkByPapoUser(PAPO_UUID)?.discord_user_id).toBe('111');
		expect(store.unlinkUser('111')).toBe(1);
		expect(store.getLinkByDiscordUser('111')).toBeUndefined();
	});

	it('link de usuário some junto com o usuário Papo', () => {
		const { store, db } = fixture();
		store.upsertPapoUser({ id: PAPO_UUID, username: 'ze' });
		store.upsertDiscordUser({ id: '111', username: 'ze_br' });
		store.linkUser(PAPO_UUID, '111');
		db.prepare('DELETE FROM users_papo WHERE id = ?').run(PAPO_UUID);
		expect(store.getLinkByDiscordUser('111')).toBeUndefined();
	});
});

describe('emojis', () => {
	it('normaliza nome em minúsculas e preenche os dois lados', () => {
		const { store } = fixture();
		store.upsertEmoji({ name: 'Papu', papo_emoji_id: 'e1' });
		store.upsertEmoji({ name: 'papu', discord_emoji_id: 'd1', discord_animated: true });
		const row = store.getEmojiByName('PAPU')!;
		expect(row.papo_emoji_id).toBe('e1');
		expect(row.discord_emoji_id).toBe('d1');
		expect(row.discord_animated).toBe(1);
		expect(store.getEmojiByPapoId('e1')?.name).toBe('papu');
	});
});

describe('presença', () => {
	it('guarda por plataforma e usuário', () => {
		const { store } = fixture();
		store.setPresence('papo', 'u1', 'online');
		store.setPresence('discord', 'u1', 'idle');
		store.setPresence('papo', 'u2', 'offline');
		expect(store.listPresence('papo').map((r) => r.user_id)).toEqual(['u1']);
		expect(store.listPresence('discord').map((r) => r.status)).toEqual(['idle']);
		expect(store.listPresence('papo', ['online', 'away', 'busy', 'offline']).length).toBe(2);
	});
});

describe('reações (resumo do rodapé)', () => {
	it('grava contagem absoluta e sobrescreve', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm1', emoji: '👍', count: 1 });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm1', emoji: '👍', count: 4 });
		expect(store.listReactions(link.id, 'papo', 'pm1')).toEqual([{ emoji: '👍', count: 4 }]);
	});

	it('contagem zero remove o emoji do resumo', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm1', emoji: '👍', count: 2 });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm1', emoji: '👍', count: 0 });
		expect(store.listReactions(link.id, 'papo', 'pm1')).toEqual([]);
	});

	it('ordena por contagem e separa por origem', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm1', emoji: '❤️', count: 1 });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm1', emoji: '👍', count: 5 });
		store.setReaction({ linkId: link.id, source: 'discord', sourceMessageId: 'dm9', emoji: ':papu:', count: 2 });
		expect(store.listReactions(link.id, 'papo', 'pm1').map((r) => r.emoji)).toEqual(['👍', '❤️']);
		expect(store.listReactions(link.id, 'discord', 'dm9').map((r) => r.emoji)).toEqual([':papu:']);
		expect(store.listReactions(link.id, 'papo', 'outra')).toEqual([]);
	});

	it('reações somem junto com o canal-link', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.setReaction({ linkId: link.id, source: 'papo', sourceMessageId: 'pm1', emoji: '👍', count: 3 });
		store.removeChannelLink('111');
		expect(store.listReactions(link.id, 'papo', 'pm1')).toEqual([]);
	});
});

describe('eco de reação própria (anti-loop)', () => {
	it('reconhece a reação que acabamos de aplicar no Papo', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.markSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: ':papu:' });
		expect(store.isSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: ':papu:', withinSeconds: 30 })).toBe(true);
		expect(store.isSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: '👍', withinSeconds: 30 })).toBe(false);
		expect(store.isSelfReaction({ linkId: link.id, destinationMessageId: 'pm2', emoji: ':papu:', withinSeconds: 30 })).toBe(false);
		expect(store.isSelfReaction({ linkId: link.id + 1, destinationMessageId: 'pm1', emoji: ':papu:', withinSeconds: 30 })).toBe(false);
	});

	it('deixa de reconhecer depois da janela e o prune limpa as linhas velhas', () => {
		const { db, store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.markSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: '👍' });
		expect(store.pruneSelfReactions(3600)).toBe(0);
		db.prepare(`UPDATE self_reactions SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')`).run();
		expect(store.isSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: '👍', withinSeconds: 120 })).toBe(false);
		expect(store.pruneSelfReactions(120)).toBe(1);
	});

	it('reaplicar renova a janela em vez de duplicar a linha', () => {
		const { db, store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.markSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: '👍' });
		db.prepare(`UPDATE self_reactions SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')`).run();
		store.markSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: '👍' });
		expect(store.pruneSelfReactions(120)).toBe(0);
		expect(store.isSelfReaction({ linkId: link.id, destinationMessageId: 'pm1', emoji: '👍', withinSeconds: 120 })).toBe(true);
	});
});

describe('snapshot do embed enviado', () => {
	it('guarda rendered, embed e rodapé base para re-renderir', () => {
		const { store } = fixture();
		const link = store.upsertChannelLink({ papo_channel_id: 'p1', discord_channel_id: '111' });
		store.mapMessage({
			link_id: link.id,
			direction: 'papo_to_discord',
			papo_message_id: 'pm1',
			discord_message_id: 'dm1',
			rendered: 'corpo enviado',
			bridge_embed: { author: { name: 'Zé' }, description: 'corpo enviado', footer: { text: '🕒 · Papo' } },
			footer_base: '🕒 09/10/2026 · Papo'
		});
		const row = store.findMapByPapo('pm1')[0]!;
		expect(row.rendered).toBe('corpo enviado');
		expect(row.footer_base).toBe('🕒 09/10/2026 · Papo');
		expect(JSON.parse(row.bridge_embed ?? '{}').author.name).toBe('Zé');
	});
});

describe('meta e audit', () => {
	it('meta é upsert', () => {
		const { store } = fixture();
		store.setMeta('cursor', '2026-01-01T00:00:00.000Z');
		store.setMeta('cursor', '2026-01-02T00:00:00.000Z');
		expect(store.getMeta('cursor')).toBe('2026-01-02T00:00:00.000Z');
		expect(store.getMeta('inexistente')).toBeUndefined();
	});

	it('audit registra eventos em ordem inversa', () => {
		const { store } = fixture();
		store.audit('info', 'boot', { links: 1 });
		store.audit('warn', 'rate_limit');
		const rows = store.recentAudit(5);
		expect(rows[0]?.event).toBe('rate_limit');
		expect(JSON.parse(rows[1]?.payload ?? '{}')).toEqual({ links: 1 });
	});
});

describe('webhooks do bridge (por usuário, por canal)', () => {
	it('registra e recupera o webhook do par (canal, usuário)', () => {
		const { store } = fixture();
		store.upsertBridgeWebhook({ webhook_id: 'w1', channel_id: '111', papo_user_id: PAPO_UUID, name: 'Jenga (@jenga)', avatar_sha: 'sha1' });

		const byUser = store.getBridgeWebhookByUser('111', PAPO_UUID);
		expect(byUser?.webhook_id).toBe('w1');
		expect(byUser?.name).toBe('Jenga (@jenga)');
		expect(byUser?.avatar_sha).toBe('sha1');

		const byId = store.getBridgeWebhookById('w1');
		expect(byId?.channel_id).toBe('111');
		expect(byId?.papo_user_id).toBe(PAPO_UUID);

		expect(store.listBridgeWebhookIds('111')).toEqual(['w1']);
		expect(store.listBridgeWebhookIds('outro')).toEqual([]);
	});

	it('atualiza identidade do mesmo webhook sem duplicar', () => {
		const { store } = fixture();
		store.upsertBridgeWebhook({ webhook_id: 'w1', channel_id: '111', papo_user_id: PAPO_UUID, name: 'Jenga (@jenga)', avatar_sha: 'sha1' });
		store.upsertBridgeWebhook({ webhook_id: 'w1', channel_id: '111', papo_user_id: PAPO_UUID, name: 'Jotac (@jenga)', avatar_sha: 'sha2' });

		const row = store.getBridgeWebhookByUser('111', PAPO_UUID);
		expect(row?.name).toBe('Jotac (@jenga)');
		expect(row?.avatar_sha).toBe('sha2');
		expect(store.listBridgeWebhookIds('111')).toEqual(['w1']);
	});

	it('webhook recriado para o mesmo usuário substitui a linha (índice único)', () => {
		const { store } = fixture();
		store.upsertBridgeWebhook({ webhook_id: 'w1', channel_id: '111', papo_user_id: PAPO_UUID, name: 'Jenga (@jenga)' });
		store.upsertBridgeWebhook({ webhook_id: 'w2', channel_id: '111', papo_user_id: PAPO_UUID, name: 'Jenga (@jenga)' });

		expect(store.getBridgeWebhookByUser('111', PAPO_UUID)?.webhook_id).toBe('w2');
		expect(store.getBridgeWebhookById('w1')).toBeUndefined();
		expect(store.listBridgeWebhookIds('111')).toEqual(['w2']);
	});

	it('usuários diferentes no mesmo canal têm webhooks diferentes', () => {
		const { store } = fixture();
		const other = '11111111-2222-4333-8444-555555555555';
		store.upsertBridgeWebhook({ webhook_id: 'w1', channel_id: '111', papo_user_id: PAPO_UUID, name: 'jenga' });
		store.upsertBridgeWebhook({ webhook_id: 'w2', channel_id: '111', papo_user_id: other, name: 'ana' });

		expect(store.listBridgeWebhookIds('111').sort()).toEqual(['w1', 'w2']);
		store.deleteBridgeWebhook('w1');
		expect(store.getBridgeWebhookById('w1')).toBeUndefined();
		expect(store.listBridgeWebhookIds('111')).toEqual(['w2']);
	});
});
