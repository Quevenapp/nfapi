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
import { type ApiEnv, type C, type Ctx, Erro, erro, erros, iso, json, security } from "./comum";
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
import { registrarTestes } from "./admin-testes";
import { registrarRotasDoCofre } from "./cofre-rotas";
import { dentroDoLimite, ipDoCliente } from "./limites";
import { registrarNfse } from "./nfse";
import { PAINEL_CSS, PAINEL_HTML, PAINEL_JS } from "./painel/page";
import { API_VERSION } from "./versao";

export { API_VERSION };
export type { ApiEnv };

export interface ApiDeps {
	/** Como alcançar os cofres. Trocado nos testes; em produção é o fetch global. */
	vaultFetch?: typeof fetch;
}

// ---------- Esquemas (também geram o OpenAPI) ----------

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

	type Conexao =
		| { ok: true; emitter: db.Emitter; novo: boolean }
		| { ok: false; status: 400 | 422 | 502; codigo: string; mensagem: string };

	type CofreConferido =
		| {
				ok: true;
				pairing: ReturnType<typeof decodePairingCode>;
				client: VaultClient;
				health: HealthResponse;
				cert: NonNullable<HealthResponse["certificate"]>;
		  }
		| Extract<Conexao, { ok: false }>;

	/** Abre o código de pareamento e confere se o cofre está pronto para emitir. */
	async function conferirCofre(codigo: string): Promise<CofreConferido> {
		let client: VaultClient;
		let pairing: ReturnType<typeof decodePairingCode>;
		try {
			pairing = decodePairingCode(codigo);
			client = VaultClient.fromPairingCode(pairing, { fetch: deps.vaultFetch, timeoutMs: 20_000 });
		} catch (err) {
			const mensagem = err instanceof VaultError ? err.message : "Código de pareamento inválido.";
			return { ok: false, status: 400, codigo: "codigo_invalido", mensagem };
		}

		const { status, detail, health } = await inspectVault(client);
		if (status === "inacessivel") return { ok: false, status: 502, codigo: "cofre_inacessivel", mensagem: detail };
		const cert = health?.certificate;
		if (status !== "ativo" || !health || !cert) return { ok: false, status: 422, codigo: status, mensagem: detail };
		return { ok: true, pairing, client, health, cert };
	}

	/** Pareia um cofre com uma conta, a partir do código gerado na tela /setup dele. */
	async function conectarEmitente(c: C, accountId: string, codigo: string): Promise<Conexao> {
		const cofre = await conferirCofre(codigo);
		if (!cofre.ok) return cofre;
		return gravarEmitente(c, accountId, cofre);
	}

	async function gravarEmitente(
		c: C,
		accountId: string,
		{ pairing, client, health, cert }: Extract<CofreConferido, { ok: true }>,
	): Promise<Conexao> {
		const existing = await db.findEmitterByDoc(c.env.DB, accountId, cert.holder.id);
		const id = existing?.id ?? newId("emi");
		const sealed = await seal(c.env.MASTER_KEY, id, fromHex(pairing.key));
		const now = Date.now();
		const emitter: db.Emitter = {
			id,
			accountId,
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
		return { ok: true, emitter, novo: !existing };
	}

	/** Consulta o cofre agora e grava a situação atual do emitente. */
	async function verificarEmitente(c: C, emitter: db.Emitter): Promise<db.Emitter> {
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
		return updated;
	}

	// ---------- Público ----------

	app.get("/", (c) => {
		// admin.nfapi.queven.app aponta para este mesmo Worker e abre o painel.
		if (new URL(c.req.url).hostname.startsWith("admin.")) return c.redirect("/painel");
		return c.json({
			nome: "NFapi",
			versao: API_VERSION,
			documentacao: "https://nfapi.queven.app",
			openapi: "/openapi.json",
		});
	});
	app.get("/health", (c) => c.json({ ok: true, versao: API_VERSION }));

	// Painel de administração (admin.nfapi.queven.app). A página é pública e
	// vazia de dados: tudo o que ela mostra vem das rotas /admin, com token.
	const CSP =
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
	app.get("/painel", (c) => {
		c.header("content-security-policy", CSP);
		c.header("x-frame-options", "DENY");
		return c.html(PAINEL_HTML);
	});
	app.get("/painel/app.js", (c) => c.body(PAINEL_JS, 200, { "content-type": "text/javascript; charset=utf-8" }));
	app.get("/painel/app.css", (c) => c.body(PAINEL_CSS, 200, { "content-type": "text/css; charset=utf-8" }));

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
		if (provided && (await safeEqual(provided, c.env.ADMIN_TOKEN))) {
			c.set("origem", "admin");
			return next();
		}
		// Token da IA: escopo restrito aos testes de homologação.
		const somenteTestes = c.req.path === "/admin/testes" || c.req.path.startsWith("/admin/testes/");
		if (
			provided &&
			somenteTestes &&
			secretIsStrong(c.env.TESTES_TOKEN) &&
			(await safeEqual(provided, c.env.TESTES_TOKEN))
		) {
			c.set("origem", "ia");
			return next();
		}
		return erro(c, 401, "nao_autenticado", "Token de administração incorreto.");
	});

	app.use("/v1/*", async (c, next) => {
		// Rotas públicas: a versão e o cadastro (que cria a conta e sua primeira chave).
		if (c.req.path === "/v1/versao" || c.req.path === "/v1/cadastro") return next();
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

	// Detalhe de uma conta: chaves (sem o valor) e emitentes conectados.
	app.get("/admin/contas/:id", async (c) => {
		const account = await db.getAccount(c.env.DB, c.req.param("id"));
		if (!account) return erro(c, 404, "nao_encontrado", "Conta inexistente.");
		const [chaves, emitentes] = await Promise.all([
			db.listApiKeys(c.env.DB, account.id),
			db.listEmitters(c.env.DB, account.id),
		]);
		return c.json({
			conta: contaJson(account),
			chaves: chaves.map(chaveJson),
			emitentes: emitentes.map(emitenteJson),
		});
	});

	// O administrador conecta o cofre em nome da conta (o painel do usuário não existe).
	app.post("/admin/contas/:id/emitentes", async (c) => {
		const account = await db.getAccount(c.env.DB, c.req.param("id"));
		if (!account) return erro(c, 404, "nao_encontrado", "Conta inexistente.");
		const input = (await c.req.json().catch(() => null)) as { codigoPareamento?: unknown } | null;
		if (typeof input?.codigoPareamento !== "string" || input.codigoPareamento.length < 20) {
			return erro(c, 400, "requisicao_invalida", "Informe o código de pareamento gerado no cofre.");
		}
		const r = await conectarEmitente(c, account.id, input.codigoPareamento);
		if (!r.ok) return erro(c, r.status, r.codigo, r.mensagem);
		return c.json({ emitente: emitenteJson(r.emitter) }, r.novo ? 201 : 200);
	});

	app.post("/admin/emitentes/:id/verificar", async (c) => {
		const emitter = await db.getEmitterById(c.env.DB, c.req.param("id"));
		if (!emitter) return erro(c, 404, "nao_encontrado", "Emitente inexistente.");
		return c.json({ emitente: emitenteJson(await verificarEmitente(c, emitter)) });
	});

	app.delete("/admin/emitentes/:id", async (c) => {
		const emitter = await db.getEmitterById(c.env.DB, c.req.param("id"));
		if (!emitter) return erro(c, 404, "nao_encontrado", "Emitente inexistente.");
		await db.deleteEmitter(c.env.DB, emitter.accountId, emitter.id);
		return c.json({ ok: true });
	});

	// ---------- Cadastro (público) ----------

	const ChaveApiCriada = ChaveApi.extend({
		chave: z.string().openapi({ description: "Valor completo da chave. Só aparece nesta resposta." }),
	}).openapi("ChaveApiCriada");

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/cadastro",
			tags: ["Conta"],
			summary: "Cria uma conta a partir de um cofre instalado",
			description:
				"Autoatendimento: quem instalou um cofre e nele um certificado A1 válido cria a própria conta. Normalmente esta rota é chamada pelo próprio cofre, no botão **Criar minha conta** da tela `/setup`. A resposta traz a primeira chave de API, que não pode ser consultada depois.",
			request: {
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object({
									codigoPareamento: z.string().min(20).max(2000),
									email: z.email().max(200),
									nome: z.string().trim().min(2).max(120).optional(),
								})
								.openapi("Cadastro"),
						},
					},
				},
			},
			responses: {
				201: json(
					z.object({ conta: Conta, chave: ChaveApiCriada, emitente: Emitente }).openapi("CadastroCriado"),
					"Conta criada, com a primeira chave de API e o cofre conectado.",
				),
				400: erros[400],
				409: json(Erro, "Já existe uma conta com este e-mail."),
				422: json(Erro, "O cofre respondeu, mas não está pronto (sem certificado, vencido ou desatualizado)."),
				429: json(Erro, "Muitas tentativas de cadastro; aguarde antes de tentar de novo."),
				502: json(Erro, "Não foi possível falar com o cofre."),
				503: json(Erro, "A API não está configurada."),
			},
		}),
		async (c) => {
			if (!secretIsStrong(c.env.MASTER_KEY)) {
				return erro(c, 503, "api_nao_configurada", "MASTER_KEY ausente ou curta demais.");
			}
			// Rota sem autenticação: poucas tentativas por IP a cada hora.
			if (!(await dentroDoLimite(c.env.DB, `cadastro:${ipDoCliente(c.req.raw.headers)}`, 5, 3600))) {
				return erro(c, 429, "muitas_tentativas", "Muitas tentativas de cadastro a partir deste endereço. Tente de novo em uma hora.");
			}
			const input = c.req.valid("json");

			// O cofre é conferido antes de criar qualquer coisa: sem cofre pronto, não há conta.
			const cofre = await conferirCofre(input.codigoPareamento);
			if (!cofre.ok) return erro(c, cofre.status, cofre.codigo, cofre.mensagem);

			const account = await db.createAccount(c.env.DB, {
				id: newId("cta"),
				name: input.nome ?? (cofre.cert.commonName.split(":")[0]?.trim() || cofre.cert.commonName),
				email: input.email.toLowerCase(),
			});
			if (!account) {
				return erro(c, 409, "email_ja_cadastrado", "Já existe uma conta com este e-mail. Peça uma nova chave ao administrador.");
			}
			const chave = await emitirChave(c, account.id, "Chave principal");
			const conexao = await gravarEmitente(c, account.id, cofre);
			if (!conexao.ok) return erro(c, conexao.status, conexao.codigo, conexao.mensagem);
			return c.json({ conta: contaJson(account), chave, emitente: emitenteJson(conexao.emitter) }, 201);
		},
	);

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
			const r = await conectarEmitente(c, c.get("account").id, c.req.valid("json").codigoPareamento);
			if (!r.ok) return erro(c, r.status, r.codigo, r.mensagem);
			return c.json(emitenteJson(r.emitter), r.novo ? 201 : 200);
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
			return c.json(emitenteJson(await verificarEmitente(c, emitter)), 200);
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

	// ---------- Documentos fiscais ----------

	registrarNfse(app, { vaultFor });
	registrarTestes(app, { vaultFor });
	registrarRotasDoCofre(app, { vaultFor });

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
