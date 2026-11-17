import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { executarAgendado } from "../src/agendador";
import { createApp } from "../src/app";
import { EXEMPLO_NFE } from "../src/contrato-exemplos";
import { ajustes } from "../src/emissao/nfe";
import { montarChave } from "../src/nfe/chave";
import { gzipBase64 } from "../src/nfse";
import type { TransmitRequest } from "../src/protocol";
import { type Transport, TransportError, type TransportResult } from "../src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "./helpers";

const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";
type Json = Record<string, any>;

// ---------- Ambiente Nacional simulado ----------

const NS = 'xmlns="http://www.portalfiscal.inf.br/nfe"';
const FORNECEDOR = "44555666000181";
const chaveDoFornecedor = (numero: number) => montarChave({ cUF: "35", emissao: "2026-11-10", cnpj: FORNECEDOR, modelo: "55", serie: 1, numero, tpEmis: "1", cNF: "87654321" });
const dataRecente = (diasAtras: number) => `${new Date(Date.now() - diasAtras * 86_400_000).toISOString().slice(0, 19)}-03:00`;

const resumo = (chave: string, { situacao = "1", autorizadaEm = dataRecente(1), valor = "1520.75" } = {}) =>
	`<resNFe ${NS} versao="1.01"><chNFe>${chave}</chNFe><CNPJ>${FORNECEDOR}</CNPJ><xNome>Fornecedor de Teste Ltda</xNome><IE>123456789012</IE>` +
	`<dhEmi>${autorizadaEm}</dhEmi><tpNF>1</tpNF><vNF>${valor}</vNF><digVal>abc=</digVal><dhRecbto>${autorizadaEm}</dhRecbto><nProt>135260000001234</nProt><cSitNFe>${situacao}</cSitNFe></resNFe>`;
