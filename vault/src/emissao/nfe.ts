// Emissão, consulta, cancelamento, carta de correção e inutilização de NF-e
// (modelo 55) e NFC-e (modelo 65), rodando no cofre.
//
//   emitir: reserva o número na série -> monta o XML -> assina -> guarda a nota
//           assinada -> transmite (lote síncrono) -> arquiva a nota autorizada
//           junto com o protocolo (nfeProc).
//
// A nota assinada é guardada antes de transmitir: se a resposta se perder, a
// retomada consulta a SEFAZ pela chave e fecha o arquivo sem emitir de novo.

import { type Ambiente, type Autorizador, autorizadorNfe, temInutilizacao } from "../fiscal/dados";
import type { Mensagem } from "../nfse";
import { base64ParaTexto } from "../nfse";
import { CODIGO_UF, type Modelo, gerarCodigoNumerico } from "../nfe/chave";
import { montarCancelamentoNfe, montarCartaCorrecao, montarInutilizacao } from "../nfe/eventos";
import { suplementoNfce } from "../nfe/qrcode";
import type { CancelamentoNfe, CartaCorrecao, InutilizacaoInput, PedidoNfe } from "../nfe/schema";
import {
	type RespostaAutorizacao,
	type Servico,
	consReciNFe,
	consSitNFe,
	consStatServ,
	envEvento,
	enviNFe,
	lerRespostaAutorizacao,
	lerRespostaConsulta,
	lerRespostaEventoNfe,
	lerRespostaInutilizacao,
	lerStatusServico,
	nfeProc,
	procEventoNFe,
	procInutNFe,
	requisicaoSoap,
} from "../nfe/sefaz";
import { comSuplementoNfce, montarNfe } from "../nfe/xml";
import { OperacaoError, type Operacoes } from "../operacoes";
import { VAULT_VERSION } from "../protocol";
import * as banco from "./banco";

const VERSAO_APLICATIVO = `NFapi-${VAULT_VERSION}`;

/** Ajustes de tempo; os testes zeram a espera. */
export const ajustes = { esperaReciboMs: 1500, tentativasRecibo: 3 };

export const KIND: Record<Modelo, "nfe" | "nfce"> = { "55": "nfe", "65": "nfce" };
export const MODELO: Record<"nfe" | "nfce", Modelo> = { nfe: "55", nfce: "65" };
const NOME = { nfe: "NF-e", nfce: "NFC-e" } as const;

/** Erros em que nada chegou a sair para o governo. */
const NAO_TRANSMITIDO = new Set(["host_nao_permitido", "requisicao_invalida", "certificado_do_cliente_invalido"]);
/**
 * Rejeições em que o número existe para a SEFAZ (duplicidade, faixa
 * inutilizada): ele não volta para a série.
 */
const NUMERO_OCUPADO = new Set(["204", "206", "218", "256", "539"]);

const doErro = (err: OperacaoError): Mensagem => ({ codigo: err.code, descricao: err.message });
const tpAmb = (ambiente: Ambiente) => (ambiente === "homologacao" ? "2" : "1");
const idLote = () => String(Date.now());

export type ResultadoNfe =
	| { tipo: "autorizada"; nova: boolean; emission: banco.Emission }
	| { tipo: "conflito"; status: 409 | 422; codigo: string; mensagem: string }
	| { tipo: "nao_autorizada"; status: 422 | 502; codigo: string; mensagem: string; emission: banco.Emission };

const conflito = (codigo: string, mensagem: string, status: 409 | 422 = 409): ResultadoNfe => ({ tipo: "conflito", status, codigo, mensagem });

async function chamar(ops: Operacoes, autorizador: Autorizador, servico: Servico, dados: string, ref: string) {
	const res = await ops.transmit(requisicaoSoap(servico, autorizador.servicos[servico], dados, ref));
	return { status: res.status, corpo: base64ParaTexto(res.bodyB64), journalKey: res.journalKey };
}

/** CNPJ do emitente: o do certificado, ou o de uma filial de mesma raiz. */
function cnpjEmitente(ops: Operacoes, informado: string | undefined): string | null {
	if (ops.holder.kind !== "cnpj") return null;
	if (!informado) return ops.holder.id;
	return informado.slice(0, 8) === ops.holder.id.slice(0, 8) ? informado : null;
}

