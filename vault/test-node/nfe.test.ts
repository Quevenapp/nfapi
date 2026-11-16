// Valida os XML de NF-e, NFC-e, eventos e inutilização contra os XSD oficiais
// (schemas/nfe). Roda no Node porque o validador não carrega no workerd.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { XmlDocument, XsdValidator } from "libxml2-wasm";
import { xmlRegisterFsInputProviders } from "libxml2-wasm/lib/nodejs.mjs";
import { describe, expect, it } from "vitest";
import { contratoOpenApi } from "../src/contrato";
import { EXEMPLO_NFCE, EXEMPLO_NFE } from "../src/contrato-exemplos";
import { autorizadorNfe } from "../src/fiscal/dados";
import { chaveValida, digitoVerificador, gerarCodigoNumerico, montarChave } from "../src/nfe/chave";
import { montarCancelamentoNfe, montarCartaCorrecao, montarInutilizacao } from "../src/nfe/eventos";
import { suplementoNfce } from "../src/nfe/qrcode";
import { NfceInput, NfeInput, type PedidoNfe } from "../src/nfe/schema";
import { consReciNFe, consSitNFe, consStatServ, envEvento, enviNFe } from "../src/nfe/sefaz";
import { comSuplementoNfce, montarNfe } from "../src/nfe/xml";
import { signXml } from "../src/signer";
import { CNPJ_TESTE, certificadoTeste } from "../test/helpers";

xmlRegisterFsInputProviders();

const SCHEMAS = path.join(import.meta.dirname, "../schemas/nfe");

/** Lista de erros de validação (vazia = válido). */
function validar(xml: string, xsd: string): string[] {
	const arquivo = path.join(SCHEMAS, xsd);
	const esquema = XmlDocument.fromBuffer(fs.readFileSync(arquivo), { url: pathToFileURL(arquivo).href });
	const validador = XsdValidator.fromDoc(esquema);
	const doc = XmlDocument.fromString(xml);
	try {
		validador.validate(doc);
		return [];
	} catch (err) {
		const detalhes = (err as { details?: { message: string }[] }).details;
		return detalhes?.map((d) => d.message.trim()) ?? [String(err)];
	} finally {
		doc.dispose();
		validador.dispose();
		esquema.dispose();
	}
}

const cert = certificadoTeste();
const assinar = (xml: string, tag: "infNFe" | "infEvento" | "infInut") =>
	signXml({ xml, tag, profile: "rsa-sha1", privateKeyPem: cert.privateKeyPem, certificatePem: cert.certificatePem, holder: cert.holder, allowProduction: true }).xml;

const AGORA = new Date("2026-11-16T15:30:00Z");
const contexto = { ambiente: "homologacao" as const, cnpj: CNPJ_TESTE, serie: 1, numero: 42, cNF: "87654321", versaoAplicativo: "NFapi-teste", agora: AGORA };

type Json = Record<string, any>;
const { ambiente: _a, referencia: _r, ...BASE_NFE } = EXEMPLO_NFE as Json;
const { ambiente: _b, referencia: _s, ...BASE_NFCE } = EXEMPLO_NFCE as Json;

function nfe(mudancas: Json = {}): PedidoNfe {
	return { ...NfeInput.parse({ ...BASE_NFE, ...mudancas }), modelo: "55" };
}
function nfce(mudancas: Json = {}): PedidoNfe {
	return { ...NfceInput.parse({ ...BASE_NFCE, ...mudancas }), modelo: "65" };
}
/** O item do exemplo com outro grupo de impostos. */
const item = (impostos: Json, extra: Json = {}) => ({ ...BASE_NFE.itens[0], ...extra, impostos: { ...BASE_NFE.itens[0].impostos, ...impostos } });
const simples = { ...BASE_NFE.emitente, regime: "simples_nacional" };