const notaCompleta = (chave: string) =>
	`<nfeProc ${NS} versao="4.00"><NFe><infNFe Id="NFe${chave}" versao="4.00"><ide><dhEmi>2026-11-10T09:30:00-03:00</dhEmi><tpNF>1</tpNF></ide>` +
	`<emit><CNPJ>${FORNECEDOR}</CNPJ><xNome>Fornecedor de Teste Ltda</xNome><IE>123456789012</IE></emit><dest><CNPJ>${CNPJ_TESTE}</CNPJ><xNome>Empresa de Teste</xNome></dest>` +
	"<total><ICMSTot><vNF>1520.75</vNF></ICMSTot></total></infNFe></NFe>" +
	`<protNFe versao="4.00"><infProt><chNFe>${chave}</chNFe><dhRecbto>2026-11-10T09:31:00-03:00</dhRecbto><nProt>135260000001234</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
const cancelamento = (chave: string) =>
	`<procEventoNFe ${NS} versao="1.00"><evento versao="1.00"><infEvento Id="ID110111${chave}01"><cOrgao>35</cOrgao><tpAmb>2</tpAmb><CNPJ>${FORNECEDOR}</CNPJ><chNFe>${chave}</chNFe>` +
	'<dhEvento>2026-11-11T08:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento></detEvento></infEvento></evento>' +
	`<retEvento versao="1.00"><infEvento><cStat>135</cStat><chNFe>${chave}</chNFe><nProt>135260000009999</nProt></infEvento></retEvento></procEventoNFe>`;

interface Chamada {
	servico: "distribuicao" | "evento" | "autorizacao";
	url: string;
	corpo: string;
}
const an = {
	chamadas: [] as Chamada[],
	/** Documentos na fila de distribuição do CNPJ, em ordem de NSU. */
	fila: [] as { nsu: number; schema: string; xml: string }[],
	/** Notas que a consulta por chave devolve. */
	porChave: {} as Record<string, string>,
	fora: false,
	distribuicao: null as null | ((corpo: string) => string),
	evento: null as null | ((corpo: string) => string),
};
const envelope = (xml: string) => `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>${xml}</soap:Body></soap:Envelope>`;
const retDist = (conteudo: string) =>
	envelope(`<nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult><retDistDFeInt ${NS} versao="1.01"><tpAmb>2</tpAmb><verAplic>1.4.0</verAplic>${conteudo}</retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse>`);
const nsu15 = (n: number) => String(n).padStart(15, "0");
const consumoIndevido = (ultNsu?: number) =>
	retDist(`<cStat>656</cStat><xMotivo>Rejeicao: Consumo Indevido. Deve ser utilizado o ultNSU nas solicitacoes subsequentes. Tente apos 1 hora</xMotivo>${ultNsu === undefined ? "" : `<ultNSU>${nsu15(ultNsu)}</ultNSU><maxNSU>${nsu15(ultNsu)}</maxNSU>`}`);

async function distribuir(corpo: string): Promise<string> {
	if (an.distribuicao) return an.distribuicao(corpo);
	const maior = an.fila.reduce((m, d) => Math.max(m, d.nsu), 0);
	const porChave = /<consChNFe><chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(corpo)?.[1];
	if (porChave) {
		const xml = an.porChave[porChave];
		if (!xml) return retDist("<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>");
		return retDist(`<cStat>138</cStat><xMotivo>Documento localizado</xMotivo><loteDistDFeInt><docZip schema="procNFe_v4.00.xsd">${await gzipBase64(xml)}</docZip></loteDistDFeInt>`);
	}
	const ult = Number(/<ultNSU>(\d{15})<\/ultNSU>/.exec(corpo)?.[1] ?? "x");
	const lote = an.fila.filter((d) => d.nsu > ult).slice(0, 50);
	if (lote.length === 0) return retDist(`<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo><ultNSU>${nsu15(ult)}</ultNSU><maxNSU>${nsu15(maior)}</maxNSU>`);
	const docs = await Promise.all(lote.map(async (d) => `<docZip NSU="${nsu15(d.nsu)}" schema="${d.schema}">${await gzipBase64(d.xml)}</docZip>`));
	return retDist(
		`<cStat>138</cStat><xMotivo>Documento(s) localizado(s)</xMotivo><ultNSU>${nsu15(lote[lote.length - 1]?.nsu ?? 0)}</ultNSU><maxNSU>${nsu15(maior)}</maxNSU><loteDistDFeInt>${docs.join("")}</loteDistDFeInt>`,
	);
}
const retEvento = (cStat: string, xMotivo: string, corpo: string) =>
	envelope(
		`<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><retEnvEvento ${NS} versao="1.00"><cStat>128</cStat><retEvento versao="1.00"><infEvento><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>` +
			`<chNFe>${/<chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(corpo)?.[1]}</chNFe><nProt>891260000000555</nProt></infEvento></retEvento></retEnvEvento></nfeResultMsg>`,
	);
const autorizada = (corpo: string) => {
	const chave = /Id="NFe([0-9A-Z]{44})"/.exec(corpo)?.[1];
	return envelope(
		`<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><retEnviNFe ${NS} versao="4.00"><cStat>104</cStat><xMotivo>Lote processado</xMotivo>` +
			`<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-11-16T19:00:00-03:00</dhRecbto><nProt>135260000000777</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retEnviNFe></nfeResultMsg>`,
	);
};

const transporte: Transport = {
	async transmit(request: TransmitRequest): Promise<TransportResult> {
		const corpo = new TextDecoder().decode(Uint8Array.from(atob(request.bodyB64 ?? ""), (ch) => ch.charCodeAt(0)));
		const servico = request.url.includes("NFeDistribuicaoDFe") ? "distribuicao" : request.url.includes("fazenda.gov.br/NFeRecepcaoEvento4") ? "evento" : "autorizacao";
		an.chamadas.push({ servico, url: request.url, corpo });
		if (an.fora) throw new TransportError(504, "tempo_esgotado", "Sem resposta do Ambiente Nacional.");
		const xml =
			servico === "distribuicao" ? await distribuir(corpo) : servico === "evento" ? (an.evento ?? ((c) => retEvento("135", "Evento registrado e vinculado a NF-e", c)))(corpo) : autorizada(corpo);
		let binario = "";
		for (const b of new TextEncoder().encode(xml)) binario += String.fromCharCode(b);
		return { status: 200, headers: {}, bodyB64: btoa(binario), tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" }, ms: 5 };
	},
};

const app = createApp(() => transporte, { fetch: async () => Response.json({ version: "0.0.1" }) });
const admin = async (method: string, path: string, body?: unknown) => {
	const res = await app.request(COFRE + path, { method, headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const text = await res.text();
	return { status: res.status, json: ((res.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : null) as Json, text, res };
};
let chaveApi: string;
async function cliente(method: string, path: string, body?: unknown, chave = chaveApi) {
	const res = await app.request(COFRE + path, { method, headers: { authorization: `Bearer ${chave}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
	const bytes = new Uint8Array(await res.arrayBuffer());
	const text = new TextDecoder().decode(bytes);
	return { status: res.status, json: ((res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null) as Json, text, tipo: res.headers.get("content-type") };
}
const chamadas = (servico: Chamada["servico"]) => an.chamadas.filter((c) => c.servico === servico);
const configurar = (mudancas: Json = {}) => admin("PUT", "/admin/distribuicao", { ambiente: "homologacao", uf: "SP", consultaAutomatica: false, ...mudancas });
const sincronizar = () => cliente("POST", "/v1/distribuicao/sincronizar", { ambiente: "homologacao" });
const recebidas = async (query = "") => (await cliente("GET", `/v1/nfe-recebidas${query}`)).json;
/** Faz a espera exigida pelo Ambiente Nacional já ter passado. */
const vencerEspera = () => env.DB.prepare("UPDATE dfe_cursores SET next_at = 0").run();
const cursor = async () => (await cliente("GET", "/v1/distribuicao")).json.distribuicoes[0] as Json;

