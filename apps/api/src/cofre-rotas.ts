// Rotas que o COFRE chama na API, autenticadas pelo pareamento (HMAC).
//
// O painel do usuário é a tela /setup do cofre. Para agir sobre as notas do
// próprio emitente (cancelar, por exemplo) o cofre assina a requisição com a
// chave do pareamento, a mesma que a API usa no sentido contrário. Assim o
// usuário não precisa digitar a chave de API no cofre.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { CancelamentoInput } from "@nfapi/nfse-nacional";
import { HEADERS, MAX_CLOCK_SKEW_SECONDS, sha256Hex, verifySignature } from "@nfapi/vault-client";
import { z } from "zod";
import { type C, type Ctx, type RotasDeps, erro } from "./comum";
import { open } from "./crypto";
import * as db from "./db";
import * as emissions from "./emissions";
import { nfseJson } from "./nfse";
import { cancelarNfse } from "./nfse-cancelamento";

const Cancelar = CancelamentoInput.extend({
	chaveAcesso: z.string().regex(/^[0-9A-Z]{50}$/, "chaveAcesso: 50 caracteres"),
});

/** Confere a assinatura do cofre e devolve o emitente dono do pareamento. */
async function autenticarCofre(c: C): Promise<{ emitter: db.Emitter; body: ArrayBuffer } | Response> {
	const pairingId = c.req.header(HEADERS.pairing) ?? "";
	const timestamp = c.req.header(HEADERS.timestamp) ?? "";
	const nonce = c.req.header(HEADERS.nonce) ?? "";
	const signature = c.req.header(HEADERS.signature) ?? "";
	const negar = () => erro(c, 401, "nao_autenticado", "Assinatura do cofre ausente ou inválida.");

	if (!/^[a-f0-9]{32}$/.test(pairingId) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return negar();
	const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
	if (!/^\d{9,11}$/.test(timestamp) || skew > MAX_CLOCK_SKEW_SECONDS) return negar();

	const body = await c.req.arrayBuffer();
	if (body.byteLength > 64 * 1024) return erro(c, 400, "requisicao_invalida", "Corpo grande demais.");
	const emitter = await db.findEmitterByPairingId(c.env.DB, pairingId);
	if (!emitter) return negar();

	const url = new URL(c.req.url);
	const key = await open(c.env.MASTER_KEY, emitter.id, emitter.pairingKeyIv, emitter.pairingKeyCt);
	const valida = await verifySignature(
		key,
		{
			method: c.req.method,
			path: url.pathname + url.search,
			timestamp,
			nonce,
			bodySha256: await sha256Hex(body),
		},
		signature,
	);
	if (!valida) return negar();

	// Só depois de autenticar, para terceiros não encherem a tabela.
	const agora = Math.floor(Date.now() / 1000);
	const novo = await c.env.DB.prepare("INSERT OR IGNORE INTO api_nonces (nonce, expires_at) VALUES (?, ?)")
		.bind(`${pairingId}:${nonce}`, agora + MAX_CLOCK_SKEW_SECONDS * 2)
		.run();
	if (novo.meta.changes === 0) return erro(c, 401, "requisicao_repetida", "Esta requisição já foi processada.");
	if (Math.random() < 0.05) {
		await c.env.DB.prepare("DELETE FROM api_nonces WHERE expires_at < ?").bind(agora).run();
	}
	return { emitter, body };
}

export function registrarRotasDoCofre(app: OpenAPIHono<Ctx>, deps: RotasDeps) {
	app.post("/cofre/nfse/cancelar", async (c: C) => {
		const auth = await autenticarCofre(c);
		if (auth instanceof Response) return auth;
		const { emitter } = auth;

		let json: unknown = null;
		try {
			json = JSON.parse(new TextDecoder().decode(auth.body));
		} catch {
			// tratado pela validação abaixo
		}
		const input = Cancelar.safeParse(json);
		if (!input.success) {
			const issue = input.error.issues[0];
			return erro(c, 400, "requisicao_invalida", issue?.message ?? "Pedido de cancelamento inválido.");
		}

		const emission = await emissions.findByAccessKey(
			c.env.DB,
			emitter.accountId,
			emitter.docId,
			input.data.chaveAcesso,
		);
		if (!emission) {
			return erro(c, 404, "nao_encontrado", "Esta nota não foi emitida por esta API para o seu emitente.");
		}

		const r = await cancelarNfse(c.env.DB, await deps.vaultFor(c, emitter), emitter, emission, input.data);
		if (!r.ok) return c.json({ erro: { codigo: r.codigo, mensagem: r.mensagem }, mensagens: r.mensagens }, r.status);
		return c.json({ nfse: nfseJson(r.emission), jaCancelada: r.jaCancelada });
	});
}