/** Reserva o próximo número livre da série, pulando faixas inutilizadas. */
async function reservarNumero(d1: D1Database, k: banco.SerieKey): Promise<number | null> {
	for (;;) {
		const numero = await banco.nextNumberCadastrada(d1, k);
		if (numero === null) return null;
		const fim = await banco.fimDaFaixaInutilizada(d1, k, numero);
		if (fim === null) return numero;
		await banco.avancarSerie(d1, k, fim);
	}
}

const pasta = (kind: string, ambiente: Ambiente, criadaEm: number) => {
	const dia = new Date(criadaEm).toISOString();
	return `${kind}/${ambiente}/${dia.slice(0, 4)}/${dia.slice(5, 7)}`;
};

/** Arquiva a nota autorizada (ou denegada) com o protocolo e descarta a cópia de trabalho. */
async function arquivar(
	d1: D1Database,
	ops: Operacoes,
	emission: banco.Emission,
	nfeAssinada: string,
	r: Extract<RespostaAutorizacao, { tipo: "autorizada" | "denegada" }>,
	journalKey?: string,
): Promise<banco.Emission> {
	const chave = emission.accessKey as string;
	const destino = `${pasta(emission.kind, emission.environment, emission.createdAt)}/${chave}-nfe.xml`;
	const autorizada = r.tipo === "autorizada";
	await ops.putDocument(destino, nfeProc(nfeAssinada, r.protNFe), {
		contentType: "application/xml",
		meta: {
			tipo: emission.kind,
			chaveAcesso: chave,
			emissao: emission.id,
			ambiente: emission.environment,
			serie: emission.serie,
			numero: emission.number,
			valor: emission.extra.valor ?? null,
			protocolo: autorizada ? r.protocolo : null,
			situacao: autorizada ? "autorizada" : "denegada",
			emitidaEm: new Date().toISOString(),
		},
	});
	const pendente = emission.extra.pendente;
	if (typeof pendente === "string") await ops.removeDocument(pendente).catch(() => undefined);
	const { pendente: _descartado, ...extra } = emission.extra;
	return banco.updateEmission(d1, emission.id, {
		status: autorizada ? "autorizada" : "denegada",
		protocol: autorizada ? r.protocolo : null,
		fiscalNumber: String(emission.number),
		messages: [r.mensagem],
		documentKey: destino,
		extra,
		...(journalKey ? { journalKey } : {}),
	});
}

type Retomada =
	| { tipo: "resolvida"; emission: banco.Emission }
	/** A SEFAZ não conhece a nota: a tentativa anterior não valeu e pode ser refeita. */
	| { tipo: "nao_consta"; emission: banco.Emission }
	| { tipo: "indefinida"; detalhe: string };

/** Descobre, pela chave, o que aconteceu com uma emissão que ficou sem resposta. */
async function retomar(d1: D1Database, ops: Operacoes, autorizador: Autorizador, emission: banco.Emission): Promise<Retomada> {
	const chave = emission.accessKey as string;
	const { status, corpo } = await chamar(ops, autorizador, "consulta", consSitNFe(tpAmb(emission.environment), chave), `${emission.id}:consulta`);
	const r = lerRespostaConsulta(status, corpo, chave);
	if (r.tipo === "indefinida") return r;
	if (r.tipo === "nao_consta") {
		const serieKey = { docId: emission.docId, kind: emission.kind, environment: emission.environment, serie: emission.serie };
		const atual = await banco.updateEmission(d1, emission.id, { status: "rejeitada", messages: [r.mensagem] });
		await banco.devolverNumero(d1, serieKey, emission.number);
		return { tipo: "nao_consta", emission: atual };
	}
	const pendente = typeof emission.extra.pendente === "string" ? await ops.getDocument(emission.extra.pendente) : null;
	if (r.tipo === "cancelada") {
		const arquivada = pendente && r.protNFe
			? await arquivar(d1, ops, emission, pendente, { tipo: "autorizada", protocolo: r.protocolo ?? "", recebidaEm: null, mensagem: r.mensagem, protNFe: r.protNFe })
			: emission;
		return { tipo: "resolvida", emission: await banco.updateEmission(d1, arquivada.id, { status: "cancelada", messages: [r.mensagem] }) };
	}
	if (!pendente) {
		return { tipo: "indefinida", detalhe: "A nota consta na SEFAZ, mas a cópia assinada não está mais no cofre. Baixe o XML pela chave de acesso." };
	}
	return { tipo: "resolvida", emission: await arquivar(d1, ops, emission, pendente, r) };
}

