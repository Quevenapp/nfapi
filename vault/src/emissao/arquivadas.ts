// NFS-e que o cofre guarda só como arquivo, sem registro de emissão. Antes de o
// cofre ser a API de emissão (versão 0.2.0) a nota era emitida por fora e
// arquivada aqui; as primeiras nem traziam a série e o número nos metadados.
// O painel lista as emissões, então cada uma ganha o seu registro, com os
// dados lidos do próprio XML da nota.

import type { AppEnv } from "../app";
import { atributo, primeiro, raizDoXml, texto } from "../danfe/leitura";
import type { Ambiente } from "../fiscal/dados";
import * as store from "../store";
import * as banco from "./banco";

/** Até onde a conferência chegou: vazio, a última chave de arquivo vista, ou "fim". */
const ANDAMENTO = "notas_arquivadas_conferidas";
const FIM = "fim";

interface Arquivo {
	key: string;
	meta: string;
	created_at: number;
	cancelada: number;
}

const ambienteDe = (v: unknown): Ambiente | undefined => (v === "producao" || v === "homologacao" ? v : undefined);
const inteiro = (v: unknown) => (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)) ? Number(v) : Number.NaN);

/** O registro de emissão de uma NFS-e arquivada, ou null quando o arquivo não diz a série e o número. */
function emissaoDoArquivo(a: Arquivo, xml: string | null): banco.Emission | null {
	let meta: Record<string, unknown> = {};
	try {
		meta = JSON.parse(a.meta) as Record<string, unknown>;
	} catch {
		return null;
	}
	const chave = meta.chaveAcesso;
	if (typeof chave !== "string" || !/^\d{50}$/.test(chave)) return null;

	const raiz = xml ? raizDoXml(xml) : undefined;
	const dps = primeiro(raiz, "infDPS");
	const tpAmb = texto(dps, "tpAmb");
	const ambiente = ambienteDe(meta.ambiente) ?? ambienteDe(a.key.split("/")[1]) ?? (tpAmb === "1" ? "producao" : tpAmb === "2" ? "homologacao" : undefined);
	// A série vai sem zeros à esquerda, como o cofre a grava ao emitir.
	const serie = (texto(dps, "serie") ?? (meta.serie == null ? "" : String(meta.serie))).replace(/^0+(?=.)/, "");
	const numero = inteiro(texto(dps, "nDPS") ?? meta.numeroDps);
	if (!ambiente || !serie || !Number.isSafeInteger(numero) || numero < 1) return null;

	// Na chave: município (7), ambiente gerador (1), tipo de inscrição (1: CPF, 2: CNPJ) e inscrição (14).
	const docId = chave[8] === "1" ? chave.slice(12, 23) : chave.slice(9, 23);
	const valor = Number(texto(primeiro(dps, "vServPrest"), "vServ") ?? meta.valor);
	const toma = primeiro(dps, "toma");
	const numeroNfse = texto(primeiro(raiz, "infNFSe"), "nNFSe") ?? (meta.numeroNfse == null ? null : String(meta.numeroNfse));
	return {
		id: banco.newId("nfs"),
		docId,
		kind: "nfse",
		environment: ambiente,
		reference: null,
		serie,
		number: numero,
		documentId: atributo(dps, "Id") ?? `DPS${chave.slice(0, 7)}${chave.slice(8, 23)}${serie.padStart(5, "0")}${String(numero).padStart(15, "0")}`,
		status: a.cancelada ? "cancelada" : "autorizada",
		accessKey: chave,
		fiscalNumber: numeroNfse,
		messages: [],
		documentKey: a.key,
		journalKey: null,
		requestHash: null,
		protocol: null,
		extra: {},
		createdAt: a.created_at,
		updatedAt: a.created_at,
		issuedAt: (typeof meta.emitidaEm === "string" ? meta.emitidaEm : undefined) ?? texto(dps, "dhEmi") ?? null,
		value: Number.isFinite(valor) ? valor : null,
		recipientDoc: texto(toma, "CNPJ") ?? texto(toma, "CPF") ?? texto(toma, "NIF") ?? null,
		recipientName: texto(toma, "xNome") ?? null,
	};
}

/**
 * Registra as NFS-e arquivadas que ainda não têm emissão. Um punhado por
 * chamada; depois de conferir todas, não procura mais. Devolve quantas adotou.
 */
export async function adotarNotasArquivadas(env: AppEnv, limite = 25): Promise<number> {
	const andamento = (await store.getSetting(env.DB, ANDAMENTO)) ?? "";
	if (andamento === FIM) return 0;

	const { results } = await env.DB.prepare(
		`SELECT d.key, d.meta, d.created_at,
		 EXISTS (
			SELECT 1 FROM documents c
			WHERE c.key LIKE 'nfse/%' AND json_extract(c.meta, '$.tipo') = 'cancelamento'
			  AND json_extract(c.meta, '$.chaveAcesso') = json_extract(d.meta, '$.chaveAcesso')
		 ) AS cancelada
		 FROM documents d
		 WHERE d.key LIKE 'nfse/%' AND d.key > ?1 AND json_extract(d.meta, '$.tipo') = 'nfse'
		   AND NOT EXISTS (SELECT 1 FROM emissions e WHERE e.access_key = json_extract(d.meta, '$.chaveAcesso'))
		 ORDER BY d.key LIMIT ?2`,
	)
		.bind(andamento, limite)
		.all<Arquivo>();

	let adotadas = 0;
	let ultima = andamento;
	for (const a of results) {
		let xml: string | null;
		try {
			xml = (await (await store.getDocument(env.DOCS, a.key))?.text()) ?? null;
		} catch {
			// O arquivo não pôde ser lido agora: a conferência continua daqui na próxima chamada.
			if (ultima !== andamento) await store.setSetting(env.DB, ANDAMENTO, ultima);
			return adotadas;
		}
		const e = emissaoDoArquivo(a, xml);
		if (e && (await banco.adotarEmissao(env.DB, e))) {
			// A série passa a conhecer o número, para o cofre não repetir uma DPS.
			await banco.noteNumber(env.DB, { docId: e.docId, kind: "nfse", environment: e.environment, serie: e.serie }, e.number);
			adotadas++;
		}
		ultima = a.key;
	}
	await store.setSetting(env.DB, ANDAMENTO, results.length < limite ? FIM : ultima);
	return adotadas;
}