beforeEach(async () => {
	ajustes.esperaReciboMs = 0;
	Object.assign(an, { chamadas: [], fila: [], porChave: {}, fora: false, distribuicao: null, evento: null });
	await env.DB.batch(
		["emissions", "series", "inutilizacoes", "api_keys", "certificate", "settings", "audit", "documents", "dfe_cursores", "dfe_documentos", "recebidas"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
	);
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	await app.request(`${COFRE}/admin/certificate`, { method: "POST", headers: { authorization: `Bearer ${env.VAULT_SECRET}` }, body: form }, env);
	chaveApi = (await admin("POST", "/admin/chaves", { nome: "ERP de teste" })).json.chave.valor;
});

describe("distribuição de DF-e: notas recebidas", () => {
	it("exige a configuração, baixa os resumos e respeita a hora de espera", async () => {
		const [a, b] = [chaveDoFornecedor(101), chaveDoFornecedor(102)];
		const resumoDeA = resumo(a);
		an.fila = [
			{ nsu: 11, schema: "resNFe_v1.01.xsd", xml: resumoDeA },
			{ nsu: 12, schema: "resNFe_v1.01.xsd", xml: resumo(b, { valor: "80.00" }) },
			{ nsu: 13, schema: "procEventoNFe_v1.00.xsd", xml: cancelamento(b) },
		];
		expect((await sincronizar()).json.erro.codigo).toBe("distribuicao_nao_configurada");
		expect((await configurar()).json.distribuicao).toMatchObject({ cnpj: CNPJ_TESTE, ambiente: "homologacao", uf: "SP", consultaAutomatica: false, cienciaAutomatica: false, ultimoNsu: 0, proximaConsulta: null, bloqueada: false });

		const r = await sincronizar();
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ consultou: true, lotes: 1, documentos: 3, notasNovas: 2 });
		expect(r.json.distribuicao).toMatchObject({ ultimoNsu: 13, maiorNsu: 13, mensagem: { codigo: "138" }, bloqueada: false });
		expect(Date.parse(r.json.distribuicao.proximaConsulta) - Date.now()).toBeGreaterThan(60 * 60_000);
		expect(chamadas("distribuicao")).toHaveLength(1);
		expect(chamadas("distribuicao")[0]?.url).toBe("https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx");
		expect(chamadas("distribuicao")[0]?.corpo).toContain(`<tpAmb>2</tpAmb><cUFAutor>35</cUFAutor><CNPJ>${CNPJ_TESTE}</CNPJ><distNSU><ultNSU>000000000000000</ultNSU></distNSU>`);

		const lista = await recebidas();
		expect(lista.recebidas.map((n: Json) => [n.chaveAcesso, n.situacao, n.valor, n.xmlDisponivel])).toEqual([
			[a, "autorizada", 1520.75, false],
			[b, "cancelada", 80, false],
		]);
		expect(lista).toMatchObject({ haMais: false, ultimaSequencia: lista.recebidas[1].sequencia });
		expect(lista.recebidas[0]).toMatchObject({
			ambiente: "homologacao", cnpj: CNPJ_TESTE, papel: "destinatario", serie: 1, numero: 101, tipoOperacao: "saida", protocolo: "135260000001234",
			emitente: { documento: FORNECEDOR, nome: "Fornecedor de Teste Ltda", ie: "123456789012" }, manifestacao: null, manifestacoes: [],
		});
		// Só o resumo: ainda não há XML nem DANFE.
		expect((await cliente("GET", `/v1/nfe-recebidas/${lista.recebidas[0].id}/xml`)).json.erro.codigo).toBe("xml_indisponivel");
		expect((await cliente("GET", `/v1/nfe-recebidas/${lista.recebidas[0].id}/danfe`)).status).toBe(409);
		// A nota cancelada traz o evento que a cancelou.
		const cancelada = (await cliente("GET", `/v1/nfe-recebidas/${lista.recebidas[1].id}`)).json;
		expect(cancelada.eventos).toHaveLength(1);
		expect(cancelada.eventos[0]).toMatchObject({ tipo: "evento", nsu: 13, evento: { codigo: "110111", sequencia: 1, descricao: "Cancelamento", protocolo: "135260000009999", autor: FORNECEDOR } });

		// Dentro da hora de espera nada sai do cofre, por mais que o cliente peça.
		for (let i = 0; i < 3; i++) expect((await sincronizar()).json).toMatchObject({ consultou: false, documentos: 0 });
		expect(chamadas("distribuicao")).toHaveLength(1);

		// Leitura incremental: nada mudou depois da última sequência.
		expect((await recebidas(`?depois=${lista.ultimaSequencia}`)).recebidas).toEqual([]);
		expect((await recebidas(`?chaveAcesso=${b}`)).recebidas).toHaveLength(1);
		expect((await recebidas("?ambiente=producao")).recebidas).toEqual([]);
		expect((await cliente("GET", "/v1/nfe-recebidas?ambiente=teste")).status).toBe(400);
		expect((await app.request(`${COFRE}/v1/nfe-recebidas`, {}, env)).status).toBe(401);

		// O registro bruto dos documentos, com o XML de cada um.
		const docs = (await cliente("GET", "/v1/distribuicao/documentos")).json;
		expect(docs.documentos.map((d: Json) => [d.nsu, d.tipo, d.schema])).toEqual([[11, "resumo_nfe", "resNFe_v1.01.xsd"], [12, "resumo_nfe", "resNFe_v1.01.xsd"], [13, "evento", "procEventoNFe_v1.00.xsd"]]);
		expect((await cliente("GET", `/v1/distribuicao/documentos/${docs.documentos[0].sequencia}/xml`)).text).toBe(resumoDeA);
		expect((await cliente("GET", "/v1/distribuicao/documentos/999999/xml")).status).toBe(404);
	});

	it("continua do último NSU, em lotes de 50, e depois de 'nenhum documento' espera uma hora", async () => {
		an.fila = Array.from({ length: 120 }, (_, i) => ({ nsu: i + 1, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(1000 + i)) }));
		await configurar();
		const r = await sincronizar();
		expect(r.json).toMatchObject({ consultou: true, lotes: 3, documentos: 120, notasNovas: 120, distribuicao: { ultimoNsu: 120, maiorNsu: 120 } });
		expect(chamadas("distribuicao").map((c) => /<ultNSU>(\d+)</.exec(c.corpo)?.[1])).toEqual([nsu15(0), nsu15(50), nsu15(100)]);

		// Paginação da leitura pelo cliente.
		const p1 = await recebidas("?limite=100");
		expect([p1.recebidas.length, p1.haMais]).toEqual([100, true]);
		const p2 = await recebidas(`?limite=100&depois=${p1.ultimaSequencia}`);
		expect([p2.recebidas.length, p2.haMais]).toEqual([20, false]);

		// Hora vencida e nada novo: 137, e a espera recomeça.
		await vencerEspera();
		expect((await sincronizar()).json).toMatchObject({ consultou: true, documentos: 0, distribuicao: { ultimoNsu: 120, mensagem: { codigo: "137", descricao: "Nenhum documento localizado" } } });
		expect(chamadas("distribuicao")[3]?.corpo).toContain(`<ultNSU>${nsu15(120)}</ultNSU>`);
		expect((await sincronizar()).json.consultou).toBe(false);

		// Chega uma nota nova: a próxima consulta traz só ela, e quem lê pela sequência a vê.
		an.fila.push({ nsu: 121, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(5000)) });
		await vencerEspera();
		expect((await sincronizar()).json).toMatchObject({ documentos: 1, notasNovas: 1 });
		expect((await recebidas(`?depois=${p2.ultimaSequencia}`)).recebidas.map((n: Json) => n.numero)).toEqual([5000]);
	});

	it("o mesmo lote entregue duas vezes não duplica nada", async () => {
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(1)) }];
		await configurar();
		await sincronizar();
		await env.DB.prepare("UPDATE dfe_cursores SET next_at = 0, ult_nsu = 0").run();
		expect((await sincronizar()).json).toMatchObject({ consultou: true, documentos: 0, notasNovas: 0 });
		expect((await recebidas()).recebidas).toHaveLength(1);
		expect((await cliente("GET", "/v1/distribuicao/documentos")).json.documentos).toHaveLength(1);
	});

	it("consumo indevido (656) bloqueia tudo por uma hora e adota o NSU devolvido", async () => {
		await configurar();
		an.distribuicao = () => consumoIndevido(77);
		const r = (await sincronizar()).json;
		expect(r).toMatchObject({ consultou: true, documentos: 0, distribuicao: { bloqueada: true, ultimoNsu: 77, mensagem: { codigo: "656" } } });
		expect(Date.parse(r.distribuicao.proximaConsulta) - Date.now()).toBeGreaterThan(60 * 60_000);
		// Bloqueado: nem a consulta por chave sai.
		const porChave = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(1) });
		expect([porChave.status, porChave.json.erro.codigo]).toEqual([429, "consumo_indevido"]);
		expect(chamadas("distribuicao")).toHaveLength(1);
		expect((await admin("GET", "/admin/audit")).json.entries.some((e: Json) => e.action === "distribuicao.sequencia_adiantada" && e.detail.para === 77)).toBe(true);
	});

	it("sem resposta ou serviço paralisado: tenta de novo em 15 minutos, sem mexer no NSU", async () => {
		await configurar();
		an.fora = true;
		let r = (await sincronizar()).json;
		expect(r).toMatchObject({ consultou: true, lotes: 0, distribuicao: { ultimoNsu: 0, bloqueada: false, mensagem: { codigo: "tempo_esgotado" } } });
		const espera = Date.parse(r.distribuicao.proximaConsulta) - Date.now();
		expect(espera).toBeGreaterThan(14 * 60_000);
		expect(espera).toBeLessThan(16 * 60_000);

		an.fora = false;
		an.distribuicao = () => retDist("<cStat>108</cStat><xMotivo>Servico Paralisado Momentaneamente (curto prazo)</xMotivo>");
		await vencerEspera();
		r = (await sincronizar()).json;
		expect(r.distribuicao.mensagem.codigo).toBe("108");
		expect(Date.parse(r.distribuicao.proximaConsulta) - Date.now()).toBeLessThan(16 * 60_000);
	});

	it("produção só com a trava liberada; chave de teste nunca toca a produção", async () => {
		expect((await configurar({ ambiente: "producao", consultaAutomatica: true })).json.error.code).toBe("producao_bloqueada");
		expect((await configurar({ ambiente: "producao" })).status).toBe(200);
		const bloqueado = await cliente("POST", "/v1/distribuicao/sincronizar", { ambiente: "producao" });
		expect([bloqueado.status, bloqueado.json.erro.codigo]).toEqual([422, "producao_bloqueada"]);
		const deTeste = (await admin("POST", "/admin/chaves", { nome: "teste", escopo: "homologacao" })).json.chave.valor;
		for (const [rota, corpo] of [
			["/v1/distribuicao/sincronizar", { ambiente: "producao" }],
			["/v1/distribuicao/consultar-chave", { ambiente: "producao", chaveAcesso: chaveDoFornecedor(1) }],
			["/v1/nfe-recebidas/manifestar", { ambiente: "producao", chaveAcesso: chaveDoFornecedor(1), tipo: "ciencia" }],
		] as const) {
			expect((await cliente("POST", rota, corpo, deTeste)).json.erro.codigo, rota).toBe("chave_somente_homologacao");
		}
		expect(an.chamadas).toHaveLength(0);
		// Filial de outra empresa não entra.
		expect((await configurar({ cnpj: "99888777000166" })).json.error.code).toBe("emitente_divergente");
	});
});

