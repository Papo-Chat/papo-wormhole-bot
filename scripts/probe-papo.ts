/**
 * Probes do M0: confirmam contra o backend Papo os limites e comportamentos que o bridge
 * depende e que não estão declarados no openapi.
 *
 * Uso:
 *   npm run probe -- --channel=<uuid-do-canal> [--burst=12] [--attachments] [--ws=25]
 *
 * O script cria e apaga as próprias mensagens de teste (prefixo [probe]).
 */

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PapoApi } from '../src/papo/api.js';
import { PapoApiError } from '../src/papo/types.js';
import { PapoWs } from '../src/papo/ws.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const args = Object.fromEntries(
	process.argv.slice(2).map((a) => {
		const [k, ...rest] = a.replace(/^--/, '').split('=');
		return [k, rest.join('=') || 'true'];
	})
);

const baseUrl = process.env.PAPO_BASE_URL ?? '';
const username = process.env.PAPO_USERNAME ?? '';
const password = process.env.PAPO_PASSWORD ?? '';

if (!baseUrl || !username || !password) {
	console.error('defina PAPO_BASE_URL, PAPO_USERNAME e PAPO_PASSWORD no ambiente ou no .env');
	process.exit(2);
}
if (!args.channel) {
	console.error('uso: npm run probe -- --channel=<uuid do canal do Papo> [--burst=12] [--attachments] [--ws=25]');
	process.exit(2);
}

const channelId = String(args.channel);
const burst = Number(args.burst ?? 0);
const wsSeconds = Number(args.ws ?? 0);
const api = new PapoApi({
	baseUrl,
	username,
	password,
	serverPassword: process.env.PAPO_SERVER_PASSWORD?.trim() || undefined
});

const line = (label: string, value: string) => console.log(`${label.padEnd(42)} ${value}`);
const section = (title: string) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(label: string, fn: () => Promise<string>): Promise<void> {
	try {
		line(label, await fn());
	} catch (err) {
		if (err instanceof PapoApiError) {
			line(label, `HTTP ${err.status} ${err.problem?.title ?? ''} — ${err.problem?.detail ?? err.message}`);
			return;
		}
		line(label, `erro: ${(err as Error).message}`);
	}
}

