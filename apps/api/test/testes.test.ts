import { env } from "cloudflare:test";
import { gzipBase64 } from "@nfapi/nfse-nacional";
import { beforeEach, describe, expect, it } from "vitest";
import { type AppEnv as VaultEnv, createApp as createVault } from "../../../vault/src/app";
import type { TransmitRequest } from "../../../vault/src/protocol";
import type { Transport, TransportResult } from "../../../vault/src/transport";
import { SENHA_TESTE, pfxModerno } from "../../../vault/test/helpers";
import { createApi } from "../src/app";

const API = "https://api.nfapi.queven.app";
const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";
const CHAVE = `35${"0".repeat(46)}88`;
const TESTES_TOKEN = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

/** Governo simulado: SEFIN Nacional (JSON) e SEFAZ (SOAP de status). */
const governo = {
	chamadas: [] as TransmitRequest[],
	cStat: "107",
	rejeitarNfse: false,
};

const transporte: Transport = {
	async transmit(request): Promise<TransportResult> {
		governo.chamadas.push(request);
		let status = 200;
		let corpo: string;
		if (/statusservico/i.test(request.url)) {
			corpo = `<retConsStatServ><cStat>${governo.cStat}</cStat><xMotivo>${governo.cStat === "107" ? "Servico em Operacao" : "Servico Paralisado"}</xMotivo></retConsStatServ>`;
		} else if (governo.rejeitarNfse) {
			status = 400;
			corpo = JSON.stringify({ erros: [{ Codigo: "E0312", Descricao: "Código de tributação inválido" }] });
		} else {
			status = 201;
			corpo = JSON.stringify({
				chaveAcesso: CHAVE,
				nfseXmlGZipB64: await gzipBase64(`<NFSe><infNFSe Id="NFS${CHAVE}"><nNFSe>9</nNFSe></infNFSe></NFSe>`),
			});
		}
		const bytes = new TextEncoder().encode(corpo);
		return {
			status,
			headers: {},
			bodyB64: btoa(String.fromCharCode(...bytes)),
			tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" },
			ms: 5,
		};
	},
};

const vault = createVault(() => transporte);
const vaultEnv: VaultEnv = { DB: env.VAULT_DB, DOCS: env.VAULT_DOCS, VAULT_SECRET: env.VAULT_SECRET };
const api = createApi({ vaultFetch: async (input, init) => vault.request(input as string, init, vaultEnv) });
const apiEnv = { ...env, TESTES_TOKEN };

type Json = Record<string, any>;