describe("chave de acesso", () => {
	it("calcula o dígito verificador, inclusive com CNPJ alfanumérico", () => {
		// Chave de exemplo do Manual de Orientação do Contribuinte.
		expect(digitoVerificador("5206043300991100250655012000000780026730161")).toBe("5");
		const chave = montarChave({ cUF: "35", emissao: "2026-11-16T12:30:00-03:00", cnpj: CNPJ_TESTE, modelo: "55", serie: 1, numero: 42, tpEmis: "1", cNF: "87654321" });
		expect(chave).toHaveLength(44);
		expect(chave.slice(0, 6)).toBe("352611");
		expect(chaveValida(chave)).toBe(true);
		expect(chaveValida(`${chave.slice(0, 43)}${(Number(chave[43]) + 1) % 10}`)).toBe(false);

		// Letras valem o código ASCII menos 48 ("A" = 17).
		const alfanumerica = montarChave({ cUF: "35", emissao: "2026-11-16", cnpj: "12ABC34501DE35", modelo: "55", serie: 1, numero: 1, tpEmis: "1", cNF: "87654321" });
		expect(chaveValida(alfanumerica)).toBe(true);
		// "B" vale 18: 18 × 2 = 36, resto 3, dígito 8. "A" vale 17: resto 1, dígito 0.
		expect(digitoVerificador("B")).toBe("8");
		expect(digitoVerificador("A")).toBe("0");
	});

	it("gera código numérico diferente do número da nota e sem sequências óbvias", () => {
		for (let i = 0; i < 200; i++) {
			const cNF = gerarCodigoNumerico(12345678);
			expect(cNF).toMatch(/^\d{8}$/);
			expect(cNF).not.toBe("12345678");
		}
	});
});