/** PNG 1×1 válido (usado para probe de emoji). */
const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
	section('sessão');
	await api.login();
	const me = await api.whoami();
	line('autenticado como', `${me.username} (${me.id})`);

	section('canais');
	const channels = await api.listChannels();
	line('canais visíveis', String(channels.length));
	if (!channels.some((c) => c.id === channelId)) {
		console.log(`⚠️  o canal ${channelId} não aparece em GET /channels — o usuário-bot pode não ter acesso`);
	}

	section('limite de content');
	await probe('content com exatamente 8192 chars', async () => {
		const prefix = '[probe] ';
		const msg = await api.sendMessage({ channelId, content: `${prefix}${'a'.repeat(8192 - prefix.length)}` });
		await api.deleteMessage(msg.id);
		return `ok (${msg.content?.length} chars)`;
	});
	await probe('content com 8193 chars (deve falhar)', async () => {
		const prefix = '[probe] ';
		const msg = await api.sendMessage({ channelId, content: `${prefix}${'a'.repeat(8193 - prefix.length)}` });
		await api.deleteMessage(msg.id);
		return 'aceito — o limite é maior que 8192!';
	});

	section('embeds');
	await probe('POST /messages com embed custom', async () => {
		const msg = await api.sendMessage({
			channelId,
			content: '[probe] embed',
			embeds: [
				{
					title: 'título',
					description: 'descrição',
					url: 'https://example.com',
					color: '#00ff00',
					author: { name: 'autor' },
					footer: { text: 'rodapé' },
					fields: [{ name: 'f', value: 'v', inline: true }],
					thumbnail: { url: 'https://example.com/a.png' }
				}
			]
		});
		const list = await api.listMessages(channelId, { order: 'desc' });
		const seen = list.messages.find((m) => m.id === msg.id);
		const back = seen?.embeds?.[0];
		const roundTrip = back
			? `autor=${back.author?.name ?? 'perdido'} footer=${back.footer?.text ?? 'perdido'} fields=${back.fields?.length ?? 0} color=${back.color ?? 'perdido'}`
			: 'embed não voltou na listagem';
		await api.deleteMessage(msg.id);
		return `ok — ${roundTrip}`;
	});
	await probe('embed com 4193 chars de descrição', async () => {
		const msg = await api.sendMessage({
			channelId,
			content: '[probe] embed longo',
			embeds: [{ description: 'd'.repeat(4193) }]
		});
		const list = await api.listMessages(channelId, { order: 'desc' });
		const back = list.messages.find((m) => m.id === msg.id)?.embeds?.[0]?.description?.length;
		await api.deleteMessage(msg.id);
		return `aceito — descrição devolvida com ${back ?? 0} chars`;
	});
	await probe('embed custom com thumbnail (o Papo re-busca a imagem?)', async () => {
		const msg = await api.sendMessage({
			channelId,
			content: '[probe] embed com thumb',
			embeds: [
				{
					title: 'thumb',
					thumbnail: { url: 'https://www.wikipedia.org/static/images/project-logos/enwiki.png', mime_type: 'image/png' }
				}
			]
		});
		const e = msg.embeds?.[0];
		const inMessage = JSON.stringify(e?.thumbnail ?? null);
		let detail = 'sem id de embed';
		if (e?.id) {
			const full = await api.getEmbed(e.id);
			detail = `GET /embeds → thumbnail=${JSON.stringify(full.thumbnail ?? null)} image_data=${full.image_data ? `${full.image_data.length} chars b64` : 'null'}`;
		}
		await api.deleteMessage(msg.id);
		return `na mensagem → thumbnail=${inMessage} · ${detail}`;
	});

	section('link preview e GET /embeds/{id}');
	for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://example.com/']) {
		await probe(`preview de ${url}`, async () => {
			const msg = await api.sendMessage({ channelId, content: `[probe] ${url}` });
			let embeds = msg.embeds ?? [];
			if (!embeds.length) {
				await sleep(3000);
				const list = await api.listMessages(channelId, { order: 'desc' });
				embeds = list.messages.find((m) => m.id === msg.id)?.embeds ?? [];
			}
			const e = embeds[0];
			if (!e) {
				await api.deleteMessage(msg.id);
				return 'nenhum embed gerado';
			}
			const shape = `${e.source_type}/${e.fetch_method ?? '?'}/${e.provider ?? 'sem provider'}`;
			const media = [
				`thumbnail=${JSON.stringify(e.thumbnail ?? null)}`,
				e.image ? `image=${JSON.stringify(e.image)}` : '',
				e.video ? `video=${JSON.stringify(e.video)}` : ''
			]
				.filter(Boolean)
				.join(' ');
			let detail = 'sem id de embed';
			if (e.id) {
				const full = await api.getEmbed(e.id);
				const keys = Object.keys(full).sort().join(',');
				detail = `GET /embeds: image_data=${full.image_data ? `${full.image_data.length} chars b64` : 'null'} thumbnail=${JSON.stringify(full.thumbnail ?? null)}`;
				console.log(`     keys: [${keys}]`);
			}
			await api.deleteMessage(msg.id);
			return `${shape}\n     na mensagem → ${media}\n     ${detail}`;
		});
	}

	section('menções e emoji no content');
	await probe('@mention(<@uuid>) é aceito', async () => {
		const msg = await api.sendMessage({ channelId, content: `[probe] @mention(<@${me.id}>)` });
		await api.deleteMessage(msg.id);
		return 'aceito';
	});
	await probe('shortcode :nome: é aceito', async () => {
		const msg = await api.sendMessage({ channelId, content: '[probe] :wormhole_teste:' });
		await api.deleteMessage(msg.id);
		return 'aceito';
	});
	await probe('POST /emojis (exige manage_server?)', async () => {
		const name = `probe_${randomBytes(3).toString('hex')}`;
		const created = await api.createEmoji(name, TINY_PNG, 'PNG');
		await api.deleteEmoji(created.id).catch(() => undefined);
		return `ok — permissão concedida (emoji ${created.id}, removido)`;
	});

	section('reações');
	await probe('reações unicode (limite declarado: 20)', async () => {
		const msg = await api.sendMessage({ channelId, content: '[probe] reações' });
		const emojis = ['👍', '❤️', '😂', '😮', '😢', '😡', '🔥', '👏', '🎉', '🤔', '👀', '✅', '❌', '💯', '🙏', '😎', '🤯', '😭', '🥳', '🤝', '🫡', '🪄'];
		let added = 0;
		let failure = '';
		for (const emoji of emojis) {
			try {
				await api.addReaction(channelId, msg.id, { unicode: emoji });
				added += 1;
			} catch (err) {
				failure = err instanceof PapoApiError ? `${err.status} ${err.problem?.detail ?? ''}` : String(err);
				break;
			}
		}
		const list = await api.listMessages(channelId, { order: 'desc' });
		const seen = list.messages.find((m) => m.id === msg.id);
		const summary = (seen?.reactions ?? []).map((r) => `${r.unicode ?? r.emoji_id}×${r.count}`).join(' ');
		await api.deleteMessage(msg.id);
		return `${added} aceitas · ${failure || 'nenhuma recusada'} · GET: ${summary}`;
	});
	await probe('reação com emoji_id inexistente', async () => {
		const msg = await api.sendMessage({ channelId, content: '[probe] emoji id' });
		try {
			await api.addReaction(channelId, msg.id, { emojiId: '00000000-0000-4000-8000-000000000000' });
			return 'aceito sem validar (!)';
		} finally {
			await api.deleteMessage(msg.id).catch(() => undefined);
		}
	});
	await probe('GET /reactions devolve user_id?', async () => {
		const msg = await api.sendMessage({ channelId, content: '[probe] autores de reação' });
		await api.addReaction(channelId, msg.id, { unicode: '👍' });
		const res = await api.listReactions(channelId, msg.id);
		await api.deleteMessage(msg.id);
		const first = res.reactions?.[0];
		return first ? `sim — chaves: ${Object.keys(first).join(',')}` : JSON.stringify(res).slice(0, 120);
	});

	section('reply_to');
	await probe('reply_to em mensagem existente', async () => {
		const base = await api.sendMessage({ channelId, content: '[probe] base' });
		const reply = await api.sendMessage({ channelId, content: '[probe] reply', replyTo: base.id });
		await api.deleteMessage(reply.id);
		await api.deleteMessage(base.id);
		return `ok — reply_to devolvido: ${reply.reply_to ?? 'ausente'}`;
	});
	await probe('reply_to em mensagem apagada', async () => {
		const base = await api.sendMessage({ channelId, content: '[probe] base apagada' });
		await api.deleteMessage(base.id);
		const reply = await api.sendMessage({ channelId, content: '[probe] reply órfão', replyTo: base.id });
		await api.deleteMessage(reply.id);
		return `aceito sem erro (reply_to=${reply.reply_to ?? 'null'})`;
	});

	section('pins');
	await probe('pin + GET /channels/{cid}/pinned', async () => {
		const msg = await api.sendMessage({ channelId, content: '[probe] pin' });
		await api.setPin(channelId, msg.id, true);
		const pinned = await api.listPinned(channelId);
		const found = pinned.some((m) => m.id === msg.id);
		await api.setPin(channelId, msg.id, false);
		await api.deleteMessage(msg.id);
		return `pin ok · aparece em GET /pinned: ${found} (${pinned.length} pinadas)`;
	});

	section('attachments');
	if (args.attachments) {
		await probe('upload 1 MB', async () => {
			const msg = await api.sendMessage({
				channelId,
				content: '[probe] anexo 1 MB',
				attachments: [{ name: 'probe_1mb.bin', data: Buffer.alloc(1024 * 1024, 7), mime: 'application/octet-stream' }]
			});
			const att = msg.attachments?.[0];
			await api.deleteMessage(msg.id);
			return `ok — id=${att?.id} mime=${att?.mime_type} nome=${att?.original_file_name} (${att?.size_bytes} bytes)`;
		});
		await probe('upload 101 MB (acima de 100 MB)', async () => {
			const msg = await api.sendMessage({
				channelId,
				content: '[probe] anexo 101 MB',
				attachments: [{ name: 'probe_101mb.bin', data: Buffer.alloc(101 * 1024 * 1024, 7), mime: 'application/octet-stream' }]
			});
			await api.deleteMessage(msg.id);
			return 'aceito — o limite é maior que 100 MB!';
		});
		await probe('11 attachments em uma mensagem', async () => {
			const msg = await api.sendMessage({
				channelId,
				content: '[probe] 11 anexos',
				attachments: Array.from({ length: 11 }, (_, i) => ({
					name: `probe_${i}.bin`,
					data: Buffer.alloc(64, i),
					mime: 'application/octet-stream'
				}))
			});
			await api.deleteMessage(msg.id);
			return 'aceito — o limite é maior que 10!';
		});
	} else {
		console.log('(passe --attachments para rodar os probes de upload)');
	}

	section('rate limit');
	if (burst > 0) {
		const ids: string[] = [];
		const started = Date.now();
		const results: string[] = [];
		for (let i = 0; i < burst; i++) {
			try {
				const msg = await api.sendMessage({ channelId, content: `[probe] rajada ${i + 1}/${burst}` });
				ids.push(msg.id);
				results.push('201');
			} catch (err) {
				if (err instanceof PapoApiError) {
					results.push(`${err.status}${err.problem?.detail ? ` ${err.problem.detail}` : ''}`);
					if (err.status === 429) break;
				} else {
					results.push(`erro ${(err as Error).message}`);
				}
			}
		}
		line(`${burst} mensagens em série (${Date.now() - started} ms)`, results.join(' '));
		for (const id of ids) await api.deleteMessage(id).catch(() => undefined);
	} else {
		console.log('(passe --burst=N para medir rajada; N=12 é um bom começo)');
	}

	section('websocket (tráfego próprio)');
	if (wsSeconds > 0) {
		interface Seen {
			type: string;
			keys: string;
			payload: string;
			n: number;
		}
		const seen = new Map<string, Seen>();
		let opened = false;
		let closed = false;
		const ws = new PapoWs({
			url: process.env.PAPO_WS_URL ?? `${baseUrl.replace(/^http/, 'ws')}/ws`,
			getCookie: () => api.authCookie,
			onOpen: () => {
				opened = true;
			},
			onClose: () => {
				closed = true;
			},
			onEvent: (e) => {
				const raw = JSON.stringify(e);
				const cur = seen.get(e.type) ?? {
					type: e.type,
					keys: Object.keys(e as Record<string, unknown>).sort().join(','),
					payload: raw.length > 400 ? `${raw.slice(0, 400)}…` : raw,
					n: 0
				};
				cur.n += 1;
				seen.set(e.type, cur);
			}
		});
		ws.connect();
		for (let i = 0; i < 50 && !opened; i++) await sleep(100);
		line('handshake WS', opened ? 'ok' : 'FALHOU (sem cookie ou endpoint errado)');

		const started = Date.now();
		const denied: string[] = [];
		const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
			try {
				await fn();
			} catch (err) {
				denied.push(
					`${label}: ${err instanceof PapoApiError ? `${err.status} ${err.problem?.detail ?? ''}` : (err as Error).message}`
				);
			}
		};

		const msg = await api.sendMessage({ channelId, content: '[probe] ws' });
		await sleep(500);
		await attempt('edit', () => api.editMessage(msg.id, '[probe] ws editado'));
		await sleep(400);
		await attempt('react 👍', () => api.addReaction(channelId, msg.id, { unicode: '👍' }));
		await sleep(300);
		await attempt('react ❤️', () => api.addReaction(channelId, msg.id, { unicode: '❤️' }));
		await sleep(300);
		await attempt('unreact 👍', () => api.removeReaction(channelId, msg.id, { unicode: '👍' }));
		await sleep(300);
		await attempt('pin', () => api.setPin(channelId, msg.id, true));
		await sleep(300);
		await attempt('unpin', () => api.setPin(channelId, msg.id, false));
		await sleep(300);
		await api.deleteMessage(msg.id).catch(() => undefined);
		line('ações recusadas', denied.length ? denied.join(' · ') : 'nenhuma');
		await sleep(Math.max(1500, wsSeconds * 1000 - (Date.now() - started)));
		ws.close();

		line('eventos observados', seen.size ? [...seen].map(([, v]) => `${v.type}×${v.n}`).join(', ') : 'nenhum');
		line('fechamento', closed ? 'close limpo (sem reconexão espúria)' : 'sem close');
		for (const [, v] of [...seen].sort((a, b) => a[0].localeCompare(b[0]))) {
			console.log(`\n  ${v.type}  ·  chaves: ${v.keys}`);
			console.log(`  ${v.payload}`);
		}
	} else {
		console.log('(passe --ws=N para observar N segundos de WS com tráfego próprio)');
	}

	section('limpeza');
	const leftovers = (await api.listMessages(channelId, { order: 'desc' })).messages.filter((m) =>
		m.content?.startsWith('[probe]')
	);
	for (const m of leftovers) await api.deleteMessage(m.id).catch(() => undefined);
	line('mensagens [probe] removidas', String(leftovers.length));
	const probeEmojis = (await api.listAllEmojis()).filter((e) => e.name?.startsWith('probe_'));
	for (const e of probeEmojis) await api.deleteEmoji(e.id).catch(() => undefined);
	line('emojis probe_* removidos', String(probeEmojis.length));
}

main().catch((err) => {
	console.error('probe falhou:', err instanceof PapoApiError ? `HTTP ${err.status} ${err.problem?.detail ?? err.message}` : err);
	process.exit(1);
});
