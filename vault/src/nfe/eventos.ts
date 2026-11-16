// Eventos da NF-e/NFC-e (cancelamento e carta de correção) e o pedido de
// inutilização de numeração. Cada função devolve o XML ainda sem assinatura.

import type { Ambiente } from "../fiscal/dados";
import { tag } from "../nfse/dps";
import { CODIGO_UF, type Modelo, dataHoraNaUf } from "./chave";
import { NAMESPACE_NFE } from "./xml";

const UF_DO_CODIGO = Object.fromEntries(Object.entries(CODIGO_UF).map(([uf, codigo]) => [codigo, uf]));

/** Texto fixo que o leiaute exige na carta de correção (sem acentos). */
const CONDICAO_DE_USO =
	"A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.";

export interface EventoContexto {
	ambiente: Ambiente;
	/** CNPJ do autor do evento (o emitente da nota). */
	cnpj: string;
	chave: string;
	agora?: Date;
}

export interface EventoMontado {
	xml: string;
	id: string;
}

function evento(ctx: EventoContexto, tipo: string, sequencia: number, detalhe: string): EventoMontado {
	const cUF = ctx.chave.slice(0, 2);
	const id = `ID${tipo}${ctx.chave}${String(sequencia).padStart(2, "0")}`;
	const xml =
		`<evento xmlns="${NAMESPACE_NFE}" versao="1.00"><infEvento Id="${id}">` +
		tag("cOrgao", cUF) + tag("tpAmb", ctx.ambiente === "homologacao" ? "2" : "1") + tag("CNPJ", ctx.cnpj) +
		tag("chNFe", ctx.chave) + tag("dhEvento", dataHoraNaUf(ctx.agora ?? new Date(), UF_DO_CODIGO[cUF] ?? "SP")) +
		tag("tpEvento", tipo) + tag("nSeqEvento", sequencia) + tag("verEvento", "1.00") +
		`<detEvento versao="1.00">${detalhe}</detEvento></infEvento></evento>`;
	return { xml, id };
}

/** Evento 110111: cancelamento, com o protocolo de autorização da nota. */
export function montarCancelamentoNfe(ctx: EventoContexto, protocolo: string, justificativa: string): EventoMontado {
	return evento(ctx, "110111", 1, tag("descEvento", "Cancelamento") + tag("nProt", protocolo) + tag("xJust", justificativa));
}

/** Evento 110110: carta de correção. A sequência cresce a cada carta da mesma nota. */
export function montarCartaCorrecao(ctx: EventoContexto, sequencia: number, correcao: string): EventoMontado {
	return evento(ctx, "110110", sequencia, tag("descEvento", "Carta de Correcao") + tag("xCorrecao", correcao) + tag("xCondUso", CONDICAO_DE_USO));
}

export interface InutilizacaoContexto {
	ambiente: Ambiente;
	cnpj: string;
	uf: string;
	modelo: Modelo;
	serie: number;
	numeroInicial: number;
	numeroFinal: number;
	justificativa: string;
	agora?: Date;
}

/** Pedido de inutilização de uma faixa de numeração. */
export function montarInutilizacao(ctx: InutilizacaoContexto): EventoMontado {
	const cUF = CODIGO_UF[ctx.uf] as string;
	const ano = dataHoraNaUf(ctx.agora ?? new Date(), ctx.uf).slice(2, 4);
	const id =
		`ID${cUF}${ano}${ctx.cnpj}${ctx.modelo}${String(ctx.serie).padStart(3, "0")}` +
		`${String(ctx.numeroInicial).padStart(9, "0")}${String(ctx.numeroFinal).padStart(9, "0")}`;
	const xml =
		`<inutNFe xmlns="${NAMESPACE_NFE}" versao="4.00"><infInut Id="${id}">` +
		tag("tpAmb", ctx.ambiente === "homologacao" ? "2" : "1") + tag("xServ", "INUTILIZAR") + tag("cUF", cUF) + tag("ano", ano) +
		tag("CNPJ", ctx.cnpj) + tag("mod", ctx.modelo) + tag("serie", ctx.serie) + tag("nNFIni", ctx.numeroInicial) +
		tag("nNFFin", ctx.numeroFinal) + tag("xJust", ctx.justificativa) +
		"</infInut></inutNFe>";
	return { xml, id };
}