describe("manifestação do destinatário", () => {
	const preparar = async () => {
		const chave = chaveDoFornecedor(101);
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(chave) }];
		an.porChave[chave] = notaCompleta(chave);
		await configurar();
		await sincronizar();
		return { chave, id: (await recebidas()).recebidas[0].id as string };
	};

	it("a ciência assina o evento, manda ao Ambiente Nacional e já traz o XML completo", async () => {
		const { chave, id } = await preparar();
		const r = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ repetido: false, xmlDisponivel: true, papel: "destinatario", manifestacao: { tipo: "ciencia", sequencia: 1, protocolo: "891260000000555", justificativa: null, xmlDisponivel: true } });
		expect(r.json.manifestacao.origem).toMatch(/^chave:chv_/);

		const evento = chamadas("evento")[0] as Chamada;
		expect(evento.url).toBe("https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx");
		expect(evento.corpo).toContain(`<infEvento Id="ID210210${chave}01"><cOrgao>91</cOrgao><tpAmb>2</tpAmb><CNPJ>${CNPJ_TESTE}</CNPJ><chNFe>${chave}</chNFe>`);
		expect(evento.corpo).toContain('<tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento><Signature');
		// O XML veio pela consulta por chave, feita logo depois da ciência.
		expect(chamadas("distribuicao")[1]?.corpo).toContain(`<consChNFe><chNFe>${chave}</chNFe></consChNFe>`);
		expect((await cliente("GET", `/v1/nfe-recebidas/${id}/xml`)).text).toBe(notaCompleta(chave));
		const arquivado = (await cliente("GET", `/v1/nfe-recebidas/${id}/manifestacoes/ciencia/1/xml`)).text;
		expect(arquivado).toMatch(/^<procEventoNFe [^>]*versao="1.00"><evento /);
		expect(arquivado).toContain("<nProt>891260000000555</nProt>");
		expect((await cliente("GET", `/v1/nfe-recebidas/${id}/manifestacoes/confirmacao/1/xml`)).status).toBe(404);
		expect((await cursor()).consultasPorChave).toEqual({ naUltimaHora: 1, limite: 18 });

		// Repetir não envia nada; a ciência não cabe depois de outra manifestação.
		expect((await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" })).json).toMatchObject({ repetido: true });
		expect(chamadas("evento")).toHaveLength(1);
		expect((await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "confirmacao" })).json.manifestacao).toMatchObject({ tipo: "confirmacao", sequencia: 1 });
		const tardia = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect([tardia.status, tardia.json.erro.codigo]).toEqual([409, "manifestacao_ja_registrada"]);
	});

	it("manifestações conclusivas: retificação até duas vezes de cada tipo e justificativa na operação não realizada", async () => {
		const { chave, id } = await preparar();
		const manifestar = (corpo: Json) => cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, corpo);
		expect((await manifestar({ tipo: "nao_realizada" })).json.erro.codigo).toBe("justificativa_obrigatoria");
		expect((await manifestar({ tipo: "nao_realizada", justificativa: "curta" })).status).toBe(400);
		expect((await manifestar({ tipo: "devolucao" })).status).toBe(400);

		const justificativa = "Mercadoria recusada na entrega";
		expect((await manifestar({ tipo: "nao_realizada", justificativa })).json.manifestacao).toMatchObject({ tipo: "nao_realizada", sequencia: 1, justificativa });
		expect(chamadas("evento")[0]?.corpo).toContain(`<descEvento>Operacao nao Realizada</descEvento><xJust>${justificativa}</xJust>`);
		// Retificação: confirma, volta atrás, confirma de novo (sequência 2) e não há terceira.
		expect((await manifestar({ tipo: "confirmacao" })).json.manifestacao.sequencia).toBe(1);
		expect((await manifestar({ tipo: "desconhecimento" })).json.manifestacao.sequencia).toBe(1);
		expect((await manifestar({ tipo: "confirmacao" })).json.manifestacao.sequencia).toBe(2);
		expect(chamadas("evento")[3]?.corpo).toContain(`<infEvento Id="ID210200${chave}02">`);
		await manifestar({ tipo: "desconhecimento" });
		const terceira = await manifestar({ tipo: "confirmacao" });
		expect([terceira.status, terceira.json.erro.codigo]).toEqual([422, "limite_de_manifestacoes"]);
		const nota = (await cliente("GET", `/v1/nfe-recebidas/${id}`)).json;
		expect(nota.manifestacoes.map((m: Json) => `${m.tipo}:${m.sequencia}`)).toEqual(["nao_realizada:1", "confirmacao:1", "desconhecimento:1", "confirmacao:2", "desconhecimento:2"]);
		expect(nota.manifestacao.tipo).toBe("desconhecimento");
	});

	it("rejeição, duplicidade e falta de resposta do Ambiente Nacional", async () => {
		const { id } = await preparar();
		an.evento = (c) => retEvento("596", "Rejeicao: Evento apresentado fora do prazo: 10 dias", c);
		const rejeitada = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect([rejeitada.status, rejeitada.json.erro.codigo, rejeitada.json.mensagens[0].codigo]).toEqual([422, "manifestacao_rejeitada", "596"]);

		an.fora = true;
		const semResposta = await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" });
		expect([semResposta.status, semResposta.json.erro.codigo]).toEqual([502, "sem_resposta_conclusiva"]);
		an.fora = false;
		expect((await cliente("GET", `/v1/nfe-recebidas/${id}`)).json.manifestacoes).toEqual([]);

		// 573: a ciência já estava registrada (pelo portal, por exemplo). Fica anotada, sem XML.
		an.evento = (c) => retEvento("573", "Rejeicao: Duplicidade de Evento", c);
		const duplicada = (await cliente("POST", `/v1/nfe-recebidas/${id}/manifestar`, { tipo: "ciencia" })).json;
		expect(duplicada).toMatchObject({ repetido: true, manifestacao: { tipo: "ciencia", sequencia: 1, protocolo: null, xmlDisponivel: false } });
	});

	it("pela chave de acesso, mesmo de nota que o cofre ainda não recebeu", async () => {
		const chave = chaveDoFornecedor(900);
		const r = await cliente("POST", "/v1/nfe-recebidas/manifestar", { ambiente: "homologacao", chaveAcesso: chave, tipo: "confirmacao" });
		expect(r.status).toBe(200);
		expect(r.json).toMatchObject({ chaveAcesso: chave, cnpj: CNPJ_TESTE, situacao: null, xmlDisponivel: false, numero: 900, emitente: { documento: FORNECEDOR, nome: null }, manifestacao: { tipo: "confirmacao" } });
		// Sem a distribuição configurada, a data do evento sai no horário de Brasília.
		expect(chamadas("evento")[0]?.corpo).toMatch(/<dhEvento>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-03:00<\/dhEvento>/);
		expect(chamadas("distribuicao")).toHaveLength(0);
		// Quando o resumo chega, junta-se à mesma nota.
		an.fila = [{ nsu: 5, schema: "resNFe_v1.01.xsd", xml: resumo(chave) }];
		await configurar();
		expect((await sincronizar()).json).toMatchObject({ documentos: 1, notasNovas: 0 });
		expect((await recebidas()).recebidas).toHaveLength(1);
		expect((await recebidas()).recebidas[0]).toMatchObject({ id: r.json.id, situacao: "autorizada", valor: 1520.75, manifestacao: { tipo: "confirmacao" } });

		const invalida = await cliente("POST", "/v1/nfe-recebidas/manifestar", { ambiente: "homologacao", chaveAcesso: `${chave.slice(0, 43)}${chave[43] === "0" ? "1" : "0"}`, tipo: "ciencia" });
		expect([invalida.status, invalida.json.erro.codigo]).toEqual([422, "chave_de_acesso_invalida"]);
		const outraEmpresa = await cliente("POST", "/v1/nfe-recebidas/manifestar", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(901), tipo: "ciencia", cnpj: "99888777000166" });
		expect(outraEmpresa.json.erro.codigo).toBe("emitente_divergente");
	});
});