export async function emitirNfe(
	d1: D1Database,
	ops: Operacoes,
	{ ambiente, referencia, pedido }: { ambiente: Ambiente; referencia?: string; pedido: PedidoNfe },
): Promise<ResultadoNfe> {
	const kind = KIND[pedido.modelo];
	const nome = NOME[kind];
	const cnpj = cnpjEmitente(ops, pedido.emitente.cnpj);
	if (!cnpj) return conflito("emitente_divergente", "O emitente precisa ser o titular do certificado (CNPJ) ou uma filial de mesma raiz.", 422);
	const uf = pedido.emitente.endereco.uf;
	const autorizador = autorizadorNfe(pedido.modelo, uf, ambiente);
	if (!autorizador) return conflito("uf_nao_suportada", `A emissão de ${nome} para a UF ${uf} ainda não está disponível neste cofre.`, 422);

	const base = { docId: cnpj, kind, environment: ambiente };
	const hash = await banco.hashPedido(pedido);

	// ----- Idempotência -----
	let emission = referencia ? await banco.findByReference(d1, base, referencia) : null;
	if (emission?.requestHash && emission.requestHash !== hash && emission.status !== "rejeitada" && emission.status !== "erro") {
		return conflito(banco.REFERENCIA_DIVERGENTE.codigo, banco.REFERENCIA_DIVERGENTE.mensagem);
	}
	if (emission?.status === "autorizada" || emission?.status === "cancelada") return { tipo: "autorizada", nova: false, emission };
	if (emission?.status === "denegada") {
		return { tipo: "nao_autorizada", status: 422, codigo: "nfe_denegada", mensagem: emission.messages[0]?.descricao ?? "Uso denegado.", emission };
	}
	if (emission?.status === "processando") return conflito("emissao_em_andamento", "Já existe uma emissão em andamento para esta referência.");

	const encerrar = async (
		status: 422 | 502,
		situacao: "rejeitada" | "erro" | "indefinida",
		codigo: string,
		mensagens: Mensagem[],
		opcoes: { journalKey?: string; devolver?: boolean } = {},
	): Promise<ResultadoNfe> => {
		const e = emission as banco.Emission;
		const atual = await banco.updateEmission(d1, e.id, { status: situacao, messages: mensagens, ...(opcoes.journalKey ? { journalKey: opcoes.journalKey } : {}) });
		if (opcoes.devolver) await banco.devolverNumero(d1, { ...base, serie: e.serie }, e.number);
		return { tipo: "nao_autorizada", status, codigo, mensagem: mensagens[0]?.descricao ?? `A ${nome} não foi autorizada.`, emission: atual };
	};
	const semResposta = (detalhe: Mensagem, journalKey?: string) => encerrar(502, "indefinida", "sem_resposta_conclusiva", [detalhe], { journalKey });

	try {
		// ----- Retomada: a tentativa anterior pode ter sido autorizada -----
		if (emission?.status === "indefinida") {
			const r = await retomar(d1, ops, autorizador, emission);
			if (r.tipo === "resolvida") return { tipo: "autorizada", nova: true, emission: r.emission };
			if (r.tipo === "indefinida") return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: r.detalhe });
			emission = r.emission;
		}

		// ----- Série e número -----
		const cadastradas = (await banco.listSeries(d1, cnpj)).filter((s) => s.kind === kind && s.environment === ambiente);
		const serie = pedido.serie ?? (cadastradas.length === 1 ? Number(cadastradas[0]?.serie) : undefined);
		if (serie === undefined) {
			return conflito(
				cadastradas.length === 0 ? "serie_nao_cadastrada" : "serie_obrigatoria",
				cadastradas.length === 0
					? `Nenhuma série de ${nome} cadastrada para ${ambiente}. Cadastre a série na tela do cofre.`
					: `Há mais de uma série de ${nome} cadastrada: informe "serie" no pedido.`,
				422,
			);
		}
		const serieKey = { ...base, serie: String(serie) };
		const numero = await reservarNumero(d1, serieKey);
		if (numero === null) {
			return conflito("serie_nao_cadastrada", `A série ${serie} de ${nome} não está cadastrada para ${ambiente}. Cadastre-a na tela do cofre.`, 422);
		}

		// ----- XML -----
		const montada = montarNfe(pedido, { ambiente, cnpj, serie, numero, cNF: gerarCodigoNumerico(numero), versaoAplicativo: VERSAO_APLICATIVO });
		let xml = montada.xml;
		const extra: Record<string, unknown> = { valor: montada.total, uf };
		if (kind === "nfce" && autorizador.nfce) {
			const supl = suplementoNfce(montada.chave, ambiente, autorizador.nfce);
			xml = comSuplementoNfce(xml, supl.qrCode, supl.urlChave);
			extra.qrCode = supl.qrCode;
			extra.urlConsulta = supl.urlChave;
		}

		if (emission) {
			emission = await banco.updateEmission(d1, emission.id, {
				status: "processando", number: numero, accessKey: montada.chave, documentId: `NFe${montada.chave}`,
				messages: [], requestHash: hash, extra,
			});
		} else {
			const now = Date.now();
			emission = {
				id: banco.newId(kind === "nfe" ? "nfe" : "nfc"), docId: cnpj, kind, environment: ambiente, reference: referencia ?? null,
				serie: String(serie), number: numero, documentId: `NFe${montada.chave}`, status: "processando", accessKey: montada.chave,
				fiscalNumber: null, messages: [], documentKey: null, journalKey: null, requestHash: hash, protocol: null, extra,
				createdAt: now, updatedAt: now,
			};
			if (!(await banco.insertEmission(d1, emission))) {
				await banco.devolverNumero(d1, serieKey, numero);
				return conflito("emissao_em_andamento", "A referência acabou de ser registrada por outro pedido.");
			}
			await banco.updateEmission(d1, emission.id, { accessKey: montada.chave });
		}

		// ----- Assinar e guardar a cópia de trabalho -----
		let assinada: string;
		try {
			assinada = (await ops.sign({ xml, tag: "infNFe", profile: "rsa-sha1" })).xml;
		} catch (err) {
			if (!(err instanceof OperacaoError)) throw err;
			return await encerrar(422, "erro", err.code, [doErro(err)], { devolver: true });
		}
		const pendente = `${pasta(kind, ambiente, emission.createdAt)}/${montada.chave}-enviada.xml`;
		await ops.putDocument(pendente, assinada, { contentType: "application/xml", meta: { tipo: "enviada", emissao: emission.id } });
		emission = await banco.updateEmission(d1, emission.id, { extra: { ...extra, pendente } });

		// ----- Transmitir -----
		let resposta: RespostaAutorizacao;
		let journalKey: string | undefined;
		try {
			const res = await chamar(ops, autorizador, "autorizacao", enviNFe(assinada, idLote()), emission.id);
			journalKey = res.journalKey;
			resposta = lerRespostaAutorizacao(res.status, res.corpo, montada.chave);
			for (let i = 0; resposta.tipo === "em_processamento" && i < ajustes.tentativasRecibo; i++) {
				await new Promise((resolve) => setTimeout(resolve, ajustes.esperaReciboMs));
				const ret = await chamar(ops, autorizador, "retAutorizacao", consReciNFe(tpAmb(ambiente), resposta.recibo), `${emission.id}:recibo`);
				resposta = lerRespostaAutorizacao(ret.status, ret.corpo, montada.chave);
			}
		} catch (err) {
			if (!(err instanceof OperacaoError)) throw err;
			return NAO_TRANSMITIDO.has(err.code)
				? await encerrar(422, "erro", err.code, [doErro(err)], { devolver: true })
				: await semResposta(doErro(err));
		}

		if (resposta.tipo === "autorizada") {
			return { tipo: "autorizada", nova: true, emission: await arquivar(d1, ops, emission, assinada, resposta, journalKey) };
		}
		if (resposta.tipo === "denegada") {
			const negada = await arquivar(d1, ops, emission, assinada, resposta, journalKey);
			return { tipo: "nao_autorizada", status: 422, codigo: "nfe_denegada", mensagem: resposta.mensagem.descricao, emission: negada };
		}
		if (resposta.tipo === "rejeitada") {
			// 204: esta mesma chave já foi autorizada (uma resposta anterior se perdeu).
			if (resposta.mensagem.codigo === "204") {
				const r = await retomar(d1, ops, autorizador, emission);
				if (r.tipo === "resolvida") return { tipo: "autorizada", nova: true, emission: r.emission };
			}
			await ops.removeDocument(pendente).catch(() => undefined);
			return await encerrar(422, "rejeitada", "nfe_rejeitada", [resposta.mensagem], {
				journalKey,
				devolver: !NUMERO_OCUPADO.has(resposta.mensagem.codigo),
			});
		}
		const detalhe = resposta.tipo === "em_processamento" ? "A SEFAZ recebeu o lote, mas ainda não o processou. Repita o pedido com a mesma referência." : resposta.detalhe;
		return await semResposta({ codigo: "sem_resposta_conclusiva", descricao: detalhe }, journalKey);
	} catch (err) {
		// Falha de transporte durante a retomada.
		if (!(err instanceof OperacaoError) || !emission) throw err;
		return await semResposta(doErro(err));
	}
}