async function call(method: string, path: string, token?: string, body?: unknown) {
	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await api.request(
		API + path,
		{ method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
		apiEnv,
	);
	const text = await res.text();
	const isJson = (res.headers.get("content-type") ?? "").includes("json");
	return { status: res.status, json: (isJson && text ? JSON.parse(text) : null) as Json, text, headers: res.headers };
}

const cofreAdmin = (path: string, init: RequestInit = {}) =>
	vault.request(
		COFRE + path,
		{ ...init, headers: { ...init.headers, authorization: `Bearer ${env.VAULT_SECRET}` } },
		vaultEnv,
	);

let emitente: string;
const PERFIL = { codigoMunicipio: "3550308", codigoTributacaoNacional: "010701", simplesNacional: "me_epp", apuracaoSimples: 1 };

beforeEach(async () => {
	governo.chamadas = [];
	governo.cStat = "107";
	governo.rejeitarNfse = false;
	await env.DB.batch(
		["test_runs", "test_profiles", "emissions", "series", "emitters", "api_keys", "accounts"].map((t) =>
			env.DB.prepare(`DELETE FROM ${t}`),
		),
	);
	await env.VAULT_DB.batch(
		["certificate", "pairing", "nonces", "settings", "audit", "documents"].map((t) =>
			env.VAULT_DB.prepare(`DELETE FROM ${t}`),
		),
	);
	const conta = await call("POST", "/admin/contas", env.ADMIN_TOKEN, { nome: "Conta de Teste", email: "t@empresa-teste.com.br" });
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	await cofreAdmin("/admin/certificate", { method: "POST", body: form });
	const pareamento = await cofreAdmin("/admin/pairings", { method: "POST", body: "{}" });
	const { code } = (await pareamento.json()) as { code: string };
	emitente = (await call("POST", "/v1/emitentes", conta.json.chave.chave, { codigoPareamento: code })).json.id;
});

const executar = (token: string, cenarios?: string[]) =>
	call("POST", "/admin/testes/execucoes", token, { emitente, ...(cenarios ? { cenarios } : {}) });

describe("testes de homologação no admin", () => {
	it("lista os cenários de NFS-e, NF-e e NFC-e e os emitentes com seus perfis", async () => {
		const { status, json } = await call("GET", "/admin/testes", env.ADMIN_TOKEN);
		expect(status).toBe(200);
		expect(json.ambiente).toBe("homologacao");
		expect(json.cenarios.map((c: Json) => c.id)).toEqual([
			"cofre.conexao",
			"nfse.emitir",
			"nfe.status",
			"nfe.emitir",
			"nfce.status",
			"nfce.emitir",
		]);
		// O que ainda não existe aparece como indisponível, com o motivo.
		const nfe = json.cenarios.find((c: Json) => c.id === "nfe.emitir");
		expect(nfe.disponivel).toBe(false);
		expect(nfe.motivo).toContain("Fase 3");
		expect(json.emitentes).toHaveLength(1);
		expect(json.emitentes[0]).toMatchObject({ id: emitente, perfil: null, conta: { nome: "Conta de Teste" } });
	});

	it("executa todos os cenários disponíveis, sempre em homologação", async () => {
		expect((await call("PUT", `/admin/testes/perfis/${emitente}`, env.ADMIN_TOKEN, PERFIL)).status).toBe(200);

		const { status, json } = await executar(env.ADMIN_TOKEN);
		expect(status).toBe(200);
		expect(json.aprovado).toBe(true);
		expect(json.execucoes.map((e: Json) => [e.cenario, e.resultado, e.origem])).toEqual([
			["cofre.conexao", "aprovado", "admin"],
			["nfse.emitir", "aprovado", "admin"],
			["nfe.status", "aprovado", "admin"],
			["nfce.status", "aprovado", "admin"],
		]);
		const nfse = json.execucoes[1];
		expect(nfse.detalhes).toMatchObject({ serie: "900", numero: 1, chaveAcesso: CHAVE, situacao: "autorizada" });

		// Nada saiu para endereços de produção.
		const urls = governo.chamadas.map((c) => c.url);
		expect(urls).toEqual([
			"https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse",
			"https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx",
			"https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx",
		]);
		// A consulta de status usa a UF do município do perfil.
		expect(atob(governo.chamadas[1]?.bodyB64 ?? "")).toContain("<tpAmb>2</tpAmb><cUF>35</cUF>");

		// A nota de teste usa a série reservada e não consome a numeração da série 1.
		const emissao = await env.DB.prepare("SELECT serie, environment, reference FROM emissions").first<Json>();
		expect(emissao).toMatchObject({ serie: "900", environment: "homologacao" });
		expect(emissao?.reference).toMatch(/^teste-tst_/);
	});

	it("distingue reprovado (resposta do governo) de erro (falta de configuração)", async () => {
		// Sem perfil: os cenários fiscais não rodam, mas a conexão com o cofre sim.
		const semPerfil = await executar(env.ADMIN_TOKEN, ["cofre.conexao", "nfse.emitir"]);
		expect(semPerfil.json.aprovado).toBe(false);
		expect(semPerfil.json.execucoes.map((e: Json) => e.resultado)).toEqual(["aprovado", "erro"]);
		expect(semPerfil.json.execucoes[1].resumo).toContain("perfil de teste");
		expect(governo.chamadas).toHaveLength(0);

		await call("PUT", `/admin/testes/perfis/${emitente}`, env.ADMIN_TOKEN, PERFIL);
		governo.rejeitarNfse = true;
		governo.cStat = "108";
		const { json } = await executar(env.ADMIN_TOKEN, ["nfse.emitir", "nfe.status", "nfe.emitir"]);
		expect(json.execucoes.map((e: Json) => e.resultado)).toEqual(["reprovado", "reprovado", "erro"]);
		expect(json.execucoes[0].resumo).toContain("E0312");
		expect(json.execucoes[1].resumo).toContain("cStat 108");
		expect(json.execucoes[2].resumo).toContain("Fase 3");
	});

	it("UF sem autorizador mapeado vira erro explicado, sem transmitir", async () => {
		await call("PUT", `/admin/testes/perfis/${emitente}`, env.ADMIN_TOKEN, { ...PERFIL, codigoMunicipio: "4314902" });
		const { json } = await executar(env.ADMIN_TOKEN, ["nfe.status"]);
		expect(json.execucoes[0]).toMatchObject({ resultado: "erro" });
		expect(json.execucoes[0].resumo).toContain("UF 43");
		expect(governo.chamadas).toHaveLength(0);
	});

	it("a IA executa e consulta com um token de escopo reduzido", async () => {
		await call("PUT", `/admin/testes/perfis/${emitente}`, env.ADMIN_TOKEN, PERFIL);

		const pelaIa = await executar(TESTES_TOKEN, ["cofre.conexao", "nfse.emitir"]);
		expect(pelaIa.status).toBe(200);
		expect(pelaIa.json.execucoes.every((e: Json) => e.origem === "ia")).toBe(true);
		expect((await call("GET", "/admin/testes", TESTES_TOKEN)).status).toBe(200);

		// Fora dos testes, o token da IA não vale nada.
		expect((await call("GET", "/admin/contas", TESTES_TOKEN)).status).toBe(401);
		expect((await call("POST", "/admin/contas", TESTES_TOKEN, { nome: "X", email: "x@x.com" })).status).toBe(401);
		expect((await call("PUT", `/admin/testes/perfis/${emitente}`, TESTES_TOKEN, PERFIL)).status).toBe(401);
		expect((await call("GET", "/v1/conta", TESTES_TOKEN)).status).toBe(401);

		const historico = await call("GET", "/admin/testes/execucoes", env.ADMIN_TOKEN);
		expect(historico.json.execucoes).toHaveLength(2);
		expect(historico.json.execucoes[0]).toMatchObject({ origem: "ia", nomeEmitente: "EMPRESA TESTE NFAPI LTDA" });
		expect(JSON.stringify(historico.json)).not.toContain("<");
	});

	it("exige autenticação e valida a entrada", async () => {
		expect((await call("GET", "/admin/testes")).status).toBe(401);
		expect((await executar("token-errado")).status).toBe(401);
		expect((await executar(env.ADMIN_TOKEN, ["cenario.inexistente"])).json.erro.codigo).toBe("cenario_desconhecido");
		const semEmitente = await call("POST", "/admin/testes/execucoes", env.ADMIN_TOKEN, { emitente: `emi_${"0".repeat(20)}` });
		expect(semEmitente.status).toBe(404);
		const perfilRuim = await call("PUT", `/admin/testes/perfis/${emitente}`, env.ADMIN_TOKEN, { ...PERFIL, codigoMunicipio: "123" });
		expect(perfilRuim.status).toBe(400);
	});

	it("serve a página do painel com política de segurança restrita", async () => {
		const pagina = await call("GET", "/painel");
		expect(pagina.status).toBe(200);
		expect(pagina.headers.get("content-security-policy")).toContain("script-src 'self'");
		expect(pagina.text).toContain("Testes de homologação");
		expect((await call("GET", "/painel/app.js")).text).toContain("/admin/testes/execucoes");

		const raizAdmin = await api.request("https://admin.nfapi.queven.app/", { redirect: "manual" }, apiEnv);
		expect(raizAdmin.status).toBe(302);
		expect(raizAdmin.headers.get("location")).toBe("/painel");
	});
});
