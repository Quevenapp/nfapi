// API central do NFapi.
//
//   /admin/*  -> operação da plataforma (ADMIN_TOKEN): contas e chaves de API
//   /v1/*     -> clientes (chave de API): conta e emitentes
//
// A API não guarda certificado nem XML: cada emitente tem um cofre na própria
// conta Cloudflare, e aqui fica só o pareamento com ele.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
	type HealthResponse,
	PROTOCOL_VERSION,
	VaultClient,
	VaultError,
	decodePairingCode,
	fromHex,
} from "@nfapi/vault-client";
import type { Context } from "hono";
import {
	hashApiKey,
	looksLikeApiKey,
	newApiKey,
	newId,
	open,
	safeEqual,
	seal,
	secretIsStrong,
} from "./crypto";
import * as db from "./db";

export const API_VERSION = "0.1.0";

export interface ApiEnv {
	DB: D1Database;
	MASTER_KEY: string;
	ADMIN_TOKEN: string;
}

export interface ApiDeps {
	/** Como alcançar os cofres. Trocado nos testes; em produção é o fetch global. */
	vaultFetch?: typeof fetch;
}

type Ctx = { Bindings: ApiEnv; Variables: { account: db.Account } };
type C = Context<Ctx>;

// ---------- Esquemas (também geram o OpenAPI) ----------

const Erro = z
	.object({
		erro: z.object({
			codigo: z.string().openapi({ example: "nao_autenticado" }),
			mensagem: z.string(),
		}),
	})
	.openapi("Erro");

const Conta = z
	.object({
		id: z.string().openapi({ example: "cta_3f9a1c0b7d2e4a5f6b8c" }),
		nome: z.string(),
		email: z.string(),
		situacao: z.string().openapi({ example: "ativa" }),
		criadaEm: z.string().openapi({ format: "date-time" }),
	})
	.openapi("Conta");

const ChaveApi = z
	.object({
		id: z.string(),
		nome: z.string(),
		prefixo: z.string().openapi({ description: "Início da chave, para identificá-la em listagens." }),
		criadaEm: z.string(),
		ultimoUso: z.string().nullable(),
		revogadaEm: z.string().nullable(),
	})
	.openapi("ChaveApi");

const Emitente = z
	.object({
		id: z.string().openapi({ example: "emi_8b1d4e7a2c9f0a3b5d6e" }),
		documento: z.object({ tipo: z.enum(["cnpj", "cpf"]), numero: z.string() }),
		nome: z.string(),
		cofre: z.object({
			url: z.string(),
			versao: z.string(),
			protocolo: z.number(),
			producaoLiberada: z.boolean().openapi({
				description: "Enquanto for falso, o cofre só assina documentos de homologação.",
			}),
			situacao: z.enum([
				"ativo",
				"inacessivel",
				"pareamento_recusado",
				"sem_certificado",
				"certificado_vencido",
				"cofre_desatualizado",
			]),
			detalhe: z.string(),
			verificadoEm: z.string(),
		}),
		certificado: z.object({
			emissor: z.string(),
			validoAte: z.string(),
			diasRestantes: z.number(),
		}),
		criadoEm: z.string(),
	})
	.openapi("Emitente");

const iso = (ms: number) => new Date(ms).toISOString();

const contaJson = (a: db.Account): z.infer<typeof Conta> => ({
	id: a.id,
	nome: a.name,
	email: a.email,
	situacao: a.status,
	criadaEm: iso(a.createdAt),
});

const chaveJson = (k: db.ApiKey): z.infer<typeof ChaveApi> => ({
	id: k.id,
	nome: k.name,
	prefixo: k.prefix,
	criadaEm: iso(k.createdAt),
	ultimoUso: k.lastUsedAt ? iso(k.lastUsedAt) : null,
	revogadaEm: k.revokedAt ? iso(k.revokedAt) : null,
});

