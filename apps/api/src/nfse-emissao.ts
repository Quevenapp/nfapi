// Núcleo da emissão de NFS-e, independente de HTTP: é o mesmo fluxo para a rota
// POST /v1/nfse e para os testes de homologação do admin.
//
//   reserva o número -> monta a DPS -> o cofre assina -> o cofre transmite à
//   SEFIN Nacional -> a NFS-e autorizada é gravada no cofre.

import { type Ambiente, NFSE_NACIONAL, nfseAmbiente } from "@nfapi/fiscal-data";
import {
	type Mensagem,
	type NfseInput,
	type RespostaEmissao,
	base64ParaTexto,
	comDeclaracaoXml,
	corpoEmissao,
	lerRespostaEmissao,
	montarDps,
	textoParaBase64,
} from "@nfapi/nfse-nacional";
import { type VaultClient, VaultError } from "@nfapi/vault-client";
import { iso } from "./comum";
import { newId } from "./crypto";
import type * as db from "./db";
import * as emissions from "./emissions";
import { VERSAO_APLICATIVO } from "./versao";

export type ResultadoEmissao =
	/** `nova` é falso quando a referência já tinha uma nota e nada foi reenviado. */
	| { tipo: "autorizada"; nova: boolean; emission: emissions.Emission }
	| { tipo: "conflito"; codigo: string; mensagem: string }
	| {
			tipo: "nao_autorizada";
			/** 422: recusada ou barrada antes de transmitir. 502: sem resposta conclusiva. */
			status: 422 | 502;
			codigo: string;
			mensagem: string;
			emission: emissions.Emission;
	  };

export interface PedidoEmissao {
	accountId: string;
	emitter: db.Emitter;
	ambiente: Ambiente;
	referencia?: string;
	pedido: NfseInput;
}

/** Erros do cofre em que nada chegou a sair para o governo. */
const NAO_TRANSMITIDO = new Set([
	"host_nao_permitido",
	"requisicao_invalida",
	"certificado_ausente",
	"certificado_vencido",
	"certificado_do_cliente_invalido",
	"nao_autenticado",
]);

const mensagemDoCofre = (err: VaultError): Mensagem => ({ codigo: err.code, descricao: err.message });

async function consultar(vault: VaultClient, url: string, ref: string) {
	const res = await vault.transmit({ url, method: "GET", headers: { accept: "application/json" }, ref });
	return { status: res.status, corpo: base64ParaTexto(res.bodyB64) };
}

/**
 * Descobre se uma DPS já virou NFS-e (usado ao retomar uma emissão sem
 * resposta conclusiva). Devolve null quando a SEFIN não conhece a DPS.
 */
async function recuperar(
	vault: VaultClient,
	sefin: string,
	dpsId: string,
	ref: string,
): Promise<RespostaEmissao | null> {
	const dps = await consultar(vault, `${sefin}/dps/${dpsId}`, ref);
	if (dps.status === 404) return null;
	let chave: unknown;
	try {
		chave = (JSON.parse(dps.corpo) as { chaveAcesso?: unknown }).chaveAcesso;
	} catch {
		chave = undefined;
	}
	if (dps.status !== 200 || typeof chave !== "string") {
		return { tipo: "indefinida", detalhe: `Consulta da DPS respondeu HTTP ${dps.status}.` };
	}
	const nfse = await consultar(vault, `${sefin}/nfse/${chave}`, ref);
	const lida = await lerRespostaEmissao(nfse.status, nfse.corpo);
	return lida.tipo === "autorizada"
		? lida
		: { tipo: "indefinida", detalhe: `A DPS gerou a NFS-e ${chave}, mas a consulta do XML falhou.` };
}