describe("consulta por chave e nota completa", () => {
	it("traz a nota de que o titular é terceiro, com XML e DANFE, e respeita o limite por hora", async () => {
		// Uma NF-e de verdade (emitida por este cofre em teste) faz o papel da nota de outra empresa.
		await admin("PUT", "/admin/series", { modelo: "nfe", ambiente: "homologacao", serie: 1 });
		const emitida = (await cliente("POST", "/v1/nfe", EXEMPLO_NFE)).json;
		expect(emitida.situacao).toBe("autorizada");
		const xml = (await cliente("GET", `/v1/nfe/${emitida.id}/xml`)).text;
		an.porChave[emitida.chaveAcesso] = xml;
		await configurar();

		const r = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: emitida.chaveAcesso });
		expect(r.status).toBe(200);
		// O destinatário da nota é outra empresa: o titular só tem acesso ao XML.
		expect(r.json).toMatchObject({ chaveAcesso: emitida.chaveAcesso, papel: "terceiro", xmlDisponivel: true, situacao: "autorizada", valor: 700, emitente: { documento: CNPJ_TESTE } });
		const danfe = await cliente("GET", `/v1/nfe-recebidas/${r.json.id}/danfe`);
		expect([danfe.status, danfe.tipo, danfe.text.slice(0, 5)]).toEqual([200, "application/pdf", "%PDF-"]);
		// Pedir de novo devolve a mesma nota, sem duplicar o documento.
		expect((await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: emitida.chaveAcesso })).json.id).toBe(r.json.id);
		expect((await cliente("GET", "/v1/distribuicao/documentos")).json.documentos).toHaveLength(1);
		// As notas recebidas não entram na lista de notas emitidas do painel.
		expect((await admin("GET", "/admin/notas")).json.notas.map((n: Json) => n.chaveAcesso)).toEqual([emitida.chaveAcesso]);

		const ausente = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(7) });
		expect([ausente.status, ausente.json.erro.codigo, ausente.json.mensagens[0].codigo]).toEqual([422, "nota_nao_localizada", "137"]);
		expect((await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: "123" })).status).toBe(400);

		// Limite: com 18 consultas na última hora, a 19ª nem sai do cofre.
		const agora = Date.now();
		await env.DB.prepare("UPDATE dfe_cursores SET pontuais = ?").bind(JSON.stringify(Array.from({ length: 18 }, (_, i) => agora - i * 1000))).run();
		const antes = chamadas("distribuicao").length;
		const limite = await cliente("POST", "/v1/distribuicao/consultar-chave", { ambiente: "homologacao", chaveAcesso: chaveDoFornecedor(8) });
		expect([limite.status, limite.json.erro.codigo]).toEqual([429, "limite_de_consultas"]);
		expect(chamadas("distribuicao")).toHaveLength(antes);
	});
});