/** Consulta a SEFAZ para fechar uma emissão que ficou sem resposta conclusiva. */
export async function sincronizarNfe(d1: D1Database, ops: Operacoes, emission: banco.Emission): Promise<banco.Emission> {
	if (emission.status !== "indefinida" || !emission.accessKey) return emission;
	const autorizador = autorizadorNfe(MODELO[emission.kind as "nfe" | "nfce"], String(emission.extra.uf ?? ""), emission.environment);
	if (!autorizador) return emission;
	try {
		const r = await retomar(d1, ops, autorizador, emission);
		return r.tipo === "indefinida" ? emission : r.emission;
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return emission;
	}
}

export type ResultadoEvento =
	| { ok: true; emission: banco.Emission; repetido: boolean }
	| { ok: false; status: 409 | 422 | 502; codigo: string; mensagem: string; mensagens: Mensagem[] };

const falha = (status: 409 | 422 | 502, codigo: string, mensagens: Mensagem[], mensagem = mensagens[0]?.descricao ?? "O evento não foi registrado."): ResultadoEvento => ({
	ok: false, status, codigo, mensagem, mensagens,
});

async function registrarEvento(ops: Operacoes, emission: banco.Emission, evento: { xml: string }, ref: string) {
	const autorizador = autorizadorNfe(MODELO[emission.kind as "nfe" | "nfce"], String(emission.extra.uf ?? ""), emission.environment);
	if (!autorizador) return { erro: falha(422, "uf_nao_suportada", [], "UF sem autorizador configurado neste cofre.") };
	try {
		const assinado = (await ops.sign({ xml: evento.xml, tag: "infEvento", profile: "rsa-sha1" })).xml;
		const res = await chamar(ops, autorizador, "evento", envEvento(assinado, idLote()), ref);
		return { assinado, resposta: lerRespostaEventoNfe(res.status, res.corpo), journalKey: res.journalKey };
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return {
			erro: err.status === 422 || NAO_TRANSMITIDO.has(err.code) ? falha(422, err.code, [doErro(err)]) : falha(502, "sem_resposta_conclusiva", [doErro(err)]),
		};
	}
}