describe("NF-e (modelo 55)", () => {
	it("o exemplo do contrato gera uma NF-e válida, com totais somados", () => {
		const montada = montarNfe(nfe(), contexto);
		const assinada = assinar(montada.xml, "infNFe");
		expect(validar(assinada, "nfe/nfe_v4.00.xsd")).toEqual([]);
		expect(validar(enviNFe(assinada, "1"), "nfe/enviNFe_v4.00.xsd")).toEqual([]);

		expect(montada.chave).toHaveLength(44);
		expect(montada.dataEmissao).toBe("2026-11-16T12:30:00-03:00");
		expect(montada.total).toBe(700);
		expect(montada.xml).toContain(`<infNFe Id="NFe${montada.chave}" versao="4.00">`);
		expect(montada.xml).toContain("<mod>55</mod><serie>1</serie><nNF>42</nNF>");
		expect(montada.xml).toContain("<tpAmb>2</tpAmb>");
		expect(montada.xml).toContain(`<emit><CNPJ>${CNPJ_TESTE}</CNPJ>`);
		// Em homologação o nome do destinatário é o texto padrão.
		expect(montada.xml).toContain("<xNome>NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xNome>");
		expect(montada.xml).toContain("<vBC>700.00</vBC><vICMS>126.00</vICMS>");
		expect(montada.xml).toContain("<vPIS>11.55</vPIS><vCOFINS>53.20</vCOFINS><vOutro>0.00</vOutro><vNF>700.00</vNF>");
		// Reforma tributária: grupo do item e total.
		expect(montada.xml).toContain("<IBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib><gIBSCBS><vBC>509.25</vBC>");
		expect(montada.xml).toContain("<IBSCBSTot><vBCIBSCBS>509.25</vBCIBSCBS>");
	});

	it("em produção mantém o nome do destinatário e marca tpAmb 1", () => {
		const montada = montarNfe(nfe(), { ...contexto, ambiente: "producao" });
		expect(validar(assinar(montada.xml, "infNFe"), "nfe/nfe_v4.00.xsd")).toEqual([]);
		expect(montada.xml).toContain("<tpAmb>1</tpAmb>");
		expect(montada.xml).toContain("<xNome>Cliente Ltda</xNome>");
	});

	const st = { modalidadeBc: 4, mva: 40, baseCalculo: 980, aliquota: 18, valor: 50.4, fcp: { aliquota: 2, valor: 19.6 } };
	const proprio = { modalidadeBc: 3, baseCalculo: 700, aliquota: 18, valor: 126 };
	const retido = { baseCalculo: 980, aliquotaConsumidorFinal: 18, valorSubstituto: 126, valor: 50.4, fcp: { baseCalculo: 980, aliquota: 2, valor: 19.6 } };
	const grupos: [string, Json][] = [
		["00 com FCP", { cst: "00", ...proprio, fcp: { aliquota: 2, valor: 14 } }],
		["10", { cst: "10", ...proprio, st }],
		["20", { cst: "20", ...proprio, reducaoBc: 33.33, desoneracao: { valor: 10, motivo: 9, deduzDoTotal: true } }],
		["30", { cst: "30", st }],
		["40", { cst: "40", desoneracao: { valor: 126, motivo: 9 } }],
		["41", { cst: "41" }],
		["51", { cst: "51", ...proprio, valor: 0, diferimento: { valorOperacao: 126, percentual: 100, valorDiferido: 126 } }],
		["60", { cst: "60", retidoAnteriormente: retido }],
		["70", { cst: "70", ...proprio, reducaoBc: 10, st }],
		["90", { cst: "90", ...proprio, st }],
		["90 sem valores", { cst: "90" }],
	];
	it.each(grupos)("ICMS do regime normal: CST %s", (_nome, icms) => {
		const montada = montarNfe(nfe({ itens: [item({ icms })] }), contexto);
		expect(validar(assinar(montada.xml, "infNFe"), "nfe/nfe_v4.00.xsd")).toEqual([]);
	});

	const gruposSimples: [string, Json][] = [
		["101", { csosn: "101", creditoSimples: { aliquota: 1.25, valor: 8.75 } }],
		["102", { csosn: "102" }],
		["201", { csosn: "201", st, creditoSimples: { aliquota: 1.25, valor: 8.75 } }],
		["202", { csosn: "202", st }],
		["400", { csosn: "400" }],
		["500", { csosn: "500", retidoAnteriormente: retido }],
		["500 sem valores", { csosn: "500" }],
		["900", { csosn: "900", ...proprio, creditoSimples: { aliquota: 1.25, valor: 8.75 } }],
	];
	it.each(gruposSimples)("ICMS do Simples Nacional: CSOSN %s", (_nome, icms) => {
		const semIbs = { icms, ibsCbs: undefined };
		const montada = montarNfe(nfe({ emitente: simples, itens: [item(semIbs)] }), contexto);
		expect(validar(assinar(montada.xml, "infNFe"), "nfe/nfe_v4.00.xsd")).toEqual([]);
	});

	it("soma a substituição tributária e o FCP no total da nota", () => {
		const montada = montarNfe(nfe({ itens: [item({ icms: { cst: "10", ...proprio, st } }, { frete: 20, desconto: 5.5, outrasDespesas: 1 })] }), contexto);
		expect(validar(assinar(montada.xml, "infNFe"), "nfe/nfe_v4.00.xsd")).toEqual([]);
		// 700 - 5,50 + 50,40 (ST) + 19,60 (FCP ST) + 20 (frete) + 1 (outras)
		expect(montada.total).toBe(785.5);
		expect(montada.xml).toContain("<vBCST>980.00</vBCST><vST>50.40</vST><vFCPST>19.60</vFCPST>");
	});

	it("aceita devolução, IPI, DIFAL, transporte, cartão e responsável técnico", () => {
		const pedido = nfe({
			finalidade: "devolucao",
			tipo: "entrada",
			consumidorFinal: true,
			presenca: "internet",
			intermediador: { cnpj: "55444333000122", identificacao: "loja-exemplo" },
			notasReferenciadas: ["35261111222333000181550010000000411876543210"],
			destinatario: { ...BASE_NFE.destinatario, indicadorIe: "nao_contribuinte", inscricaoEstadual: undefined, endereco: { ...BASE_NFE.destinatario.endereco, uf: "RJ", codigoMunicipio: "3304557", municipio: "Rio de Janeiro" } },
			itens: [
				item(
					{
						ipi: { cst: "50", baseCalculo: 700, aliquota: 5, valor: 35 },
						difal: { baseCalculo: 700, aliquotaInterna: 20, aliquotaInterestadual: 12, valorDestino: 56, fcp: { aliquota: 2, valor: 14 } },
						valorAproximadoTributos: 210.5,
					},
					{ ean: "7891000100103", cest: "0100100", numeroPedido: "PED-9", itemPedido: 1, informacoesAdicionais: "Lote 7", tributavel: { unidade: "CX", quantidade: 1, valorUnitario: 700 } },
				),
				item({ ipi: { cst: "53" }, pis: { cst: "07" }, cofins: { cst: "99", baseCalculo: 0, aliquota: 0, valor: 0 } }, { codigo: "SKU-2", quantidade: 1.5, valorUnitario: 10.123456, compoeTotal: false }),
			],
			transporte: {
				modalidade: 1,
				transportadora: { cnpj: "44333222000111", nome: "Transportes Exemplo", inscricaoEstadual: "333333333333", endereco: "Rodovia BR 116, km 10", municipio: "São Paulo", uf: "SP" },
				veiculo: { placa: "ABC1D23", uf: "SP" },
				volumes: [{ quantidade: 2, especie: "CAIXA", pesoLiquido: 12.5, pesoBruto: 13 }],
			},
			pagamentos: [
				{ forma: "03", valor: 400, cartao: { integracao: "integrado", cnpjCredenciadora: "01027058000191", bandeira: "01", autorizacao: "123456" } },
				{ forma: "99", valor: 335, descricao: "Crédito da loja" },
			],
			informacoesFisco: "Devolução parcial",
			responsavelTecnico: { cnpj: "11222333000181", contato: "Suporte", email: "suporte@exemplo.example", telefone: "1133334444" },
		});
		const montada = montarNfe(pedido, contexto);
		expect(validar(assinar(montada.xml, "infNFe"), "nfe/nfe_v4.00.xsd")).toEqual([]);
		expect(montada.xml).toContain("<idDest>2</idDest>");
		expect(montada.xml).toContain("<indPres>2</indPres><indIntermed>1</indIntermed>");
		expect(montada.xml).toContain("<vUnCom>10.123456</vUnCom>");
		// O segundo item não compõe o total; o IPI entra.
		expect(montada.total).toBe(735);
	});

	it("o schema recusa regime e imposto incoerentes e devolução sem nota referenciada", () => {
		const erro = (mudancas: Json) => NfeInput.safeParse({ ...BASE_NFE, ...mudancas }).error?.issues[0];
		expect(erro({ emitente: simples })?.path.join(".")).toBe("itens.0.impostos.icms.csosn");
		expect(erro({ itens: [item({ icms: { csosn: "102" } })] })?.path.join(".")).toBe("itens.0.impostos.icms.cst");
		expect(erro({ itens: [item({ pis: undefined })] })?.path.join(".")).toBe("itens.0.impostos.pis");
		expect(erro({ finalidade: "devolucao" })?.path.join(".")).toBe("notasReferenciadas");
		expect(erro({ pagamentos: [{ forma: "99", valor: 1 }] })?.path.join(".")).toBe("pagamentos.0.descricao");
		expect(erro({ destinatario: { cnpj: "99888777000166", cpf: "12345678909" } })?.message).toContain("exatamente um");
	});
});

