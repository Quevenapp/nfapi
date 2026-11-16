// Rotas de NFS-e pelo Sistema Nacional. O fluxo de emissão está em
// nfse-emissao.ts; aqui ficam os esquemas, a tradução para HTTP e as consultas.

import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { CancelamentoInput, NfseInput } from "@nfapi/nfse-nacional";
import { VaultError } from "@nfapi/vault-client";
import { type C, type Ctx, Erro, type RotasDeps, erro, erros, iso, json, security } from "./comum";
import * as db from "./db";
import * as emissions from "./emissions";
import { cancelarNfse } from "./nfse-cancelamento";
import { emitirNfse } from "./nfse-emissao";

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
		situacao: z.enum(["processando", "autorizada", "rejeitada", "erro", "indefinida", "cancelada"]).openapi({
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

export const nfseJson = (e: emissions.Emission): z.infer<typeof Nfse> => ({
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

			const resultado = await emitirNfse(c.env.DB, await deps.vaultFor(c, emitter), {
				accountId: account.id,
				emitter,
				ambiente,
				referencia,
				pedido,
			});
			switch (resultado.tipo) {
				case "autorizada":
					return c.json(nfseJson(resultado.emission), resultado.nova ? 201 : 200);
				case "conflito":
					return erro(c, 409, resultado.codigo, resultado.mensagem);
				case "nao_autorizada":
					return c.json(
						{
							erro: { codigo: resultado.codigo, mensagem: resultado.mensagem },
							nfse: nfseJson(resultado.emission),
						},
						resultado.status,
					);
			}
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
			responses: {
				200: json(z.object({ nfse: z.array(Nfse) }), "Emissões, da mais recente para a mais antiga."),
				400: erros[400],
				401: erros[401],
			},
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

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/nfse/{id}/cancelar",
			tags: ["NFS-e"],
			summary: "Cancela uma NFS-e autorizada",
			description:
				"Registra o evento de cancelamento na SEFIN Nacional, assinado pelo cofre do emitente. O evento registrado fica arquivado no cofre, ao lado da nota. Se a nota já estiver cancelada, devolve a situação atual sem reenviar. O município define o prazo e as condições em que o cancelamento é aceito.",
			security,
			request: {
				params: IdNfse,
				body: {
					required: true,
					// extend({}) cria o esquema depois que o zod-openapi estendeu o zod; o
					// original, criado no pacote de NFS-e, pode não ter o método .openapi.
					content: { "application/json": { schema: CancelamentoInput.extend({}).openapi("CancelarNfse") } },
				},
			},
			responses: {
				200: json(Nfse, "NFS-e cancelada."),
				400: erros[400],
				401: erros[401],
				404: erros[404],
				409: json(Erro, "A NFS-e não está autorizada."),
				422: json(Erro, "A SEFIN recusou o cancelamento, ou o cofre barrou o pedido."),
				502: json(Erro, "Sem resposta conclusiva do cofre ou da SEFIN."),
			},
		}),
		async (c) => {
			const account = c.get("account");
			const emission = await emissions.getEmission(c.env.DB, account.id, c.req.valid("param").id);
			if (!emission) return erro(c, 404, "nao_encontrado", "Emissão inexistente nesta conta.");
			const emitter = await db.getEmitter(c.env.DB, account.id, emission.emitterId);
			if (!emitter) return erro(c, 404, "emitente_nao_encontrado", "O emitente desta nota foi desconectado.");

			const r = await cancelarNfse(c.env.DB, await deps.vaultFor(c, emitter), emitter, emission, c.req.valid("json"));
			if (!r.ok) return erro(c, r.status, r.codigo, r.mensagem);
			return c.json(nfseJson(r.emission), 200);
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
