// Emissão de NFS-e pelo Sistema Nacional.
//
// Fluxo: valida o pedido -> reserva o número -> monta a DPS -> o cofre assina
// -> o cofre transmite à SEFIN Nacional -> a NFS-e autorizada é gravada no
// cofre. A API guarda só os metadados da emissão.

import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type Ambiente, NFSE_NACIONAL, nfseAmbiente } from "@nfapi/fiscal-data";
import {
	type Mensagem,
	NfseInput,
	type RespostaEmissao,
	base64ParaTexto,
	corpoEmissao,
	lerRespostaEmissao,
	montarDps,
	textoParaBase64,
} from "@nfapi/nfse-nacional";
import { type VaultClient, VaultError } from "@nfapi/vault-client";
import { type C, type Ctx, Erro, type RotasDeps, erro, erros, iso, json, security } from "./comum";
import { newId } from "./crypto";
import * as db from "./db";
import * as emissions from "./emissions";
import { VERSAO_APLICATIVO } from "./versao";

const EmitirNfse = NfseInput.extend({
	emitente: z.string().regex(/^emi_[a-f0-9]{20}$/, "id de emitente inválido"),
	ambiente: z.enum(["homologacao", "producao"]).default("homologacao"),
	/**
	 * Identificador do pedido no sistema do cliente. Reenviar a mesma referência
	 * nunca gera uma segunda nota: devolve a existente ou retoma a tentativa.
	 */
	referencia: z
		.string()
		.regex(/^[A-Za-z0-9._:-]{1,80}$/, "referencia: letras, números e . _ : - (até 80)")
		.optional(),
}).openapi("EmitirNfse");

const MensagemSchema = z
	.object({ codigo: z.string(), descricao: z.string(), complemento: z.string().optional() })
	.openapi("MensagemFiscal");

const Nfse = z
	.object({
		id: z.string().openapi({ example: "nfs_5c2e9a7b1d4f8a0c3e6b" }),
		emitente: z.string(),
		ambiente: z.enum(["homologacao", "producao"]),
		referencia: z.string().nullable(),
		serie: z.string(),
		numero: z.number().openapi({ description: "Número da DPS." }),
		idDps: z.string(),
		situacao: z.enum(["processando", "autorizada", "rejeitada", "erro", "indefinida"]).openapi({
			description:
				"`rejeitada`: a SEFIN recusou. `erro`: nada foi transmitido. `indefinida`: foi transmitida sem resposta conclusiva; reenvie com a mesma referência para a API verificar.",
		}),
		chaveAcesso: z.string().nullable(),
		numeroNfse: z.string().nullable(),
		mensagens: z.array(MensagemSchema),
		xmlDisponivel: z.boolean(),
		criadaEm: z.string(),
		atualizadaEm: z.string(),
	})
	.openapi("Nfse");

const NfseNaoAutorizada = z
	.object({ erro: Erro.shape.erro, nfse: Nfse })
	.openapi("NfseNaoAutorizada");

const nfseJson = (e: emissions.Emission): z.infer<typeof Nfse> => ({
	id: e.id,
	emitente: e.emitterId,
	ambiente: e.environment,
	referencia: e.reference,
	serie: e.serie,
	numero: e.number,
	idDps: e.documentId,
	situacao: e.status,
	chaveAcesso: e.accessKey,
	numeroNfse: e.fiscalNumber,
	mensagens: e.messages,
	xmlDisponivel: e.documentKey !== null,
	criadaEm: iso(e.createdAt),
	atualizadaEm: iso(e.updatedAt),
});

const IdNfse = z.object({
	id: z
		.string()
		.regex(/^nfs_[a-f0-9]{20}$/)
		.openapi({ param: { name: "id", in: "path" } }),
});

/** Erros do cofre em que nada chegou a sair para o governo. */
const NAO_TRANSMITIDO = new Set([
	"host_nao_permitido",
	"requisicao_invalida",
	"certificado_ausente",
	"certificado_vencido",
	"certificado_do_cliente_invalido",
	"nao_autenticado",
]);

const mensagemDoCofre = (err: VaultError): Mensagem => ({ codigo: err.code, descricao: err.message });

