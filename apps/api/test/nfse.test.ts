import { env } from "cloudflare:test";
import { gunzipBase64, gzipBase64 } from "@nfapi/nfse-nacional";
import { beforeEach, describe, expect, it } from "vitest";
import { type AppEnv as VaultEnv, createApp as createVault } from "../../../vault/src/app";
import type { TransmitRequest } from "../../../vault/src/protocol";
import { type Transport, TransportError, type TransportResult } from "../../../vault/src/transport";
import { CNPJ_TESTE, SENHA_TESTE, pfxModerno } from "../../../vault/test/helpers";
import { createApi } from "../src/app";

const API = "https://api.nfapi.queven.app";
const COFRE = "https://nfapi-cofre.empresa-teste.workers.dev";
const CHAVE = `35${"0".repeat(46)}77`;
const NFSE_XML = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${CHAVE}"><nNFSe>77</nNFSe><xLocEmi>São Paulo</xLocEmi></infNFSe></NFSe>`;

type Resposta = { status: number; corpo: unknown };

/** Faz o papel da SEFIN Nacional atrás do transporte mTLS do cofre. */
const sefin = {
	chamadas: [] as TransmitRequest[],
	responder: (async () => ({ status: 500, corpo: {} })) as (req: TransmitRequest) => Promise<Resposta>,
};

const autorizar = async (): Promise<Resposta> => ({
	status: 201,
	corpo: { tipoAmbiente: 2, idDps: "DPS", chaveAcesso: CHAVE, nfseXmlGZipB64: await gzipBase64(NFSE_XML), alertas: [] },
});

const transporte: Transport = {
	async transmit(request): Promise<TransportResult> {
		sefin.chamadas.push(request);
		const { status, corpo } = await sefin.responder(request);
		const bytes = new TextEncoder().encode(typeof corpo === "string" ? corpo : JSON.stringify(corpo));
		return {
			status,
			headers: { "content-type": "application/json" },
			bodyB64: btoa(String.fromCharCode(...bytes)),
			tls: { protocol: "TLSv1.2", cipher: "TESTE", peerIssuer: "AC TESTE" },
			ms: 5,
		};
	},
};

const vault = createVault(() => transporte);
const vaultEnv: VaultEnv = { DB: env.VAULT_DB, DOCS: env.VAULT_DOCS, VAULT_SECRET: env.VAULT_SECRET };
const api = createApi({ vaultFetch: async (input, init) => vault.request(input as string, init, vaultEnv) });

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
	const isJson = (res.headers.get("content-type") ?? "").includes("json");
	return { status: res.status, json: (isJson && text ? JSON.parse(text) : null) as Json, text };
}

const cofreAdmin = (path: string, init: RequestInit = {}) =>
	vault.request(
		COFRE + path,
		{ ...init, headers: { ...init.headers, authorization: `Bearer ${env.VAULT_SECRET}` } },
		vaultEnv,
	);

let chave: string;
let emitente: string;