export async function cancelarNfe(d1: D1Database, ops: Operacoes, emission: banco.Emission, input: CancelamentoNfe): Promise<ResultadoEvento> {
	if (emission.status === "cancelada") return { ok: true, emission, repetido: true };
	if (emission.status !== "autorizada" || !emission.accessKey || !emission.protocol) {
		return falha(409, "nfe_nao_autorizada", [], "Só é possível cancelar uma nota autorizada.");
	}
	const evento = montarCancelamentoNfe({ ambiente: emission.environment, cnpj: emission.docId, chave: emission.accessKey }, emission.protocol, input.justificativa);
	const r = await registrarEvento(ops, emission, evento, `${emission.id}:cancelamento`);
	if (r.erro) return r.erro;
	if (r.resposta.tipo === "rejeitado") return falha(422, "cancelamento_rejeitado", [r.resposta.mensagem]);
	if (r.resposta.tipo === "indefinida") return falha(502, "sem_resposta_conclusiva", [{ codigo: "sem_resposta_conclusiva", descricao: r.resposta.detalhe }]);
	if (r.resposta.tipo === "registrado" && emission.documentKey) {
		await ops.putDocument(emission.documentKey.replace(/-nfe\.xml$/, "-cancelamento.xml"), procEventoNFe(r.assinado, r.resposta.retEvento), {
			contentType: "application/xml",
			meta: { tipo: "cancelamento", chaveAcesso: emission.accessKey, emissao: emission.id, protocolo: r.resposta.protocolo, canceladaEm: new Date().toISOString(), diario: r.journalKey ?? null },
		});
	}
	return { ok: true, emission: await banco.updateEmission(d1, emission.id, { status: "cancelada", messages: [r.resposta.mensagem] }), repetido: false };
}