async function consultar(vault: VaultClient, url: string, ref: string) {
	const res = await vault.transmit({ url, method: "GET", headers: { accept: "application/json" }, ref });
	return { status: res.status, corpo: base64ParaTexto(res.bodyB64), journalKey: res.journalKey };
}

/**
 * Descobre se uma DPS já virou NFS-e (usado ao retomar uma emissão sem
 * resposta conclusiva). Devolve null quando a SEFIN não conhece a DPS.
 */
async function recuperar(
	vault: VaultClient,
	sefin: string,
	dpsId: string,
	ref: string,
): Promise<RespostaEmissao | null> {
	const dps = await consultar(vault, `${sefin}/dps/${dpsId}`, ref);
	if (dps.status === 404) return null;
	let chave: unknown;
	try {
		chave = (JSON.parse(dps.corpo) as { chaveAcesso?: unknown }).chaveAcesso;
	} catch {
		chave = undefined;
	}
	if (dps.status !== 200 || typeof chave !== "string") {
		return { tipo: "indefinida", detalhe: `Consulta da DPS respondeu HTTP ${dps.status}.` };
	}
	const nfse = await consultar(vault, `${sefin}/nfse/${chave}`, ref);
	const lida = await lerRespostaEmissao(nfse.status, nfse.corpo);
	return lida.tipo === "autorizada"
		? lida
		: { tipo: "indefinida", detalhe: `A DPS gerou a NFS-e ${chave}, mas a consulta do XML falhou.` };
}