describe("NFC-e (modelo 65)", () => {
	it("o exemplo do contrato gera uma NFC-e válida, com o QR Code versão 3", () => {
		const montada = montarNfe(nfce(), contexto);
		const autorizador = autorizadorNfe("65", "SP", "homologacao");
		const supl = suplementoNfce(montada.chave, "homologacao", autorizador?.nfce as NonNullable<NonNullable<typeof autorizador>["nfce"]>);
		expect(supl.qrCode).toBe(`https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode?p=${montada.chave}|3|2`);
		const assinada = assinar(comSuplementoNfce(montada.xml, supl.qrCode, supl.urlChave), "infNFe");
		expect(validar(assinada, "nfe/nfe_v4.00.xsd")).toEqual([]);
		expect(validar(enviNFe(assinada, "1"), "nfe/enviNFe_v4.00.xsd")).toEqual([]);

		// O suplemento fica entre infNFe e a assinatura.
		expect(assinada).toMatch(/<\/infNFe><infNFeSupl><qrCode><!\[CDATA\[https:[^\]]+\]\]><\/qrCode><urlChave>[^<]+<\/urlChave><\/infNFeSupl><Signature /);
		expect(montada.xml).toContain("<mod>65</mod>");
		expect(montada.xml).toContain("<tpImp>4</tpImp>");
		expect(montada.xml).toContain("<indFinal>1</indFinal><indPres>1</indPres>");
		expect(montada.xml).toContain("<xProd>NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL</xProd>");
		expect(montada.xml).toContain("<dest><CPF>12345678909</CPF><indIEDest>9</indIEDest></dest>");
		expect(montada.xml).toContain("<vPag>100.00</vPag></detPag><vTroco>40.10</vTroco>");
		expect(montada.total).toBe(59.9);
	});

	it("vale sem consumidor identificado, e em produção mantém a descrição do item", () => {
		const montada = montarNfe(nfce({ destinatario: undefined, troco: undefined, pagamentos: [{ forma: "17", valor: 59.9 }] }), { ...contexto, ambiente: "producao" });
		expect(validar(assinar(montada.xml, "infNFe"), "nfe/nfe_v4.00.xsd")).toEqual([]);
		expect(montada.xml).not.toContain("<dest>");
		expect(montada.xml).toContain("<xProd>Camiseta de algodão</xProd>");
	});

	it("o schema recusa finalidade que não existe na NFC-e", () => {
		expect(NfceInput.safeParse({ ...BASE_NFCE, finalidade: "devolucao", notasReferenciadas: ["35261111222333000181550010000000411876543210"] }).success).toBe(false);
	});
});

