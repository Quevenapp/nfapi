// Trabalho periódico do cofre (Cron Trigger, a cada 5 minutos): quando há
// NFC-e em contingência, confere se a SEFAZ voltou e transmite a fila.
//
// Sem pendência, não faz nada: nem abre o certificado, nem acorda o Container.

import type { AppEnv } from "./app";
import { secretIsStrong } from "./crypto";
import * as banco from "./emissao/banco";
import { type ResumoPendencias, processarPendencias } from "./emissao/nfe";
import { OperacaoError, abrirOperacoes } from "./operacoes";
import * as store from "./store";
import type { Transport } from "./transport";

export async function executarAgendado(env: AppEnv, transport: Transport): Promise<ResumoPendencias | null> {
	if (!secretIsStrong(env.VAULT_SECRET)) return null;
	const [pendentes, estados] = await Promise.all([
		banco.listPendentesDeContingencia(env.DB, 1),
		store.listSettingKeys(env.DB, "contingencia_nfce_"),
	]);
	if (pendentes.length === 0 && estados.length === 0) return null;
	try {
		const ops = await abrirOperacoes(env, transport, "agendador");
		const resumo = await processarPendencias(env.DB, ops);
		await store.audit(env.DB, { action: "contingencia.processar", actor: "agendador", outcome: "ok", detail: { ...resumo } });
		return resumo;
	} catch (err) {
		// Sem certificado (ou com ele vencido) não há o que transmitir.
		if (err instanceof OperacaoError) return null;
		throw err;
	}
}