describe("agendador: consulta e ciência automáticas", () => {
	it("desligado não faz nada; ligado, consulta na hora certa e dá ciência só do que cabe", async () => {
		const [nova, antiga, cancelada] = [chaveDoFornecedor(1), chaveDoFornecedor(2), chaveDoFornecedor(3)];
		an.fila = [
			{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(nova) },
			{ nsu: 2, schema: "resNFe_v1.01.xsd", xml: resumo(antiga, { autorizadaEm: dataRecente(30) }) },
			{ nsu: 3, schema: "resNFe_v1.01.xsd", xml: resumo(cancelada, { situacao: "3" }) },
		];
		await configurar();
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(an.chamadas).toHaveLength(0);

		// Consulta automática, sem ciência: baixa e não manifesta.
		await configurar({ consultaAutomatica: true });
		expect(await executarAgendado(env, transporte)).toEqual({ contingencia: null, recebidas: { documentos: 3, notasNovas: 3, cienciasRegistradas: 0 } });
		expect(chamadas("evento")).toHaveLength(0);
		// Dentro da hora de espera o agendador nem abre o certificado.
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(chamadas("distribuicao")).toHaveLength(1);

		// Com a ciência automática ligada, ela sai para a nota nova: não para a antiga
		// (fora do prazo de 10 dias) nem para a cancelada.
		expect((await configurar({ consultaAutomatica: true, cienciaAutomatica: true })).json.distribuicao.cienciaAutomatica).toBe(true);
		expect(await executarAgendado(env, transporte)).toEqual({ contingencia: null, recebidas: { documentos: 0, notasNovas: 0, cienciasRegistradas: 1 } });
		expect(chamadas("evento")).toHaveLength(1);
		expect(chamadas("evento")[0]?.corpo).toContain(`<infEvento Id="ID210210${nova}01">`);
		const notas = (await recebidas()).recebidas as Json[];
		expect(notas.map((n) => [n.numero, n.manifestacao?.tipo ?? null, n.manifestacao?.origem ?? null])).toEqual([[2, null, null], [3, null, null], [1, "ciencia", "agendador"]]);
		// A ciência automática não gasta a cota de consultas por chave: o XML chega pela sequência.
		expect(chamadas("distribuicao")).toHaveLength(1);
		expect(await executarAgendado(env, transporte)).toBeNull();

		// Uma hora depois, o XML liberado pela ciência chega na sequência.
		an.fila.push({ nsu: 4, schema: "procNFe_v4.00.xsd", xml: notaCompleta(nova) });
		await vencerEspera();
		expect(await executarAgendado(env, transporte)).toMatchObject({ recebidas: { documentos: 1, notasNovas: 0, cienciasRegistradas: 0 } });
		expect((await recebidas(`?chaveAcesso=${nova}`)).recebidas[0]).toMatchObject({ xmlDisponivel: true, papel: "destinatario", manifestacao: { tipo: "ciencia" } });
	});

	it("a ciência recusada fica anotada e não é tentada de novo", async () => {
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumo(chaveDoFornecedor(1)) }];
		an.evento = (c) => retEvento("650", "Rejeicao: Evento de Ciencia da Emissao para NF-e Cancelada ou Denegada", c);
		await configurar({ consultaAutomatica: true, cienciaAutomatica: true });
		expect(await executarAgendado(env, transporte)).toMatchObject({ recebidas: { documentos: 1, cienciasRegistradas: 0 } });
		expect((await recebidas()).recebidas[0]).toMatchObject({ manifestacao: null, cienciaAutomaticaRecusada: { codigo: "650" } });
		expect(await executarAgendado(env, transporte)).toBeNull();
		expect(chamadas("evento")).toHaveLength(1);
	});
});