describe("eventos, consultas e inutilização", () => {
	const chave = montarChave({ cUF: "35", emissao: "2026-11-16", cnpj: CNPJ_TESTE, modelo: "55", serie: 1, numero: 42, tpEmis: "1", cNF: "87654321" });
	const ctx = { ambiente: "homologacao" as const, cnpj: CNPJ_TESTE, chave, agora: AGORA };
	/** O detEvento sozinho, para validar contra o XSD específico do tipo de evento. */
	const detalheDoEvento = (xml: string) =>
		(/<detEvento [\s\S]*<\/detEvento>/.exec(xml)?.[0] ?? "").replace("<detEvento ", '<detEvento xmlns="http://www.portalfiscal.inf.br/nfe" ');

	it("cancelamento (110111)", () => {
		const evento = montarCancelamentoNfe(ctx, "135260000000123", "Pedido cancelado pelo cliente");
		expect(evento.id).toBe(`ID110111${chave}01`);
		const assinado = assinar(evento.xml, "infEvento");
		expect(validar(envEvento(assinado, "1"), "evento/envEventoCancNFe_v1.00.xsd")).toEqual([]);
		expect(validar(envEvento(assinado, "1"), "evento/envEvento_v1.00.xsd")).toEqual([]);
		expect(validar(detalheDoEvento(evento.xml), "evento/e110111_v1.00.xsd")).toEqual([]);
		expect(evento.xml).toContain("<cOrgao>35</cOrgao><tpAmb>2</tpAmb>");
		expect(evento.xml).toContain("<dhEvento>2026-11-16T12:30:00-03:00</dhEvento>");
	});

	it("carta de correção (110110), com a sequência no Id", () => {
		const evento = montarCartaCorrecao(ctx, 3, "Endereço de entrega: Rua das Acácias, 45");
		expect(evento.id).toBe(`ID110110${chave}03`);
		expect(validar(envEvento(assinar(evento.xml, "infEvento"), "1"), "evento/envEvento_v1.00.xsd")).toEqual([]);
		// O conteúdo do evento (incluindo o texto fixo das condições de uso) tem XSD próprio.
		expect(validar(detalheDoEvento(evento.xml), "evento/e110110_v1.00.xsd")).toEqual([]);
		expect(evento.xml).toContain("<nSeqEvento>3</nSeqEvento>");
	});

	it("inutilização de faixa", () => {
		const pedido = montarInutilizacao({ ambiente: "homologacao", cnpj: CNPJ_TESTE, uf: "RJ", modelo: "55", serie: 1, numeroInicial: 15, numeroFinal: 17, justificativa: "Números pulados por falha", agora: AGORA });
		expect(pedido.id).toBe(`ID3326${CNPJ_TESTE}55001000000015000000017`);
		expect(validar(assinar(pedido.xml, "infInut"), "nfe/inutNFe_v4.00.xsd")).toEqual([]);
	});

	it("consultas de protocolo, recibo e status", () => {
		expect(validar(consSitNFe("2", chave), "nfe/consSitNFe_v4.00.xsd")).toEqual([]);
		expect(validar(consReciNFe("2", "351000000000001"), "nfe/consReciNFe_v4.00.xsd")).toEqual([]);
		expect(validar(consStatServ("2", "35"), "nfe/consStatServ_v4.00.xsd")).toEqual([]);
	});
});

describe("contrato da API", () => {
	const arquivo = path.join(import.meta.dirname, "../docs/openapi.json");
	const gerado = `${JSON.stringify(contratoOpenApi(), null, "\t")}\n`;

	it("docs/openapi.json está em dia com os schemas (ATUALIZAR_CONTRATO=1 regrava)", () => {
		if (process.env.ATUALIZAR_CONTRATO === "1") {
			fs.mkdirSync(path.dirname(arquivo), { recursive: true });
			fs.writeFileSync(arquivo, gerado);
		}
		expect(fs.existsSync(arquivo) ? fs.readFileSync(arquivo, "utf8") : "").toBe(gerado);
	});

	it("os exemplos do contrato são pedidos válidos", () => {
		expect(NfeInput.safeParse(EXEMPLO_NFE).error?.issues).toBeUndefined();
		expect(NfceInput.safeParse(EXEMPLO_NFCE).error?.issues).toBeUndefined();
		const contrato = contratoOpenApi() as Json;
		expect(Object.keys(contrato.paths)).toContain("/v1/nfce/{id}/cancelar");
		expect(contrato.paths["/v1/nfe"].post.requestBody.content["application/json"].example).toEqual(EXEMPLO_NFE);
		expect(contrato.components.schemas.PedidoNfe.allOf[1].properties.itens.type).toBe("array");
	});
});