export async function emitirNfse(
	d1: D1Database,
	vault: VaultClient,
	{ accountId, emitter, ambiente, referencia, pedido }: PedidoEmissao,
): Promise<ResultadoEmissao> {
	const config = nfseAmbiente(ambiente);
	const serieKey = {
		accountId,
		docId: emitter.docId,
		kind: "nfse" as const,
		environment: ambiente,
		serie: pedido.serie,
	};

	// ----- Idempotência -----
	let emission = referencia ? await emissions.findByReference(d1, serieKey, referencia) : null;
	if (emission?.status === "autorizada") return { tipo: "autorizada", nova: false, emission };
	if (emission?.status === "processando") {
		return {
			tipo: "conflito",
			codigo: "emissao_em_andamento",
			mensagem: "Já existe uma emissão em andamento para esta referência.",
		};
	}

	const naoAutorizada = async (
		status: 422 | 502,
		situacao: "rejeitada" | "erro" | "indefinida",
		codigo: string,
		mensagens: Mensagem[],
		journalKey?: string,
	): Promise<ResultadoEmissao> => {
		const atual = await emissions.updateEmission(d1, (emission as emissions.Emission).id, {
			status: situacao,
			messages: mensagens,
			...(journalKey ? { journalKey } : {}),
		});
		return {
			tipo: "nao_autorizada",
			status,
			codigo,
			mensagem: mensagens[0]?.descricao ?? "A NFS-e não foi autorizada.",
			emission: atual,
		};
	};
	const semResposta = (detalhe: Mensagem, journalKey?: string) =>
		naoAutorizada(502, "indefinida", "sem_resposta_conclusiva", [detalhe], journalKey);

	let resposta: RespostaEmissao | null = null;
	let journalKey: string | undefined;
	let dpsAssinada: string | undefined;

	try {
		// ----- Retomada: a tentativa anterior pode ter gerado a nota -----
		if (emission?.status === "indefinida") {
			resposta = await recuperar(vault, config.sefin, emission.documentId, emission.id);
			if (resposta?.tipo === "indefinida") {
				return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe });
			}
		}

		if (!resposta) {
			// ----- Número e DPS -----
			const numero = emission?.number ?? pedido.numero ?? (await emissions.nextNumber(d1, serieKey));
			if (pedido.numero) await emissions.noteNumber(d1, serieKey, pedido.numero);
			const dps = montarDps(pedido, {
				ambiente,
				leiaute: config.leiaute,
				emitente: { tipo: emitter.docKind, numero: emitter.docId },
				numero,
				versaoAplicativo: VERSAO_APLICATIVO,
			});

			if (emission) {
				emission = await emissions.updateEmission(d1, emission.id, {
					status: "processando",
					documentId: dps.id,
					emitterId: emitter.id,
					messages: [],
				});
			} else {
				const now = Date.now();
				emission = {
					id: newId("nfs"),
					accountId,
					emitterId: emitter.id,
					docId: emitter.docId,
					kind: "nfse",
					environment: ambiente,
					reference: referencia ?? null,
					serie: pedido.serie,
					number: numero,
					documentId: dps.id,
					status: "processando",
					accessKey: null,
					fiscalNumber: null,
					messages: [],
					documentKey: null,
					journalKey: null,
					createdAt: now,
					updatedAt: now,
				};
				if (!(await emissions.insertEmission(d1, emission))) {
					return {
						tipo: "conflito",
						codigo: "numero_ja_utilizado",
						mensagem: `A DPS ${numero} da série ${pedido.serie} já foi usada (ou a referência acabou de ser registrada).`,
					};
				}
			}

			// ----- Assinar (no cofre) -----
			try {
				const assinada = await vault.sign({ xml: dps.xml, tag: "infDPS", profile: NFSE_NACIONAL.assinatura });
				// O documento transmitido e o arquivado são o mesmo, já com a declaração XML.
				dpsAssinada = comDeclaracaoXml(assinada.xml);
			} catch (err) {
				if (!(err instanceof VaultError)) throw err;
				const cofreFora = err.status === 0 || err.status >= 500;
				return await naoAutorizada(cofreFora ? 502 : 422, "erro", err.code, [mensagemDoCofre(err)]);
			}

			// ----- Transmitir (pelo cofre) -----
			try {
				const res = await vault.transmit({
					url: `${config.sefin}/nfse`,
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					bodyB64: textoParaBase64(await corpoEmissao(dpsAssinada)),
					timeoutMs: 60_000,
					ref: emission.id,
				});
				journalKey = res.journalKey;
				resposta = await lerRespostaEmissao(res.status, base64ParaTexto(res.bodyB64));
			} catch (err) {
				if (!(err instanceof VaultError)) throw err;
				return NAO_TRANSMITIDO.has(err.code)
					? await naoAutorizada(422, "erro", err.code, [mensagemDoCofre(err)])
					: await semResposta(mensagemDoCofre(err));
			}
		}
	} catch (err) {
		// Falha do cofre durante a retomada.
		if (!(err instanceof VaultError) || !emission) throw err;
		return await semResposta(mensagemDoCofre(err));
	}

	if (!emission) throw new Error("emissão sem registro");
	if (resposta.tipo === "rejeitada") {
		return await naoAutorizada(422, "rejeitada", "nfse_rejeitada", resposta.rejeicoes, journalKey);
	}
	if (resposta.tipo === "indefinida") {
		return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe }, journalKey);
	}

	// ----- Autorizada: arquivar no cofre do emitente -----
	const dia = iso(emission.createdAt);
	const base = `nfse/${ambiente}/${dia.slice(0, 4)}/${dia.slice(5, 7)}/${resposta.chaveAcesso}`;
	const mensagens = [...resposta.alertas];
	let documentKey: string | null = null;
	try {
		const meta = { tipo: "nfse", chaveAcesso: resposta.chaveAcesso, emissao: emission.id };
		await vault.putDocument(`${base}-nfse.xml`, resposta.xml, { contentType: "application/xml", meta });
		documentKey = `${base}-nfse.xml`;
		if (dpsAssinada) {
			await vault.putDocument(`${base}-dps.xml`, dpsAssinada, {
				contentType: "application/xml",
				meta: { ...meta, tipo: "dps" },
			});
		}
	} catch (err) {
		if (!(err instanceof VaultError)) throw err;
		// A nota está autorizada e a resposta completa está no diário do cofre.
		mensagens.push({
			codigo: "arquivo_pendente",
			descricao: `NFS-e autorizada, mas o XML não pôde ser arquivado no cofre: ${err.message}`,
		});
	}

	const final = await emissions.updateEmission(d1, emission.id, {
		status: "autorizada",
		accessKey: resposta.chaveAcesso,
		fiscalNumber: resposta.numeroNfse,
		messages: mensagens,
		documentKey,
		...(journalKey ? { journalKey } : {}),
	});
	return { tipo: "autorizada", nova: true, emission: final };
}