beforeEach(async () => {
	sefin.chamadas = [];
	sefin.responder = autorizar;
	await env.DB.batch(
		["emissions", "series", "emitters", "api_keys", "accounts"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
	);
	await env.VAULT_DB.batch(
		["certificate", "pairing", "nonces", "settings", "audit", "documents"].map((t) =>
			env.VAULT_DB.prepare(`DELETE FROM ${t}`),
		),
	);

	const conta = await call("POST", "/admin/contas", env.ADMIN_TOKEN, {
		nome: "Empresa Teste",
		email: "fiscal@empresa-teste.com.br",
	});
	chave = conta.json.chave.chave;

	const form = new FormData();
	form.append("pfx", new File([pfxModerno()], "a1.pfx"));
	form.append("password", SENHA_TESTE);
	await cofreAdmin("/admin/certificate", { method: "POST", body: form });
	const pareamento = await cofreAdmin("/admin/pairings", { method: "POST", body: "{}" });
	const { code } = (await pareamento.json()) as { code: string };
	emitente = (await call("POST", "/v1/emitentes", chave, { codigoPareamento: code })).json.id;
});

const pedido = (extra: Json = {}) => ({
	emitente,
	prestador: {
		codigoMunicipio: "3550308",
		regimeTributario: { simplesNacional: "me_epp", apuracaoSimples: 1 },
	},
	tomador: { cnpj: "99888777000166", nome: "Cliente Ltda" },
	servico: {
		codigoMunicipioPrestacao: "3550308",
		codigoTributacaoNacional: "010701",
		descricao: "Suporte técnico em informática",
	},
	valores: { servico: 1500 },
	tributacao: { issqn: { aliquota: 2 }, totalTributos: { tipo: "percentual_simples", percentual: 6 } },
	...extra,
});

const emitir = (extra: Json = {}) => call("POST", "/v1/nfse", chave, pedido(extra));

/** Abre o corpo enviado à SEFIN e devolve a DPS assinada. */
async function dpsEnviada(chamada: TransmitRequest | undefined): Promise<string> {
	const corpo = JSON.parse(atob(chamada?.bodyB64 ?? "")) as { dpsXmlGZipB64: string };
	return gunzipBase64(corpo.dpsXmlGZipB64);
}

const envios = () => sefin.chamadas.filter((c) => c.method === "POST");

describe("emissão de NFS-e", () => {
	it("monta, assina, transmite e arquiva a nota em homologação", async () => {
		const { status, json } = await emitir();
		expect(status).toBe(201);
		expect(json).toMatchObject({
			emitente,
			ambiente: "homologacao",
			situacao: "autorizada",
			serie: "1",
			numero: 1,
			chaveAcesso: CHAVE,
			numeroNfse: "77",
			xmlDisponivel: true,
			idDps: `DPS35503082${CNPJ_TESTE}00001000000000000001`,
		});

		// O que saiu para o governo: ambiente de testes, leiaute da NT 009, assinado.
		expect(envios()).toHaveLength(1);
		expect(envios()[0]?.url).toBe("https://sefin.producaorestrita.nfse.gov.br/SefinNacional/nfse");
		const dps = await dpsEnviada(envios()[0]);
		expect(dps).toContain("<tpAmb>2</tpAmb>");
		expect(dps).toContain("<finNFSe>0</finNFSe>");
		expect(dps).toContain(`<prest><CNPJ>${CNPJ_TESTE}</CNPJ>`);
		expect(dps).toContain("<verAplic>NFapi-0.1.0</verAplic>");
		expect(dps).toContain("xmldsig-more#rsa-sha256");
		expect(dps).toMatch(/<\/infDPS><Signature /);

		// O XML fica no cofre do emitente e a API o devolve sob demanda.
		const xml = await call("GET", `/v1/nfse/${json.id}/xml`, chave);
		expect(xml.status).toBe(200);
		expect(xml.text).toBe(NFSE_XML);
		const docs = await env.VAULT_DB.prepare("SELECT key FROM documents ORDER BY key").all<{ key: string }>();
		expect(docs.results.map((d) => d.key.split("/").pop())).toEqual([`${CHAVE}-dps.xml`, `${CHAVE}-nfse.xml`]);

		// A API não guarda XML.
		const linha = await env.DB.prepare("SELECT * FROM emissions").first();
		expect(JSON.stringify(linha)).not.toContain("<");

		expect((await call("GET", `/v1/nfse/${json.id}`, chave)).json.situacao).toBe("autorizada");
		expect((await emitir()).json.numero).toBe(2);
		expect((await call("GET", "/v1/nfse", chave)).json.nfse).toHaveLength(2);
	});

	it("a mesma referência nunca gera duas notas", async () => {
		const primeira = await emitir({ referencia: "pedido-1001" });
		const repetida = await emitir({ referencia: "pedido-1001" });
		expect(primeira.status).toBe(201);
		expect(repetida.status).toBe(200);
		expect(repetida.json.id).toBe(primeira.json.id);
		expect(envios()).toHaveLength(1);
	});

	it("devolve as rejeições da SEFIN e reaproveita o número na nova tentativa", async () => {
		sefin.responder = async () => ({
			status: 400,
			corpo: { erros: [{ Codigo: "E0312", Descricao: "Código de tributação nacional inválido", Complemento: "cTribNac" }] },
		});
		const recusada = await emitir({ referencia: "pedido-7" });
		expect(recusada.status).toBe(422);
		expect(recusada.json.erro.codigo).toBe("nfse_rejeitada");
		expect(recusada.json.nfse).toMatchObject({
			situacao: "rejeitada",
			numero: 1,
			mensagens: [{ codigo: "E0312", complemento: "cTribNac" }],
		});

		sefin.responder = autorizar;
		const corrigida = await emitir({ referencia: "pedido-7" });
		expect(corrigida.status).toBe(201);
		expect(corrigida.json.id).toBe(recusada.json.nfse.id);
		expect(corrigida.json.numero).toBe(1);
	});

	it("produção só sai depois que o emitente libera no cofre", async () => {
		const bloqueada = await emitir({ ambiente: "producao", referencia: "prod-1" });
		expect(bloqueada.status).toBe(422);
		expect(bloqueada.json.erro.codigo).toBe("producao_bloqueada");
		expect(bloqueada.json.nfse.situacao).toBe("erro");
		expect(sefin.chamadas).toHaveLength(0);

		await cofreAdmin("/admin/settings", { method: "PUT", body: JSON.stringify({ allowProduction: true }) });
		const liberada = await emitir({ ambiente: "producao", referencia: "prod-1" });
		expect(liberada.status).toBe(201);
		expect(envios()[0]?.url).toBe("https://sefin.nfse.gov.br/SefinNacional/nfse");
		const dps = await dpsEnviada(envios()[0]);
		expect(dps).toContain("<tpAmb>1</tpAmb>");
		expect(dps).not.toContain("finNFSe");
		// Produção e homologação têm numerações independentes.
		expect(liberada.json.numero).toBe(1);
		expect((await emitir()).json.numero).toBe(1);
	});

	it("sem resposta do governo, a retomada descobre se a nota já existe antes de reenviar", async () => {
		sefin.responder = async () => {
			throw new TransportError(504, "tempo_esgotado", "Sem resposta em 60000 ms.");
		};
		const perdida = await emitir({ referencia: "pedido-9" });
		expect(perdida.status).toBe(502);
		expect(perdida.json.nfse.situacao).toBe("indefinida");
		const idDps = perdida.json.nfse.idDps as string;

		// A nota tinha sido gerada: a API recupera pela consulta da DPS, sem novo POST.
		sefin.chamadas = [];
		sefin.responder = async (req) =>
			req.url.endsWith(`/dps/${idDps}`)
				? { status: 200, corpo: { chaveAcesso: CHAVE } }
				: { status: 200, corpo: { chaveAcesso: CHAVE, nfseXmlGZipB64: await gzipBase64(NFSE_XML) } };
		const recuperada = await emitir({ referencia: "pedido-9" });
		expect(recuperada.status).toBe(201);
		expect(recuperada.json).toMatchObject({ id: perdida.json.nfse.id, situacao: "autorizada", chaveAcesso: CHAVE });
		expect(envios()).toHaveLength(0);
		expect(sefin.chamadas.map((c) => c.method)).toEqual(["GET", "GET"]);
	});

	it("se a SEFIN não conhece a DPS, a retomada reenvia com o mesmo número", async () => {
		sefin.responder = async () => ({ status: 503, corpo: "<html>indisponível</html>" });
		const perdida = await emitir({ referencia: "pedido-10" });
		expect(perdida.status).toBe(502);

		sefin.chamadas = [];
		sefin.responder = async (req) => (req.method === "GET" ? { status: 404, corpo: {} } : autorizar());
		const reenviada = await emitir({ referencia: "pedido-10" });
		expect(reenviada.status).toBe(201);
		expect(reenviada.json.numero).toBe(perdida.json.nfse.numero);
		expect(sefin.chamadas.map((c) => c.method)).toEqual(["GET", "POST"]);
	});

	it("valida o pedido, o emitente e o número antes de qualquer transmissão", async () => {
		const invalido = await emitir({ valores: { servico: -5 } });
		expect(invalido.status).toBe(400);
		expect(invalido.json.erro.codigo).toBe("requisicao_invalida");

		const semEmitente = await emitir({ emitente: `emi_${"0".repeat(20)}` });
		expect(semEmitente.status).toBe(404);

		expect((await emitir({ numero: 500 })).status).toBe(201);
		const duplicado = await emitir({ numero: 500 });
		expect(duplicado.status).toBe(409);
		expect(duplicado.json.erro.codigo).toBe("numero_ja_utilizado");
		// A numeração automática continua depois do número informado.
		expect((await emitir()).json.numero).toBe(501);

		expect((await call("POST", "/v1/nfse", undefined, pedido())).status).toBe(401);
		expect(envios()).toHaveLength(2);
	});
});
