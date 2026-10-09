import { gzip, isCompressibleMime, partition, tarGz } from './tar.js';
import { PART_TARGET_BYTES } from './limits.js';

export interface SourceAttachment {
	id: string;
	name: string;
	mime?: string | null;
	sizeBytes: number;
	download: () => Promise<Buffer>;
	/** URL pública para fallback quando o arquivo não pode ser reenviado. */
	directUrl?: string;
	thumbnailUrl?: string;
	moderationStatus?: string;
}

export interface PreparedAttachment {
	name: string;
	data: Buffer;
	mime?: string;
	/** true quando o arquivo é uma parte de um arquivo maior. */
	part?: boolean;
}

export interface AttachmentLimits {
	maxFileBytes: number;
	maxFilesPerMessage: number;
	partTargetBytes?: number;
}

export interface AttachmentPlan {
	/** Grupos de arquivos; cada grupo vira uma mensagem no destino. */
	groups: PreparedAttachment[][];
	/** Avisos humanos sobre o que foi convertido, compactado ou omitido. */
	notes: string[];
	/** true quando algum arquivo foi omitido por moderação. */
	blocked: boolean;
}

/** Nome seguro para o destino (sem path, sem caracteres de controle). */
export function sanitizeName(name: string, max = 128): string {
	const clean = name
		.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
		.replace(/\s+/g, ' ')
		.trim();
	const base = clean || 'arquivo';
	return base.length <= max ? base : `${base.slice(0, max - 8)}${base.slice(-8)}`;
}

const formatBytes = (n: number): string => {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${n} B`;
};

/**
 * Decide o destino de cada attachment: reenviar, compactar, particionar ou só avisar.
 * Nunca recomprime mídia já comprimida (vídeo/imagem pesada): nesses casos o arquivo
 * é substituído por aviso + link direto.
 */
export async function prepareAttachments(
	sources: SourceAttachment[],
	limits: AttachmentLimits
): Promise<AttachmentPlan> {
	const partTarget = limits.partTargetBytes ?? PART_TARGET_BYTES;
	const flat: PreparedAttachment[] = [];
	const notes: string[] = [];
	let blocked = false;

	for (const a of sources) {
		if (a.moderationStatus === 'blocked') {
			blocked = true;
			notes.push(`⛔ anexo "${a.name}" bloqueado pela moderação do Papo (não reenviado).`);
			continue;
		}
		// `pending`/`processing`: o Papo mostra e serve o arquivo enquanto a inferência
		// não termina. Reenviar mantém os dois lados iguais; se o veredito for `blocked`
		// o Papo apaga a mensagem e o bridge apaga a cópia junto.
		if (a.moderationStatus === 'sensitive') {
			notes.push(`⚠️ anexo "${a.name}" marcado como conteúdo sensível.`);
		}

		const data = await a.download();
		const name = sanitizeName(a.name);

		if (data.length <= limits.maxFileBytes) {
			flat.push({ name, data, mime: a.mime ?? undefined });
			continue;
		}

		// 1) compacta quando o conteúdo é texto/código
		if (isCompressibleMime(a.mime) || /\.(txt|md|csv|json|log|sql|ya?ml|xml)$/i.test(name)) {
			const gz = gzip(data);
			if (gz.length <= limits.maxFileBytes) {
				flat.push({ name: `${name}.gz`, data: gz, mime: 'application/gzip' });
				notes.push(`📦 "${name}" compactado (${formatBytes(data.length)} → ${formatBytes(gz.length)}).`);
				continue;
			}
			const tgz = tarGz([{ name, data }]);
			if (tgz.length <= limits.maxFileBytes) {
				flat.push({ name: `${name}.tar.gz`, data: tgz, mime: 'application/gzip' });
				notes.push(`📦 "${name}" empacotado em tar.gz (${formatBytes(tgz.length)}).`);
				continue;
			}
			const parts = partition(tgz, partTarget, name);
			for (const p of parts) flat.push({ name: p.name, data: p.data, mime: 'application/gzip', part: true });
			notes.push(
				`📦 "${name}" (${formatBytes(data.length)}) particionado em ${parts.length} partes: ` +
					`cat ${name}.part* > ${name}.tar.gz && tar xzf ${name}.tar.gz`
			);
			continue;
		}

		// 2) mídia já comprimida: não recomprimir → aviso + link direto
		if (a.directUrl) {
			notes.push(
				`📎 "${name}" (${formatBytes(data.length)}) excede o limite de ${formatBytes(limits.maxFileBytes)} ` +
					`do destino e não é recomprimível: ${a.directUrl}`
			);
		} else {
			notes.push(
				`📎 "${name}" (${formatBytes(data.length)}) excede o limite de ${formatBytes(limits.maxFileBytes)} do destino.`
			);
		}
	}

	const groups: PreparedAttachment[][] = [];
	for (let i = 0; i < flat.length; i += limits.maxFilesPerMessage) {
		groups.push(flat.slice(i, i + limits.maxFilesPerMessage));
	}
	return { groups, notes, blocked };
}

/** Anexos que podem virar preview de imagem no embed. */
export const firstImage = (files: PreparedAttachment[]): PreparedAttachment | undefined =>
	files.find((f) => (f.mime ?? '').startsWith('image/'));