const emitenteJson = (e: db.Emitter): z.infer<typeof Emitente> => ({
	id: e.id,
	documento: { tipo: e.docKind, numero: e.docId },
	nome: e.name,
	cofre: {
		url: e.vaultUrl,
		versao: e.vaultVersion,
		protocolo: e.vaultProtocol,
		producaoLiberada: e.allowProduction,
		situacao: e.status,
		detalhe: e.statusDetail,
		verificadoEm: iso(e.checkedAt),
	},
	certificado: {
		emissor: e.certIssuer,
		validoAte: iso(e.certNotAfter),
		diasRestantes: Math.floor((e.certNotAfter - Date.now()) / 86_400_000),
	},
	criadoEm: iso(e.createdAt),
});

type Status = 400 | 401 | 404 | 409 | 422 | 500 | 502 | 503;

function erro<S extends Status>(c: C, status: S, codigo: string, mensagem: string) {
	return c.json({ erro: { codigo, mensagem } }, status);
}

const json = <T extends z.ZodType>(schema: T, description: string) => ({
	description,
	content: { "application/json": { schema } },
});
const erros = {
	400: json(Erro, "Requisição inválida."),
	401: json(Erro, "Chave de API ausente, inválida ou revogada."),
	404: json(Erro, "Recurso inexistente nesta conta."),
} as const;
const security = [{ chaveApi: [] }];

// ---------- Conversa com o cofre ----------

interface Inspection {
	status: db.EmitterStatus;
	detail: string;
	health?: HealthResponse;
}

/** Consulta o cofre e traduz o resultado para a situação do emitente. */
async function inspectVault(client: VaultClient, expectedDoc?: string): Promise<Inspection> {
	let health: HealthResponse;
	try {
		health = await client.health();
	} catch (err) {
		if (!(err instanceof VaultError)) throw err;
		return err.status === 401
			? { status: "pareamento_recusado", detail: "O cofre recusou o pareamento (revogado ou inválido)." }
			: { status: "inacessivel", detail: err.message };
	}
	if (health.protocol !== PROTOCOL_VERSION) {
		return {
			status: "cofre_desatualizado",
			detail: `O cofre usa o protocolo ${health.protocol}; esta API usa o ${PROTOCOL_VERSION}. Atualize o cofre.`,
			health,
		};
	}
	const cert = health.certificate;
	if (!cert) {
		return { status: "sem_certificado", detail: "Instale o certificado A1 na tela /setup do cofre.", health };
	}
	if (expectedDoc && cert.holder.id !== expectedDoc) {
		return {
			status: "sem_certificado",
			detail: `O certificado instalado no cofre pertence a outro titular (${cert.holder.id}).`,
			health,
		};
	}
	if (Date.parse(cert.notAfter) < Date.now()) {
		return { status: "certificado_vencido", detail: "O certificado instalado no cofre venceu.", health };
	}
	return { status: "ativo", detail: "", health };
}