export async function corrigirNfe(d1: D1Database, ops: Operacoes, emission: banco.Emission, input: CartaCorrecao): Promise<ResultadoEvento> {
	if (emission.kind !== "nfe") return falha(422, "carta_nao_se_aplica", [], "A carta de correção existe só para a NF-e (modelo 55).");
	if (emission.status !== "autorizada" || !emission.accessKey) return falha(409, "nfe_nao_autorizada", [], "Só é possível corrigir uma nota autorizada.");
	const sequencia = (typeof emission.extra.cartas === "number" ? emission.extra.cartas : 0) + 1;
	if (sequencia > 20) return falha(422, "limite_de_cartas", [], "A nota já tem o máximo de 20 cartas de correção.");
	const evento = montarCartaCorrecao({ ambiente: emission.environment, cnpj: emission.docId, chave: emission.accessKey }, sequencia, input.correcao);
	const r = await registrarEvento(ops, emission, evento, `${emission.id}:cce:${sequencia}`);
	if (r.erro) return r.erro;
	if (r.resposta.tipo === "rejeitado") return falha(422, "carta_rejeitada", [r.resposta.mensagem]);
	if (r.resposta.tipo === "indefinida") return falha(502, "sem_resposta_conclusiva", [{ codigo: "sem_resposta_conclusiva", descricao: r.resposta.detalhe }]);
	if (r.resposta.tipo === "registrado" && emission.documentKey) {
		await ops.putDocument(emission.documentKey.replace(/-nfe\.xml$/, `-cce-${String(sequencia).padStart(2, "0")}.xml`), procEventoNFe(r.assinado, r.resposta.retEvento), {
			contentType: "application/xml",
			meta: { tipo: "carta_correcao", chaveAcesso: emission.accessKey, emissao: emission.id, sequencia, protocolo: r.resposta.protocolo, diario: r.journalKey ?? null },
		});
	}
	// Com 573 (duplicidade) a sequência já existe na SEFAZ: o contador avança do mesmo jeito.
	const atual = await banco.updateEmission(d1, emission.id, { extra: { ...emission.extra, cartas: sequencia } });
	return { ok: true, emission: atual, repetido: r.resposta.tipo === "duplicado" };
}

export type ResultadoInutilizacao =
	| { ok: true; inutilizacao: banco.Inutilizacao }
	| { ok: false; status: 409 | 422 | 502; codigo: string; mensagem: string; mensagens: Mensagem[] };

