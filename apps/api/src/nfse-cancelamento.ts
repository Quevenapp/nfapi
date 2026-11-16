// Cancelamento de NFS-e: registra o evento e101101 na SEFIN Nacional.
//
//   monta o pedido -> o cofre assina -> o cofre transmite -> o evento
//   registrado é arquivado no cofre, ao lado da nota.

import { NFSE_NACIONAL, nfseAmbiente } from "@nfapi/fiscal-data";
import {
	type CancelamentoInput,
	type Mensagem,
	type RespostaEvento,
	base64ParaTexto,
	comDeclaracaoXml,
	corpoEvento,
	lerRespostaEvento,
	montarPedidoCancelamento,
	textoParaBase64,
} from "@nfapi/nfse-nacional";
import { type VaultClient, VaultError } from "@nfapi/vault-client";
import type * as db from "./db";
import * as emissions from "./emissions";
import { VERSAO_APLICATIVO } from "./versao";

export type ResultadoCancelamento =
	| { ok: true; emission: emissions.Emission; jaCancelada: boolean }
	| { ok: false; status: 409 | 422 | 502; codigo: string; mensagem: string; mensagens: Mensagem[] };

const falha = (
	status: 409 | 422 | 502,
	codigo: string,
	mensagens: Mensagem[],
	mensagem = mensagens[0]?.descricao ?? "O cancelamento não foi registrado.",
): ResultadoCancelamento => ({ ok: false, status, codigo, mensagem, mensagens });

const doCofre = (err: VaultError): Mensagem => ({ codigo: err.code, descricao: err.message });

export async function cancelarNfse(
	d1: D1Database,
	vault: VaultClient,
	emitter: db.Emitter,
	emission: emissions.Emission,
	input: CancelamentoInput,
): Promise<ResultadoCancelamento> {
	// Repetir o pedido de uma nota já cancelada não é erro.
	if (emission.status === "cancelada") return { ok: true, emission, jaCancelada: true };
	if (emission.status !== "autorizada" || !emission.accessKey) {
		return falha(409, "nfse_nao_autorizada", [], "Só é possível cancelar uma NFS-e autorizada.");
	}

	const config = nfseAmbiente(emission.environment);
	const pedido = montarPedidoCancelamento(input, {
		ambiente: emission.environment,
		autor: { tipo: emitter.docKind, numero: emitter.docId },
		chaveAcesso: emission.accessKey,
		versaoAplicativo: VERSAO_APLICATIVO,
	});

	let assinado: string;
	try {
		const out = await vault.sign({ xml: pedido.xml, tag: "infPedReg", profile: NFSE_NACIONAL.assinatura });
		assinado = comDeclaracaoXml(out.xml);
	} catch (err) {
		if (!(err instanceof VaultError)) throw err;
		return falha(err.status === 0 || err.status >= 500 ? 502 : 422, err.code, [doCofre(err)]);
	}

	let resposta: RespostaEvento;
	let journalKey: string | undefined;
	try {
		const res = await vault.transmit({
			url: `${config.sefin}/nfse/${emission.accessKey}/eventos`,
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			bodyB64: textoParaBase64(await corpoEvento(assinado)),
			timeoutMs: 60_000,
			ref: `${emission.id}:cancelamento`,
		});
		journalKey = res.journalKey;
		resposta = await lerRespostaEvento(res.status, base64ParaTexto(res.bodyB64));
	} catch (err) {
		if (!(err instanceof VaultError)) throw err;
		return falha(502, "sem_resposta_conclusiva", [doCofre(err)]);
	}

	if (resposta.tipo === "rejeitada") return falha(422, "cancelamento_rejeitado", resposta.rejeicoes);
	if (resposta.tipo === "indefinida") {
		return falha(502, "sem_resposta_conclusiva", [
			{ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe },
		]);
	}

	// Registrado: o evento vai para o cofre, ao lado do XML da nota.
	const mensagens: Mensagem[] = [];
	const chave = emission.accessKey;
	const destino = emission.documentKey
		? emission.documentKey.replace(/-nfse\.xml$/, "-cancelamento.xml")
		: `nfse/${emission.environment}/eventos/${chave}-cancelamento.xml`;
	try {
		await vault.putDocument(destino, resposta.xml, {
			contentType: "application/xml",
			meta: {
				tipo: "cancelamento",
				chaveAcesso: chave,
				emissao: emission.id,
				motivo: input.motivo,
				canceladaEm: new Date().toISOString(),
				diario: journalKey ?? null,
			},
		});
	} catch (err) {
		if (!(err instanceof VaultError)) throw err;
		mensagens.push({
			codigo: "arquivo_pendente",
			descricao: `Cancelamento registrado, mas o evento não pôde ser arquivado no cofre: ${err.message}`,
		});
	}

	const atual = await emissions.updateEmission(d1, emission.id, { status: "cancelada", messages: mensagens });
	return { ok: true, emission: atual, jaCancelada: false };
}