describe("painel: notas recebidas", () => {
	it("mostra o estado, lista as notas, manifesta e baixa os arquivos", async () => {
		const chave = chaveDoFornecedor(101);
		const resumoDaNota = resumo(chave);
		an.fila = [{ nsu: 1, schema: "resNFe_v1.01.xsd", xml: resumoDaNota }];
		an.porChave[chave] = notaCompleta(chave);
		expect((await admin("GET", "/admin/distribuicao")).json).toEqual({ distribuicoes: [], recebidas: [] });
		expect((await admin("POST", "/admin/distribuicao/sincronizar", { ambiente: "homologacao" })).json.error.code).toBe("distribuicao_nao_configurada");
		await configurar();
		expect((await admin("POST", "/admin/distribuicao/sincronizar", { ambiente: "homologacao" })).json).toMatchObject({ consultou: true, notasNovas: 1 });
		expect((await admin("GET", "/admin/distribuicao")).json.recebidas).toEqual([{ environment: "homologacao", total: 1, semXml: 1 }]);

		const nota = (await admin("GET", "/admin/recebidas")).json.recebidas[0];
		expect(nota).toMatchObject({ chaveAcesso: chave, xmlDisponivel: false });
		const resumoBaixado = await admin("GET", `/admin/recebidas/arquivo?id=${nota.id}`);
		expect([resumoBaixado.status, resumoBaixado.res.headers.get("content-disposition"), resumoBaixado.text]).toEqual([200, `attachment; filename="${chave}-resumo.xml"`, resumoDaNota]);
		expect((await admin("GET", `/admin/recebidas/arquivo?id=${nota.id}&tipo=danfe`)).json.error.code).toBe("xml_indisponivel");

		const m = await admin("POST", "/admin/recebidas/manifestar", { id: nota.id, tipo: "ciencia" });
		expect(m.json).toMatchObject({ repetido: false, recebida: { xmlDisponivel: true, manifestacao: { tipo: "ciencia", origem: "admin" } } });
		expect((await admin("GET", `/admin/recebidas/arquivo?id=${nota.id}`)).res.headers.get("content-disposition")).toBe(`attachment; filename="${chave}-nfe.xml"`);
		expect((await admin("POST", "/admin/recebidas/manifestar", { id: "rcb_nao_existe", tipo: "ciencia" })).status).toBe(404);
		expect((await app.request(`${COFRE}/admin/recebidas`, {}, env)).status).toBe(401);
	});
});
