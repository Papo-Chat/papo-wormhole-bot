import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareAttachments, sanitizeName, type SourceAttachment } from '../src/bridge/attachments.js';

const source = (over: Partial<SourceAttachment> & { name: string; data?: Buffer }): SourceAttachment => ({
	id: over.id ?? 'a1',
	name: over.name,
	mime: over.mime ?? 'application/octet-stream',
	sizeBytes: over.sizeBytes ?? 10,
	directUrl: over.directUrl,
	moderationStatus: over.moderationStatus,
	download: async () => over.data ?? Buffer.alloc(over.sizeBytes ?? 10, 3)
});

describe('sanitizeName', () => {
	it('remove separadores de path e caracteres de controle', () => {
		expect(sanitizeName('../../etc/passwd')).toBe('.._.._etc_passwd');
		expect(sanitizeName('a\x00b:c*d?.txt')).toBe('a_b_c_d_.txt');
	});

	it('limita o tamanho mantendo a extensão', () => {
		const name = sanitizeName('x'.repeat(300) + '.png', 128);
		expect(name.length).toBe(128);
		expect(name.endsWith('.png')).toBe(true);
	});

	it('nunca retorna vazio', () => {
		expect(sanitizeName('   ')).toBe('arquivo');
	});
});

describe('prepareAttachments', () => {
	it('reenvia arquivos que cabem no limite', async () => {
		const plan = await prepareAttachments([source({ name: 'foto.png', mime: 'image/png', sizeBytes: 1000 })], {
			maxFileBytes: 20 * 1024 * 1024,
			maxFilesPerMessage: 10
		});
		expect(plan.groups[0]?.[0]?.name).toBe('foto.png');
		expect(plan.notes).toEqual([]);
		expect(plan.blocked).toBe(false);
	});

	it('compacta texto grande para caber no destino', async () => {
		const data = Buffer.from('linha de log\n'.repeat(50_000)); // 650 KB muito compressível
		const plan = await prepareAttachments(
			[
				{
					...source({ name: 'huge.log', mime: 'text/plain', sizeBytes: data.length }),
					download: async () => data
				}
			],
			{ maxFileBytes: 100 * 1024, maxFilesPerMessage: 10 }
		);
		expect(plan.groups[0]?.[0]?.name).toBe('huge.log.gz');
		expect(plan.groups[0]![0]!.data.length).toBeLessThan(data.length);
		expect(plan.notes.join(' ')).toContain('compactado');
	});

	it('particiona quando nem a compressão resolve', async () => {
		const data = randomBytes(3 * 1024 * 1024); // incompressível, mas marcado como texto
		const plan = await prepareAttachments(
			[{ ...source({ name: 'blob.txt', mime: 'text/plain', sizeBytes: data.length }), download: async () => data }],
			{ maxFileBytes: 1024 * 1024, maxFilesPerMessage: 10, partTargetBytes: 900 * 1024 }
		);
		const files = plan.groups[0] ?? [];
		expect(files.length).toBeGreaterThan(1);
		expect(files.every((f) => f.part)).toBe(true);
		expect(files.every((f) => f.data.length <= 1024 * 1024)).toBe(true);
		expect(plan.notes.join(' ')).toContain('particionado');
		expect(plan.notes.join(' ')).toContain('tar xzf');
	});

	it('não recomprime mídia grande: avisa e mantém o link direto', async () => {
		const data = Buffer.alloc(30 * 1024 * 1024, 9);
		const plan = await prepareAttachments(
			[
				{
					...source({
						name: 'video.mp4',
						mime: 'video/mp4',
						sizeBytes: data.length,
						directUrl: 'https://cdn.discordapp.com/attachments/1/2/video.mp4'
					}),
					download: async () => data
				}
			],
			{ maxFileBytes: 20 * 1024 * 1024, maxFilesPerMessage: 10 }
		);
		expect(plan.groups.flat().length).toBe(0);
		expect(plan.notes.join(' ')).toContain('excede o limite');
		expect(plan.notes.join(' ')).toContain('https://cdn.discordapp.com/attachments/1/2/video.mp4');
	});

	it('respeita o status de moderação do Papo', async () => {
		const plan = await prepareAttachments(
			[
				source({ id: 'b', name: 'ruim.png', moderationStatus: 'blocked' }),
				source({ id: 'c', name: 'duvidoso.png', moderationStatus: 'pending' }),
				source({ id: 'd', name: 'ok.png', moderationStatus: 'clean' })
			],
			{ maxFileBytes: 1024, maxFilesPerMessage: 10 }
		);
		expect(plan.blocked).toBe(true);
		expect(plan.groups.flat().map((f) => f.name)).toEqual(['ok.png']);
		expect(plan.notes.join(' ')).toContain('bloqueado pela moderação');
		expect(plan.notes.join(' ')).toContain('análise de moderação');
	});

	it('agrupa em blocos de até maxFilesPerMessage arquivos', async () => {
		const sources = Array.from({ length: 14 }, (_, i) => source({ id: `f${i}`, name: `f${i}.txt`, mime: 'text/plain' }));
		const plan = await prepareAttachments(sources, { maxFileBytes: 1024, maxFilesPerMessage: 10 });
		expect(plan.groups.map((g) => g.length)).toEqual([10, 4]);
	});
});
