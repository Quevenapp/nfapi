// Rotas administrativas dos testes de homologação.
//
//   GET  /admin/testes              catálogo de cenários + emitentes e seus perfis
//   PUT  /admin/testes/perfis/:id   dados fiscais usados nos testes (só o admin)
//   POST /admin/testes/execucoes    executa cenários para um emitente
//   GET  /admin/testes/execucoes    histórico
//
// A autenticação fica no middleware de /admin (ver app.ts): o ADMIN_TOKEN
// acessa tudo; o TESTES_TOKEN (da IA) só lê e executa.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { type C, type Ctx, type RotasDeps, erro, iso } from "./comum";
import * as db from "./db";
import { CENARIOS, PerfilTeste, executarCenario, gravarPerfil, lerPerfil, listarExecucoes } from "./testes";

const Executar = z.object({
	emitente: z.string().regex(/^emi_[a-f0-9]{20}$/),
	/** Ids dos cenários; se omitido, roda todos os disponíveis. */
	cenarios: z.array(z.string()).min(1).max(20).optional(),
});

export function registrarTestes(app: OpenAPIHono<Ctx>, deps: RotasDeps) {
	app.get("/admin/testes", async (c: C) => {
		const emitentes = await Promise.all(
			(await db.listAllEmitters(c.env.DB)).map(async (e) => ({
				id: e.id,
				nome: e.name,
				documento: { tipo: e.docKind, numero: e.docId },
				conta: { id: e.accountId, nome: e.accountName },
				cofre: {
					situacao: e.status,
					producaoLiberada: e.allowProduction,
					verificadoEm: iso(e.checkedAt),
				},
				certificadoValidoAte: iso(e.certNotAfter),
				perfil: await lerPerfil(c.env.DB, e.id),
			})),
		);
		return c.json({ cenarios: CENARIOS, emitentes, ambiente: "homologacao" });
	});

	app.put("/admin/testes/perfis/:id", async (c: C) => {
		if (c.get("origem") !== "admin") {
			return erro(c, 401, "nao_autorizado", "Só o administrador altera o perfil de teste.");
		}
		const emitter = await db.getEmitterById(c.env.DB, c.req.param("id") ?? "");
		if (!emitter) return erro(c, 404, "nao_encontrado", "Emitente inexistente.");
		const perfil = PerfilTeste.safeParse(await c.req.json().catch(() => null));
		if (!perfil.success) {
			const issue = perfil.error.issues[0];
			return erro(c, 400, "requisicao_invalida", `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "inválido"}`);
		}
		await gravarPerfil(c.env.DB, emitter.id, perfil.data);
		return c.json({ perfil: perfil.data });
	});

	app.post("/admin/testes/execucoes", async (c: C) => {
		const input = Executar.safeParse(await c.req.json().catch(() => null));
		if (!input.success) return erro(c, 400, "requisicao_invalida", "Informe o emitente e, se quiser, os cenários.");
		const emitter = await db.getEmitterById(c.env.DB, input.data.emitente);
		if (!emitter) return erro(c, 404, "nao_encontrado", "Emitente inexistente.");

		const ids = input.data.cenarios ?? CENARIOS.filter((x) => x.disponivel).map((x) => x.id);
		const escolhidos = ids.map((id) => CENARIOS.find((x) => x.id === id));
		if (escolhidos.some((x) => !x)) return erro(c, 400, "cenario_desconhecido", "Há um cenário desconhecido na lista.");

		const perfil = await lerPerfil(c.env.DB, emitter.id);
		const vault = await deps.vaultFor(c, emitter);
		// Em sequência: os cenários compartilham o mesmo cofre e a mesma série de teste.
		const execucoes = [];
		for (const cenario of escolhidos) {
			if (cenario) execucoes.push(await executarCenario(c.env.DB, vault, emitter, perfil, cenario, c.get("origem")));
		}
		return c.json({
			aprovado: execucoes.every((e) => e.resultado === "aprovado"),
			execucoes,
		});
	});

	app.get("/admin/testes/execucoes", async (c: C) => {
		const limite = Number(c.req.query("limite") ?? 50);
		return c.json({ execucoes: await listarExecucoes(c.env.DB, Number.isFinite(limite) ? limite : 50) });
	});
}
