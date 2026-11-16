import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type AppEnv as VaultEnv, createApp as createVault } from "../../../vault/src/app";
import type { Transport } from "../../../vault/src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "../../../vault/test/helpers";
import { createApi } from "../src/app";

const API = "https://api.nfapi.queven.app";
const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";

// O cofre de verdade, com o transporte mTLS simulado (não é usado nestes testes).
const transporte: Transport = {
	transmit: async () => {
		throw new Error("não deveria transmitir nestes testes");
	},
};
const vault = createVault(() => transporte);
const vaultEnv: VaultEnv = { DB: env.VAULT_DB, DOCS: env.VAULT_DOCS, VAULT_SECRET: env.VAULT_SECRET };

let cofreNoAr = true;
/** Faz o papel da internet entre a API e o cofre. */
const vaultFetch: typeof fetch = async (input, init) => {
	if (!cofreNoAr) throw new TypeError("connection refused");
	return vault.request(input as string, init, vaultEnv);
};

const api = createApi({ vaultFetch });

type Json = Record<string, any>;

async function call(method: string, path: string, token?: string, body?: unknown) {
	const headers: Record<string, string> = {};
	if (token) headers.authorization = `Bearer ${token}`;
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await api.request(
		API + path,
		{ method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
		env,
	);
	const text = await res.text();
	return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

const cofreAdmin = (path: string, init: RequestInit = {}) =>
	vault.request(
		COFRE + path,
		{ ...init, headers: { ...init.headers, authorization: `Bearer ${env.VAULT_SECRET}` } },
		vaultEnv,
	);

async function instalarCertificadoNoCofre() {
	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	expect((await cofreAdmin("/admin/certificate", { method: "POST", body: form })).status).toBe(200);
}

async function gerarCodigoDePareamento() {
	const res = await cofreAdmin("/admin/pairings", {
		method: "POST",
		body: JSON.stringify({ label: "API NFapi" }),
	});
	return (await res.json()) as { code: string; pairing: { id: string } };
}

async function criarConta(email = "financeiro@empresa-teste.com.br") {
	const { status, json } = await call("POST", "/admin/contas", env.ADMIN_TOKEN, {
		nome: "Empresa Teste",
		email,
	});
	expect(status).toBe(201);
	return { contaId: json.conta.id as string, chave: json.chave.chave as string, chaveId: json.chave.id as string };
}

beforeEach(async () => {
	cofreNoAr = true;
	await env.DB.batch(["emitters", "api_keys", "accounts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
	await env.VAULT_DB.batch(
		["certificate", "pairing", "nonces", "settings", "audit", "documents"].map((t) =>
			env.VAULT_DB.prepare(`DELETE FROM ${t}`),
		),
	);
});

describe("rotas públicas", () => {
	it("informa a versão e publica o OpenAPI sem as rotas de administração", async () => {
		expect((await call("GET", "/health")).json).toEqual({ ok: true, versao: "0.1.0" });
		expect((await call("GET", "/v1/versao")).json).toEqual({ versao: "0.1.0", protocoloCofre: 1 });

		const { status, json } = await call("GET", "/openapi.json");
		expect(status).toBe(200);
		expect(json.openapi).toBe("3.1.0");
		const paths = Object.keys(json.paths);
		expect(paths).toContain("/v1/emitentes");
		expect(paths).toContain("/v1/emitentes/{id}/verificar");
		expect(paths.some((p) => p.startsWith("/admin"))).toBe(false);
		expect(json.components.securitySchemes.chaveApi.scheme).toBe("bearer");
		expect(json.components.schemas.Emitente).toBeDefined();
	});
});

describe("contas e chaves de API", () => {
	it("só o token de administração cria contas, e e-mail não se repete", async () => {
		const corpo = { nome: "Empresa Teste", email: "a@empresa-teste.com.br" };
		expect((await call("POST", "/admin/contas", undefined, corpo)).status).toBe(401);
		expect((await call("POST", "/admin/contas", "token-errado", corpo)).status).toBe(401);
		expect((await call("POST", "/admin/contas", env.ADMIN_TOKEN, corpo)).status).toBe(201);

		const repetida = await call("POST", "/admin/contas", env.ADMIN_TOKEN, corpo);
		expect(repetida.status).toBe(409);
		expect(repetida.json.erro.codigo).toBe("email_ja_cadastrado");

		const invalida = await call("POST", "/admin/contas", env.ADMIN_TOKEN, { nome: "x", email: "nao-e-email" });
		expect(invalida.status).toBe(400);
	});

	it("autentica pela chave, guarda só o hash e respeita a revogação", async () => {
		const { chave, chaveId } = await criarConta();
		expect(chave).toMatch(/^nfapi_[A-Za-z0-9_-]{43}$/);

		const conta = await call("GET", "/v1/conta", chave);
		expect(conta.status).toBe(200);
		expect(conta.json.conta.email).toBe("financeiro@empresa-teste.com.br");
		expect(conta.json.chaves).toHaveLength(1);
		expect(JSON.stringify(conta.json)).not.toContain(chave);

		const linhas = await env.DB.prepare("SELECT * FROM api_keys").all();
		expect(JSON.stringify(linhas.results)).not.toContain(chave);

		expect((await call("GET", "/v1/conta")).status).toBe(401);
		expect((await call("GET", "/v1/conta", "nfapi_chave-que-nao-existe-000000000000000000000000")).status).toBe(401);

		expect((await call("DELETE", `/admin/chaves/${chaveId}`, env.ADMIN_TOKEN)).status).toBe(200);
		expect((await call("GET", "/v1/conta", chave)).status).toBe(401);
	});
});

describe("emitentes", () => {
	it("conecta o cofre pelo código de pareamento e lê o titular do certificado", async () => {
		const { chave } = await criarConta();
		await instalarCertificadoNoCofre();
		const { code } = await gerarCodigoDePareamento();

		const criado = await call("POST", "/v1/emitentes", chave, { codigoPareamento: code });
		expect(criado.status).toBe(201);
		expect(criado.json.documento).toEqual({ tipo: "cnpj", numero: CNPJ_TESTE });
		expect(criado.json.nome).toBe("EMPRESA TESTE NFAPI LTDA");
		expect(criado.json.cofre).toMatchObject({
			url: COFRE,
			situacao: "ativo",
			producaoLiberada: false,
			protocolo: 1,
		});
		expect(criado.json.certificado.diasRestantes).toBeGreaterThan(0);

		// A chave do pareamento não aparece na resposta nem em claro no banco.
		const chaveHmac = JSON.parse(atob(code.split(".")[1] ?? "")).key as string;
		expect(JSON.stringify(criado.json)).not.toContain(chaveHmac);
		const linha = await env.DB.prepare("SELECT * FROM emitters").first();
		expect(JSON.stringify(linha)).not.toContain(chaveHmac);

		const lista = await call("GET", "/v1/emitentes", chave);
		expect(lista.json.emitentes).toHaveLength(1);
		expect((await call("GET", `/v1/emitentes/${criado.json.id}`, chave)).status).toBe(200);
	});

	it("parear de novo o mesmo CNPJ substitui o pareamento sem duplicar", async () => {
		const { chave } = await criarConta();
		await instalarCertificadoNoCofre();
		const primeiro = await call("POST", "/v1/emitentes", chave, {
			codigoPareamento: (await gerarCodigoDePareamento()).code,
		});
		const segundo = await call("POST", "/v1/emitentes", chave, {
			codigoPareamento: (await gerarCodigoDePareamento()).code,
		});
		expect(segundo.status).toBe(200);
		expect(segundo.json.id).toBe(primeiro.json.id);
		expect((await call("GET", "/v1/emitentes", chave)).json.emitentes).toHaveLength(1);
		expect((await call("POST", `/v1/emitentes/${segundo.json.id}/verificar`, chave)).json.cofre.situacao).toBe("ativo");
	});

	it("explica por que não conectou: código inválido, cofre sem certificado, fora do ar", async () => {
		const { chave } = await criarConta();

		const invalido = await call("POST", "/v1/emitentes", chave, { codigoPareamento: "isto-nao-e-um-codigo-valido" });
		expect(invalido.status).toBe(400);
		expect(invalido.json.erro.codigo).toBe("codigo_invalido");

		const curto = await call("POST", "/v1/emitentes", chave, { codigoPareamento: "x" });
		expect(curto.status).toBe(400);
		expect(curto.json.erro.codigo).toBe("requisicao_invalida");

		// URL interna dentro de um código bem formado: recusada antes de qualquer conexão.
		const interno = `nfapi-cofre-v1.${btoa(JSON.stringify({ v: 1, url: "https://10.0.0.1", id: "a".repeat(32), key: "00".repeat(32) }))}`;
		expect((await call("POST", "/v1/emitentes", chave, { codigoPareamento: interno })).json.erro.codigo).toBe("codigo_invalido");

		const { code } = await gerarCodigoDePareamento();
		const semCert = await call("POST", "/v1/emitentes", chave, { codigoPareamento: code });
		expect(semCert.status).toBe(422);
		expect(semCert.json.erro.codigo).toBe("sem_certificado");

		cofreNoAr = false;
		const fora = await call("POST", "/v1/emitentes", chave, { codigoPareamento: code });
		expect(fora.status).toBe(502);
		expect(fora.json.erro.codigo).toBe("cofre_inacessivel");

		expect((await call("GET", "/v1/emitentes", chave)).json.emitentes).toHaveLength(0);
	});

	it("verificar reflete o que mudou no cofre: produção liberada, queda e revogação", async () => {
		const { chave } = await criarConta();
		await instalarCertificadoNoCofre();
		const { code, pairing } = await gerarCodigoDePareamento();
		const { json: emitente } = await call("POST", "/v1/emitentes", chave, { codigoPareamento: code });
		const verificar = () => call("POST", `/v1/emitentes/${emitente.id}/verificar`, chave);

		await cofreAdmin("/admin/settings", { method: "PUT", body: JSON.stringify({ allowProduction: true }) });
		expect((await verificar()).json.cofre.producaoLiberada).toBe(true);

		cofreNoAr = false;
		expect((await verificar()).json.cofre.situacao).toBe("inacessivel");
		cofreNoAr = true;

		await cofreAdmin(`/admin/pairings/${pairing.id}`, { method: "DELETE" });
		const revogado = await verificar();
		expect(revogado.status).toBe(200);
		expect(revogado.json.cofre.situacao).toBe("pareamento_recusado");
		// Os dados do certificado continuam os últimos conhecidos.
		expect(revogado.json.documento.numero).toBe(CNPJ_TESTE);
	});

	it("isola os emitentes por conta e permite desconectar", async () => {
		const dona = await criarConta("dona@empresa-teste.com.br");
		const outra = await criarConta("outra@empresa-teste.com.br");
		await instalarCertificadoNoCofre();
		const { json: emitente } = await call("POST", "/v1/emitentes", dona.chave, {
			codigoPareamento: (await gerarCodigoDePareamento()).code,
		});

		expect((await call("GET", `/v1/emitentes/${emitente.id}`, outra.chave)).status).toBe(404);
		expect((await call("POST", `/v1/emitentes/${emitente.id}/verificar`, outra.chave)).status).toBe(404);
		expect((await call("DELETE", `/v1/emitentes/${emitente.id}`, outra.chave)).status).toBe(404);
		expect((await call("GET", "/v1/emitentes", outra.chave)).json.emitentes).toHaveLength(0);

		expect((await call("GET", "/v1/emitentes/id-malformado", dona.chave)).status).toBe(400);
		expect((await call("DELETE", `/v1/emitentes/${emitente.id}`, dona.chave)).status).toBe(204);
		expect((await call("GET", `/v1/emitentes/${emitente.id}`, dona.chave)).status).toBe(404);
	});
});

describe("administração de contas e cofres (painel)", () => {
	it("o administrador conecta o cofre em nome da conta e gerencia o emitente", async () => {
		const { contaId, chave } = await criarConta();
		await instalarCertificadoNoCofre();
		const { code } = await gerarCodigoDePareamento();
		const corpo = { codigoPareamento: code };

		// Só o token de administração; a chave de API da conta não serve em /admin.
		expect((await call("POST", `/admin/contas/${contaId}/emitentes`, undefined, corpo)).status).toBe(401);
		expect((await call("POST", `/admin/contas/${contaId}/emitentes`, chave, corpo)).status).toBe(401);

		const conectado = await call("POST", `/admin/contas/${contaId}/emitentes`, env.ADMIN_TOKEN, corpo);
		expect(conectado.status).toBe(201);
		expect(conectado.json.emitente).toMatchObject({
			documento: { tipo: "cnpj", numero: CNPJ_TESTE },
			cofre: { url: COFRE, situacao: "ativo" },
		});
		const id = conectado.json.emitente.id as string;

		const detalhe = await call("GET", `/admin/contas/${contaId}`, env.ADMIN_TOKEN);
		expect(detalhe.json.chaves).toHaveLength(1);
		expect(detalhe.json.emitentes.map((e: Json) => e.id)).toEqual([id]);
		// O detalhe nunca devolve o valor da chave de API.
		expect(JSON.stringify(detalhe.json)).not.toContain(chave);

		// O emitente conectado pelo admin é o mesmo que a conta enxerga pela API.
		expect((await call("GET", "/v1/emitentes", chave)).json.emitentes.map((e: Json) => e.id)).toEqual([id]);

		const verificado = await call("POST", `/admin/emitentes/${id}/verificar`, env.ADMIN_TOKEN);
		expect(verificado.json.emitente.cofre.situacao).toBe("ativo");

		expect((await call("DELETE", `/admin/emitentes/${id}`, env.ADMIN_TOKEN)).status).toBe(200);
		expect((await call("GET", `/admin/contas/${contaId}`, env.ADMIN_TOKEN)).json.emitentes).toHaveLength(0);
		expect((await call("DELETE", `/admin/emitentes/${id}`, env.ADMIN_TOKEN)).status).toBe(404);
	});

	it("explica falhas de conexão e recusa contas inexistentes", async () => {
		const { contaId } = await criarConta();
		const rota = `/admin/contas/${contaId}/emitentes`;

		expect((await call("POST", rota, env.ADMIN_TOKEN, {})).status).toBe(400);
		const invalido = await call("POST", rota, env.ADMIN_TOKEN, { codigoPareamento: "isto-nao-e-um-codigo-valido" });
		expect(invalido.json.erro.codigo).toBe("codigo_invalido");

		// Cofre sem certificado: o erro diz o que falta fazer.
		const { code } = await gerarCodigoDePareamento();
		const semCert = await call("POST", rota, env.ADMIN_TOKEN, { codigoPareamento: code });
		expect(semCert.status).toBe(422);
		expect(semCert.json.erro.codigo).toBe("sem_certificado");

		const outraConta = `/admin/contas/cta_${"0".repeat(20)}`;
		expect((await call("GET", outraConta, env.ADMIN_TOKEN)).status).toBe(404);
		expect((await call("POST", `${outraConta}/emitentes`, env.ADMIN_TOKEN, { codigoPareamento: code })).status).toBe(404);
	});
});