export function createApi(deps: ApiDeps = {}) {
	const app = new OpenAPIHono<Ctx>({
		defaultHook: (result, c) => {
			if (result.success) return;
			const issue = result.error.issues[0];
			const campo = issue?.path.join(".");
			return c.json(
				{
					erro: {
						codigo: "requisicao_invalida",
						mensagem: campo ? `Campo "${campo}": ${issue?.message}` : (issue?.message ?? "Requisição inválida."),
					},
				},
				400,
			);
		},
	});

	app.onError((err, c) => {
		console.error("erro não tratado:", err instanceof Error ? err.message : err);
		return erro(c, 500, "erro_interno", "Erro interno da API.");
	});
	app.notFound((c) => erro(c, 404, "nao_encontrado", "Rota inexistente."));

	app.use("*", async (c, next) => {
		await next();
		c.header("x-content-type-options", "nosniff");
		c.header("referrer-policy", "no-referrer");
		if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
	});

	const vaultFor = async (c: C, e: db.Emitter) =>
		new VaultClient({
			url: e.vaultUrl,
			pairingId: e.pairingId,
			key: await open(c.env.MASTER_KEY, e.id, e.pairingKeyIv, e.pairingKeyCt),
			fetch: deps.vaultFetch,
			timeoutMs: 20_000,
		});

	// ---------- Público ----------

	app.get("/", (c) =>
		c.json({
			nome: "NFapi",
			versao: API_VERSION,
			documentacao: "https://nfapi.queven.app",
			openapi: "/openapi.json",
		}),
	);
	app.get("/health", (c) => c.json({ ok: true, versao: API_VERSION }));

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/versao",
			tags: ["Geral"],
			summary: "Versão da API e do protocolo com o cofre",
			responses: {
				200: json(
					z.object({ versao: z.string(), protocoloCofre: z.number() }).openapi("Versao"),
					"Versões em uso.",
				),
			},
		}),
		(c) => c.json({ versao: API_VERSION, protocoloCofre: PROTOCOL_VERSION }, 200),
	);

	// ---------- Segredos configurados? ----------

	app.use("/admin/*", async (c, next) => {
		if (!secretIsStrong(c.env.ADMIN_TOKEN)) {
			return erro(c, 503, "api_nao_configurada", "ADMIN_TOKEN ausente ou curto demais.");
		}
		const header = c.req.header("authorization") ?? "";
		const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
		if (!provided || !(await safeEqual(provided, c.env.ADMIN_TOKEN))) {
			return erro(c, 401, "nao_autenticado", "Token de administração incorreto.");
		}
		await next();
	});

	app.use("/v1/*", async (c, next) => {
		if (c.req.path === "/v1/versao") return next();
		if (!secretIsStrong(c.env.MASTER_KEY)) {
			return erro(c, 503, "api_nao_configurada", "MASTER_KEY ausente ou curta demais.");
		}
		const header = c.req.header("authorization") ?? "";
		const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
		const found = looksLikeApiKey(key)
			? await db.findAccountByKeyHash(c.env.DB, await hashApiKey(key))
			: null;
		if (!found) {
			return erro(c, 401, "nao_autenticado", "Envie uma chave de API válida em Authorization: Bearer.");
		}
		c.set("account", found.account);
		const touch = db.touchApiKey(c.env.DB, found.keyId).catch(() => undefined);
		try {
			c.executionCtx.waitUntil(touch);
		} catch {
			await touch;
		}
		await next();
	});

	// ---------- Administração da plataforma (fora do OpenAPI público) ----------

	const NovaConta = z.object({ nome: z.string().trim().min(2).max(120), email: z.email().max(200) });
	const NovaChave = z.object({ nome: z.string().trim().min(1).max(80).default("Chave principal") });

	async function emitirChave(c: C, accountId: string, nome: string) {
		const generated = await newApiKey();
		const key = await db.createApiKey(c.env.DB, {
			id: newId("chv"),
			accountId,
			name: nome,
			prefix: generated.prefix,
			hash: generated.hash,
		});
		// A chave completa só existe nesta resposta.
		return { ...chaveJson(key), chave: generated.key };
	}

	app.post("/admin/contas", async (c) => {
		const input = NovaConta.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", "Informe nome e email válidos.");
		const account = await db.createAccount(c.env.DB, {
			id: newId("cta"),
			name: input.data.nome,
			email: input.data.email.toLowerCase(),
		});
		if (!account) return erro(c, 409, "email_ja_cadastrado", "Já existe uma conta com este e-mail.");
		return c.json({ conta: contaJson(account), chave: await emitirChave(c, account.id, "Chave principal") }, 201);
	});

	app.get("/admin/contas", async (c) => {
		return c.json({ contas: (await db.listAccounts(c.env.DB)).map(contaJson) });
	});

	app.post("/admin/contas/:id/chaves", async (c) => {
		const account = await db.getAccount(c.env.DB, c.req.param("id"));
		if (!account) return erro(c, 404, "nao_encontrado", "Conta inexistente.");
		const input = NovaChave.safeParse((await c.req.json().catch(() => null)) ?? {});
		if (!input.success) return erro(c, 400, "requisicao_invalida", "Nome da chave inválido.");
		return c.json({ chave: await emitirChave(c, account.id, input.data.nome) }, 201);
	});

	app.delete("/admin/chaves/:id", async (c) => {
		const revoked = await db.revokeApiKey(c.env.DB, c.req.param("id"));
		if (!revoked) return erro(c, 404, "nao_encontrado", "Chave inexistente ou já revogada.");
		return c.json({ ok: true });
	});

	// ---------- Conta ----------

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/conta",
			tags: ["Conta"],
			summary: "Dados da conta e suas chaves de API",
			security,
			responses: {
				200: json(z.object({ conta: Conta, chaves: z.array(ChaveApi) }), "Conta autenticada."),
				401: erros[401],
			},
		}),
		async (c) => {
			const account = c.get("account");
			const chaves = (await db.listApiKeys(c.env.DB, account.id)).map(chaveJson);
			return c.json({ conta: contaJson(account), chaves }, 200);
		},
	);

	// ---------- Emitentes ----------

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/emitentes",
			tags: ["Emitentes"],
			summary: "Lista os emitentes da conta",
			security,
			responses: {
				200: json(z.object({ emitentes: z.array(Emitente) }), "Emitentes conectados."),
				401: erros[401],
			},
		}),
		async (c) => {
			const list = await db.listEmitters(c.env.DB, c.get("account").id);
			return c.json({ emitentes: list.map(emitenteJson) }, 200);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/emitentes",
			tags: ["Emitentes"],
			summary: "Conecta um emitente pelo código de pareamento do cofre",
			description:
				"O código é gerado na tela `/setup` do cofre do emitente. A API consulta o cofre, lê o titular do certificado instalado e registra o emitente. Enviar um novo código para um CNPJ já conectado substitui o pareamento.",
			security,
			request: {
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object({
									codigoPareamento: z
										.string()
										.min(20)
										.max(2000)
										.openapi({ example: "nfapi-cofre-v1.eyJ2IjoxLCJ1cmwiOi..." }),
								})
								.openapi("ConectarEmitente"),
						},
					},
				},
			},
			responses: {
				200: json(Emitente, "Pareamento de um emitente existente substituído."),
				201: json(Emitente, "Emitente conectado."),
				400: erros[400],
				401: erros[401],
				422: json(Erro, "O cofre respondeu, mas não está pronto (sem certificado, vencido, pareamento recusado ou desatualizado)."),
				502: json(Erro, "Não foi possível falar com o cofre."),
			},
		}),
		async (c) => {
			const account = c.get("account");
			let client: VaultClient;
			let pairing: ReturnType<typeof decodePairingCode>;
			try {
				pairing = decodePairingCode(c.req.valid("json").codigoPareamento);
				client = VaultClient.fromPairingCode(pairing, { fetch: deps.vaultFetch, timeoutMs: 20_000 });
			} catch (err) {
				const mensagem = err instanceof VaultError ? err.message : "Código de pareamento inválido.";
				return erro(c, 400, "codigo_invalido", mensagem);
			}

			const { status, detail, health } = await inspectVault(client);
			if (status === "inacessivel") return erro(c, 502, "cofre_inacessivel", detail);
			const cert = health?.certificate;
			if (status !== "ativo" || !health || !cert) return erro(c, 422, status, detail);

			const existing = await db.findEmitterByDoc(c.env.DB, account.id, cert.holder.id);
			const id = existing?.id ?? newId("emi");
			const sealed = await seal(c.env.MASTER_KEY, id, fromHex(pairing.key));
			const now = Date.now();
			const emitter: db.Emitter = {
				id,
				accountId: account.id,
				docKind: cert.holder.kind,
				docId: cert.holder.id,
				name: cert.commonName.split(":")[0]?.trim() || cert.commonName,
				vaultUrl: client.origin,
				pairingId: pairing.id,
				pairingKeyIv: sealed.iv,
				pairingKeyCt: sealed.ciphertext,
				vaultVersion: health.version,
				vaultProtocol: health.protocol,
				allowProduction: health.allowProduction,
				certIssuer: cert.issuer,
				certNotAfter: Date.parse(cert.notAfter),
				status: "ativo",
				statusDetail: "",
				checkedAt: now,
				createdAt: existing?.createdAt ?? now,
			};
			await db.saveEmitter(c.env.DB, emitter);
			return c.json(emitenteJson(emitter), existing ? 200 : 201);
		},
	);

	const IdParam = z.object({ id: z.string().regex(/^emi_[a-f0-9]{20}$/).openapi({ param: { name: "id", in: "path" } }) });

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/emitentes/{id}",
			tags: ["Emitentes"],
			summary: "Consulta um emitente",
			security,
			request: { params: IdParam },
			responses: { 200: json(Emitente, "Emitente."), 400: erros[400], 401: erros[401], 404: erros[404] },
		}),
		async (c) => {
			const emitter = await db.getEmitter(c.env.DB, c.get("account").id, c.req.valid("param").id);
			if (!emitter) return erro(c, 404, "nao_encontrado", "Emitente inexistente nesta conta.");
			return c.json(emitenteJson(emitter), 200);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/emitentes/{id}/verificar",
			tags: ["Emitentes"],
			summary: "Consulta o cofre agora e atualiza a situação do emitente",
			security,
			request: { params: IdParam },
			responses: { 200: json(Emitente, "Situação atualizada."), 400: erros[400], 401: erros[401], 404: erros[404] },
		}),
		async (c) => {
			const emitter = await db.getEmitter(c.env.DB, c.get("account").id, c.req.valid("param").id);
			if (!emitter) return erro(c, 404, "nao_encontrado", "Emitente inexistente nesta conta.");

			const { status, detail, health } = await inspectVault(await vaultFor(c, emitter), emitter.docId);
			const cert = health?.certificate?.holder.id === emitter.docId ? health.certificate : undefined;
			const updated: db.Emitter = {
				...emitter,
				status,
				statusDetail: detail,
				checkedAt: Date.now(),
				vaultVersion: health?.version ?? emitter.vaultVersion,
				vaultProtocol: health?.protocol ?? emitter.vaultProtocol,
				allowProduction: health?.allowProduction ?? emitter.allowProduction,
				certIssuer: cert?.issuer ?? emitter.certIssuer,
				certNotAfter: cert ? Date.parse(cert.notAfter) : emitter.certNotAfter,
			};
			await db.saveEmitter(c.env.DB, updated);
			return c.json(emitenteJson(updated), 200);
		},
	);

	app.openapi(
		createRoute({
			method: "delete",
			path: "/v1/emitentes/{id}",
			tags: ["Emitentes"],
			summary: "Desconecta um emitente",
			description:
				"Remove o pareamento desta API. O certificado e os documentos continuam no cofre do emitente; para cortar o acesso também pelo lado do cofre, revogue o pareamento na tela `/setup`.",
			security,
			request: { params: IdParam },
			responses: {
				204: { description: "Emitente desconectado." },
				400: erros[400],
				401: erros[401],
				404: erros[404],
			},
		}),
		async (c) => {
			const removed = await db.deleteEmitter(c.env.DB, c.get("account").id, c.req.valid("param").id);
			if (!removed) return erro(c, 404, "nao_encontrado", "Emitente inexistente nesta conta.");
			return c.body(null, 204);
		},
	);

	// ---------- OpenAPI ----------

	app.openAPIRegistry.registerComponent("securitySchemes", "chaveApi", {
		type: "http",
		scheme: "bearer",
		description: "Chave de API da conta, no formato `nfapi_...`.",
	});
	app.doc31("/openapi.json", {
		openapi: "3.1.0",
		info: {
			title: "NFapi",
			version: API_VERSION,
			description:
				"API para emissão de NFS-e, NF-e e NFC-e. O certificado digital e os documentos fiscais ficam no cofre do emitente, na conta Cloudflare dele.",
			license: { name: "MIT" },
		},
		servers: [{ url: "https://api.nfapi.queven.app", description: "Produção" }],
	});

	return app;
}