export function registrarNfse(app: OpenAPIHono<Ctx>, deps: RotasDeps) {
	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/nfse",
			tags: ["NFS-e"],
			summary: "Emite uma NFS-e pelo Sistema Nacional",
			description:
				"Monta a DPS, pede a assinatura e a transmissão ao cofre do emitente e devolve a NFS-e autorizada. O XML fica no cofre. Use `referencia` para tornar o pedido idempotente.",
			security,
			request: {
				body: { required: true, content: { "application/json": { schema: EmitirNfse } } },
			},
			responses: {
				200: json(Nfse, "A referência já tinha uma NFS-e autorizada; nada foi reenviado."),
				201: json(Nfse, "NFS-e autorizada."),
				400: erros[400],
				401: erros[401],
				404: erros[404],
				409: json(Erro, "Emissão em andamento para a mesma referência, ou número de DPS já usado."),
				422: json(NfseNaoAutorizada, "Recusada pela SEFIN ou barrada antes da transmissão (ver `nfse.situacao`)."),
				502: json(NfseNaoAutorizada, "Sem resposta conclusiva do cofre ou da SEFIN."),
			},
		}),
		async (c) => {
			const account = c.get("account");
			const { emitente, ambiente, referencia, ...pedido } = c.req.valid("json");
			const emitter = await db.getEmitter(c.env.DB, account.id, emitente);
			if (!emitter) return erro(c, 404, "emitente_nao_encontrado", "Emitente inexistente nesta conta.");

			const config = nfseAmbiente(ambiente);
			const serieKey = {
				accountId: account.id,
				docId: emitter.docId,
				kind: "nfse" as const,
				environment: ambiente as Ambiente,
				serie: pedido.serie,
			};

			// ----- Idempotência -----
			let emission = referencia
				? await emissions.findByReference(c.env.DB, serieKey, referencia)
				: null;
			if (emission?.status === "autorizada") return c.json(nfseJson(emission), 200);
			if (emission?.status === "processando") {
				return erro(c, 409, "emissao_em_andamento", "Já existe uma emissão em andamento para esta referência.");
			}

			const naoAutorizada = async <S extends 422 | 502>(
				status: S,
				situacao: "rejeitada" | "erro" | "indefinida",
				codigo: string,
				mensagens: Mensagem[],
				journalKey?: string,
			) => {
				const atual = await emissions.updateEmission(c.env.DB, (emission as emissions.Emission).id, {
					status: situacao,
					messages: mensagens,
					...(journalKey ? { journalKey } : {}),
				});
				const mensagem = mensagens[0]?.descricao ?? "A NFS-e não foi autorizada.";
				return c.json({ erro: { codigo, mensagem }, nfse: nfseJson(atual) }, status);
			};

			const vault = await deps.vaultFor(c, emitter);
			let resposta: RespostaEmissao | null = null;
			let journalKey: string | undefined;
			let dpsAssinada: string | undefined;

			try {
				// ----- Retomada: a tentativa anterior pode ter gerado a nota -----
				if (emission?.status === "indefinida") {
					resposta = await recuperar(vault, config.sefin, emission.documentId, emission.id);
					if (resposta?.tipo === "indefinida") {
						return await naoAutorizada(502, "indefinida", "sem_resposta_conclusiva", [
							{ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe },
						]);
					}
				}

				if (!resposta) {
					// ----- Número e DPS -----
					const numero = emission?.number ?? pedido.numero ?? (await emissions.nextNumber(c.env.DB, serieKey));
					if (pedido.numero) await emissions.noteNumber(c.env.DB, serieKey, pedido.numero);
					const dps = montarDps(pedido, {
						ambiente,
						leiaute: config.leiaute,
						emitente: { tipo: emitter.docKind, numero: emitter.docId },
						numero,
						versaoAplicativo: VERSAO_APLICATIVO,
					});

					if (emission) {
						emission = await emissions.updateEmission(c.env.DB, emission.id, {
							status: "processando",
							documentId: dps.id,
							emitterId: emitter.id,
							messages: [],
						});
					} else {
						const now = Date.now();
						emission = {
							id: newId("nfs"),
							accountId: account.id,
							emitterId: emitter.id,
							docId: emitter.docId,
							kind: "nfse",
							environment: ambiente,
							reference: referencia ?? null,
							serie: pedido.serie,
							number: numero,
							documentId: dps.id,
							status: "processando",
							accessKey: null,
							fiscalNumber: null,
							messages: [],
							documentKey: null,
							journalKey: null,
							createdAt: now,
							updatedAt: now,
						};
						if (!(await emissions.insertEmission(c.env.DB, emission))) {
							return erro(
								c,
								409,
								"numero_ja_utilizado",
								`A DPS ${numero} da série ${pedido.serie} já foi usada (ou a referência acabou de ser registrada).`,
							);
						}
					}

					// ----- Assinar (no cofre) -----
					try {
						const assinada = await vault.sign({ xml: dps.xml, tag: "infDPS", profile: NFSE_NACIONAL.assinatura });
						dpsAssinada = assinada.xml;
					} catch (err) {
						if (!(err instanceof VaultError)) throw err;
						const cofreFora = err.status === 0 || err.status >= 500;
						return await naoAutorizada(cofreFora ? 502 : 422, "erro", err.code, [mensagemDoCofre(err)]);
					}

					// ----- Transmitir (pelo cofre) -----
					try {
						const res = await vault.transmit({
							url: `${config.sefin}/nfse`,
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json" },
							bodyB64: textoParaBase64(await corpoEmissao(dpsAssinada)),
							timeoutMs: 60_000,
							ref: emission.id,
						});
						journalKey = res.journalKey;
						resposta = await lerRespostaEmissao(res.status, base64ParaTexto(res.bodyB64));
					} catch (err) {
						if (!(err instanceof VaultError)) throw err;
						return NAO_TRANSMITIDO.has(err.code)
							? await naoAutorizada(422, "erro", err.code, [mensagemDoCofre(err)])
							: await naoAutorizada(502, "indefinida", "sem_resposta_conclusiva", [mensagemDoCofre(err)]);
					}
				}
			} catch (err) {
				// Falha do cofre durante a retomada.
				if (!(err instanceof VaultError) || !emission) throw err;
				return await naoAutorizada(502, "indefinida", "sem_resposta_conclusiva", [mensagemDoCofre(err)]);
			}

			if (!emission) throw new Error("emissão sem registro");
			if (resposta.tipo === "rejeitada") {
				return await naoAutorizada(422, "rejeitada", "nfse_rejeitada", resposta.rejeicoes, journalKey);
			}
			if (resposta.tipo === "indefinida") {
				return await naoAutorizada(
					502,
					"indefinida",
					"sem_resposta_conclusiva",
					[{ codigo: "sem_resposta_conclusiva", descricao: resposta.detalhe }],
					journalKey,
				);
			}

			// ----- Autorizada: arquivar no cofre do emitente -----
			const dia = iso(emission.createdAt);
			const base = `nfse/${ambiente}/${dia.slice(0, 4)}/${dia.slice(5, 7)}/${resposta.chaveAcesso}`;
			const mensagens = [...resposta.alertas];
			let documentKey: string | null = null;
			try {
				const meta = { tipo: "nfse", chaveAcesso: resposta.chaveAcesso, emissao: emission.id };
				await vault.putDocument(`${base}-nfse.xml`, resposta.xml, { contentType: "application/xml", meta });
				documentKey = `${base}-nfse.xml`;
				if (dpsAssinada) {
					await vault.putDocument(`${base}-dps.xml`, dpsAssinada, {
						contentType: "application/xml",
						meta: { ...meta, tipo: "dps" },
					});
				}
			} catch (err) {
				if (!(err instanceof VaultError)) throw err;
				// A nota está autorizada e a resposta completa está no diário do cofre.
				mensagens.push({
					codigo: "arquivo_pendente",
					descricao: `NFS-e autorizada, mas o XML não pôde ser arquivado no cofre: ${err.message}`,
				});
			}

			const final = await emissions.updateEmission(c.env.DB, emission.id, {
				status: "autorizada",
				accessKey: resposta.chaveAcesso,
				fiscalNumber: resposta.numeroNfse,
				messages: mensagens,
				documentKey,
				...(journalKey ? { journalKey } : {}),
			});
			return c.json(nfseJson(final), 201);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/nfse",
			tags: ["NFS-e"],
			summary: "Lista as emissões de NFS-e da conta",
			security,
			request: {
				query: z.object({
					emitente: z.string().optional(),
					limite: z.coerce.number().int().min(1).max(100).default(50),
				}),
			},
			responses: { 200: json(z.object({ nfse: z.array(Nfse) }), "Emissões, da mais recente para a mais antiga."), 400: erros[400], 401: erros[401] },
		}),
		async (c) => {
			const { emitente, limite } = c.req.valid("query");
			const list = await emissions.listEmissions(c.env.DB, c.get("account").id, {
				emitterId: emitente,
				limit: limite,
			});
			return c.json({ nfse: list.map(nfseJson) }, 200);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/nfse/{id}",
			tags: ["NFS-e"],
			summary: "Consulta uma emissão",
			security,
			request: { params: IdNfse },
			responses: { 200: json(Nfse, "Emissão."), 400: erros[400], 401: erros[401], 404: erros[404] },
		}),
		async (c) => {
			const emission = await emissions.getEmission(c.env.DB, c.get("account").id, c.req.valid("param").id);
			if (!emission) return erro(c, 404, "nao_encontrado", "Emissão inexistente nesta conta.");
			return c.json(nfseJson(emission), 200);
		},
	);

	// XML da NFS-e, lido do cofre do emitente. Fora do createRoute porque a
	// resposta não é JSON.
	app.get("/v1/nfse/:id/xml", async (c: C) => {
		const account = c.get("account");
		const emission = await emissions.getEmission(c.env.DB, account.id, c.req.param("id") ?? "");
		if (!emission?.documentKey) return erro(c, 404, "nao_encontrado", "XML indisponível para esta emissão.");
		const emitter = await db.getEmitter(c.env.DB, account.id, emission.emitterId);
		if (!emitter) return erro(c, 404, "emitente_nao_encontrado", "O emitente desta nota foi desconectado.");
		try {
			const doc = await (await deps.vaultFor(c, emitter)).getDocument(emission.documentKey);
			if (!doc) return erro(c, 404, "nao_encontrado", "O XML não está mais no cofre.");
			return c.body(doc.body, 200, { "content-type": "application/xml; charset=utf-8" });
		} catch (err) {
			if (!(err instanceof VaultError)) throw err;
			return erro(c, 502, "cofre_inacessivel", err.message);
		}
	});
}