export async function inutilizarNumeracao(d1: D1Database, ops: Operacoes, input: InutilizacaoInput): Promise<ResultadoInutilizacao> {
	const recusar = (status: 409 | 422 | 502, codigo: string, mensagem: string, mensagens: Mensagem[] = []): ResultadoInutilizacao => ({ ok: false, status, codigo, mensagem, mensagens });
	const cnpj = cnpjEmitente(ops, input.cnpj);
	if (!cnpj) return recusar(422, "emitente_divergente", "O emitente precisa ser o titular do certificado (CNPJ) ou uma filial de mesma raiz.");
	const modelo = MODELO[input.modelo];
	const autorizador = autorizadorNfe(modelo, input.uf, input.ambiente);
	if (!autorizador) return recusar(422, "uf_nao_suportada", `A UF ${input.uf} ainda não está disponível neste cofre.`);
	if (!temInutilizacao(modelo, input.uf)) {
		return recusar(
			422,
			"inutilizacao_extinta",
			`A inutilização de numeração deixou de existir em ${input.uf} (Ajustes SINIEF 38 e 40 de 2026): números não usados simplesmente ficam sem nota.`,
		);
	}
	const serieKey = { docId: cnpj, kind: input.modelo, environment: input.ambiente, serie: String(input.serie) };
	if ((await banco.numerosEmUsoNaFaixa(d1, serieKey, input.numeroInicial, input.numeroFinal)) > 0) {
		return recusar(409, "faixa_em_uso", "A faixa contém números de notas autorizadas ou em andamento neste cofre.");
	}

	const pedido = montarInutilizacao({ ...input, cnpj, modelo });
	let assinado: string;
	let lido: ReturnType<typeof lerRespostaInutilizacao>;
	let journalKey: string | undefined;
	try {
		assinado = (await ops.sign({ xml: pedido.xml, tag: "infInut", profile: "rsa-sha1" })).xml;
		const res = await chamar(ops, autorizador, "inutilizacao", assinado, pedido.id);
		journalKey = res.journalKey;
		lido = lerRespostaInutilizacao(res.status, res.corpo);
	} catch (err) {
		if (!(err instanceof OperacaoError)) throw err;
		return err.status === 422 || NAO_TRANSMITIDO.has(err.code)
			? recusar(422, err.code, err.message, [doErro(err)])
			: recusar(502, "sem_resposta_conclusiva", err.message, [doErro(err)]);
	}
	if (lido.tipo === "indefinida") return recusar(502, "sem_resposta_conclusiva", lido.detalhe);
	if (lido.tipo === "rejeitada") return recusar(422, "inutilizacao_rejeitada", lido.mensagem.descricao, [lido.mensagem]);

	const destino = `${input.modelo}/${input.ambiente}/inutilizacoes/${pedido.id}.xml`;
	await ops.putDocument(destino, procInutNFe(assinado, lido.retInutNFe), {
		contentType: "application/xml",
		meta: { tipo: "inutilizacao", serie: input.serie, numeroInicial: input.numeroInicial, numeroFinal: input.numeroFinal, protocolo: lido.protocolo, diario: journalKey ?? null },
	});
	const inutilizacao: banco.Inutilizacao = {
		...serieKey, id: banco.newId("inu"), firstNumber: input.numeroInicial, lastNumber: input.numeroFinal,
		protocol: lido.protocolo, justification: input.justificativa, documentKey: destino, createdAt: Date.now(),
	};
	await banco.insertInutilizacao(d1, inutilizacao);
	// Se a faixa começa no próximo número da série (ou antes), a série segue depois dela.
	const serie = await banco.getSerie(d1, serieKey);
	if (serie && input.numeroInicial <= serie.lastNumber + 1) await banco.avancarSerie(d1, serieKey, input.numeroFinal);
	return { ok: true, inutilizacao };
}

/** Consulta o status do serviço de autorização da UF. */
export async function statusSefaz(ops: Operacoes, modelo: Modelo, uf: string, ambiente: Ambiente) {
	const autorizador = autorizadorNfe(modelo, uf, ambiente);
	if (!autorizador) return null;
	const res = await chamar(ops, autorizador, "status", consStatServ(tpAmb(ambiente), CODIGO_UF[uf] as string), `status:${modelo}:${uf}`);
	return { autorizador: autorizador.nome, ...(lerStatusServico(res.corpo) ?? { emOperacao: false, mensagem: { codigo: "000", descricao: `HTTP ${res.status} sem retorno reconhecível.` }, tempoMedioSegundos: null }) };
}
