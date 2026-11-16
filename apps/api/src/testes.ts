// Testes de homologação: cenários que exercitam o caminho real (API -> cofre ->
// governo) com o certificado do emitente, SEMPRE no ambiente de homologação.
//
// São executados pela página do admin e pela IA (antes de aplicar uma
// atualização), pelo mesmo ponto de entrada.

import { statusHomologacao } from "@nfapi/fiscal-data";
import { NfseInput, base64ParaTexto, textoParaBase64 } from "@nfapi/nfse-nacional";
import { PROTOCOL_VERSION, type VaultClient, VaultError } from "@nfapi/vault-client";
import { z } from "zod";
import { newId } from "./crypto";
import type * as db from "./db";
import { emitirNfse } from "./nfse-emissao";

export const PerfilTeste = z.object({
	/** Município da empresa (código IBGE, 7 dígitos). Os 2 primeiros dígitos são a UF. */
	codigoMunicipio: z.string().regex(/^\d{7}$/, "codigoMunicipio: 7 dígitos (IBGE)"),
	codigoTributacaoNacional: z.string().regex(/^\d{6}$/, "codigoTributacaoNacional: 6 dígitos"),
	simplesNacional: z.enum(["nao_optante", "mei", "me_epp"]),
	apuracaoSimples: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
	/** Série reservada aos testes, para não misturar com a numeração de uso real. */
	serie: z.string().regex(/^\d{1,5}$/).default("900"),
});
export type PerfilTeste = z.infer<typeof PerfilTeste>;

export type Origem = "admin" | "ia";
export type ResultadoTeste = "aprovado" | "reprovado" | "erro";

export interface Cenario {
	id: string;
	documento: "cofre" | "nfse" | "nfe" | "nfce";
	nome: string;
	descricao: string;
	disponivel: boolean;
	/** Por que ainda não dá para executar. */
	motivo?: string;
	precisaDePerfil: boolean;
}

export const CENARIOS: Cenario[] = [
	{
		id: "cofre.conexao",
		documento: "cofre",
		nome: "Conexão com o cofre",
		descricao: "Confere o pareamento, a versão do protocolo e a validade do certificado instalado.",
		disponivel: true,
		precisaDePerfil: false,
	},
	{
		id: "nfse.emitir",
		documento: "nfse",
		nome: "NFS-e: emitir nota de teste",
		descricao: "Emite uma NFS-e de R$ 1,00 na produção restrita do Sistema Nacional, pelo fluxo completo da API.",
		disponivel: true,
		precisaDePerfil: true,
	},
	{
		id: "nfe.status",
		documento: "nfe",
		nome: "NF-e: status do serviço",
		descricao: "Consulta o NFeStatusServico4 do autorizador da UF em homologação, com mTLS.",
		disponivel: true,
		precisaDePerfil: true,
	},
	{
		id: "nfe.emitir",
		documento: "nfe",
		nome: "NF-e: emitir nota de teste",
		descricao: "Autoriza uma NF-e modelo 55 em homologação.",
		disponivel: false,
		motivo: "A emissão de NF-e ainda não foi implementada (Fase 3 do plano).",
		precisaDePerfil: true,
	},
	{
		id: "nfce.status",
		documento: "nfce",
		nome: "NFC-e: status do serviço",
		descricao: "Consulta o NFeStatusServico4 de NFC-e do autorizador da UF em homologação, com mTLS.",
		disponivel: true,
		precisaDePerfil: true,
	},
	{
		id: "nfce.emitir",
		documento: "nfce",
		nome: "NFC-e: emitir nota de teste",
		descricao: "Autoriza uma NFC-e modelo 65 em homologação.",
		disponivel: false,
		motivo: "A emissão de NFC-e ainda não foi implementada (Fase 4 do plano).",
		precisaDePerfil: true,
	},
];

export interface Execucao {
	id: string;
	emitente: string;
	nomeEmitente: string;
	cenario: string;
	origem: Origem;
	resultado: ResultadoTeste;
	resumo: string;
	detalhes: Record<string, unknown>;
	iniciadaEm: string;
	duracaoMs: number;
}

type Veredito = { resultado: ResultadoTeste; resumo: string; detalhes?: Record<string, unknown> };

const soapStatus = (cUF: string) =>
	`<?xml version="1.0" encoding="utf-8"?>` +
	`<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>` +
	`<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">` +
	`<consStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">` +
	`<tpAmb>2</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ>` +
	`</nfeDadosMsg></soap12:Body></soap12:Envelope>`;

async function testarConexao(vault: VaultClient): Promise<Veredito> {
	const health = await vault.health();
	const cert = health.certificate;
	const detalhes = {
		versaoCofre: health.version,
		protocolo: health.protocol,
		producaoLiberada: health.allowProduction,
		certificadoValidoAte: cert?.notAfter ?? null,
	};
	if (health.protocol !== PROTOCOL_VERSION) {
		return { resultado: "reprovado", resumo: `Cofre com protocolo ${health.protocol}; a API usa o ${PROTOCOL_VERSION}.`, detalhes };
	}
	if (!cert) return { resultado: "reprovado", resumo: "Cofre sem certificado instalado.", detalhes };
	const dias = Math.floor((Date.parse(cert.notAfter) - Date.now()) / 86_400_000);
	if (dias < 0) return { resultado: "reprovado", resumo: "O certificado do cofre venceu.", detalhes };
	return { resultado: "aprovado", resumo: `Cofre v${health.version} pareado; certificado válido por mais ${dias} dias.`, detalhes };
}

async function testarStatus(vault: VaultClient, modelo: "nfe" | "nfce", perfil: PerfilTeste, ref: string): Promise<Veredito> {
	const cUF = perfil.codigoMunicipio.slice(0, 2);
	const alvo = statusHomologacao(modelo, cUF);
	if (!alvo) {
		return {
			resultado: "erro",
			resumo: `O autorizador de ${modelo === "nfe" ? "NF-e" : "NFC-e"} da UF ${cUF} ainda não está mapeado.`,
		};
	}
	const res = await vault.transmit({
		url: alvo.status,
		method: "POST",
		headers: {
			"content-type":
				'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF"',
		},
		bodyB64: textoParaBase64(soapStatus(cUF)),
		timeoutMs: 30_000,
		ref,
	});
	const texto = base64ParaTexto(res.bodyB64);
	const cStat = /<cStat>(\d+)<\/cStat>/.exec(texto)?.[1];
	const xMotivo = /<xMotivo>([^<]+)<\/xMotivo>/.exec(texto)?.[1] ?? "";
	const detalhes = { autorizador: alvo.autorizador, url: alvo.status, http: res.status, cStat: cStat ?? null, xMotivo, ms: res.ms };
	if (cStat === "107") return { resultado: "aprovado", resumo: `${alvo.autorizador}: cStat 107 — ${xMotivo}`, detalhes };
	if (cStat) return { resultado: "reprovado", resumo: `${alvo.autorizador}: cStat ${cStat} — ${xMotivo}`, detalhes };
	return {
		resultado: "reprovado",
		resumo: `${alvo.autorizador} respondeu HTTP ${res.status} sem cStat${[401, 403, 495, 496].includes(res.status) ? " (certificado recusado)" : ""}.`,
		detalhes,
	};
}

async function testarEmissaoNfse(
	d1: D1Database,
	vault: VaultClient,
	emitter: db.Emitter,
	perfil: PerfilTeste,
	ref: string,
): Promise<Veredito> {
	const pedido = NfseInput.parse({
		serie: perfil.serie,
		prestador: {
			codigoMunicipio: perfil.codigoMunicipio,
			regimeTributario: {
				simplesNacional: perfil.simplesNacional,
				...(perfil.apuracaoSimples ? { apuracaoSimples: perfil.apuracaoSimples } : {}),
			},
		},
		servico: {
			codigoMunicipioPrestacao: perfil.codigoMunicipio,
			codigoTributacaoNacional: perfil.codigoTributacaoNacional,
			descricao: `Nota de teste de homologação do NFapi (${ref})`,
		},
		valores: { servico: 1 },
		tributacao: { issqn: {} },
	});
	const r = await emitirNfse(d1, vault, {
		accountId: emitter.accountId,
		emitter,
		// Fixo: os testes nunca tocam a produção.
		ambiente: "homologacao",
		referencia: ref,
		pedido,
	});
	if (r.tipo === "conflito") return { resultado: "erro", resumo: r.mensagem, detalhes: { codigo: r.codigo } };
	const e = r.emission;
	const detalhes = {
		emissao: e.id,
		serie: e.serie,
		numero: e.number,
		idDps: e.documentId,
		situacao: e.status,
		chaveAcesso: e.accessKey,
		numeroNfse: e.fiscalNumber,
		mensagens: e.messages,
		diario: e.journalKey,
	};
	if (r.tipo === "autorizada") {
		return { resultado: "aprovado", resumo: `NFS-e ${e.fiscalNumber ?? ""} autorizada (DPS ${e.number}, série ${e.serie}).`.replace("  ", " "), detalhes };
	}
	const codigos = e.messages.map((m) => m.codigo).filter(Boolean).join(", ");
	return {
		// Rejeição é resposta do governo (teste reprovado); o resto é falha de infraestrutura.
		resultado: e.status === "rejeitada" ? "reprovado" : "erro",
		resumo: `${e.status === "rejeitada" ? "Rejeitada pela SEFIN" : "Não transmitida ou sem resposta"}${codigos ? ` [${codigos}]` : ""}: ${r.mensagem}`,
		detalhes,
	};
}

/** Executa um cenário e grava o resultado no histórico. */
export async function executarCenario(
	d1: D1Database,
	vault: VaultClient,
	emitter: db.Emitter,
	perfil: PerfilTeste | null,
	cenario: Cenario,
	origem: Origem,
): Promise<Execucao> {
	const id = newId("tst");
	const inicio = Date.now();
	let veredito: Veredito;
	try {
		if (!cenario.disponivel) {
			veredito = { resultado: "erro", resumo: cenario.motivo ?? "Cenário indisponível." };
		} else if (cenario.precisaDePerfil && !perfil) {
			veredito = { resultado: "erro", resumo: "Preencha o perfil de teste do emitente antes de executar." };
		} else if (cenario.id === "cofre.conexao") {
			veredito = await testarConexao(vault);
		} else if (cenario.id === "nfse.emitir") {
			veredito = await testarEmissaoNfse(d1, vault, emitter, perfil as PerfilTeste, `teste-${id}`);
		} else if (cenario.id === "nfe.status" || cenario.id === "nfce.status") {
			veredito = await testarStatus(vault, cenario.documento as "nfe" | "nfce", perfil as PerfilTeste, id);
		} else {
			veredito = { resultado: "erro", resumo: "Cenário sem implementação." };
		}
	} catch (err) {
		// Falha do cofre ou do transporte: registra como erro, não derruba a execução.
		const codigo = err instanceof VaultError ? err.code : "erro_interno";
		const mensagem = err instanceof Error ? err.message : String(err);
		veredito = { resultado: "erro", resumo: `${codigo}: ${mensagem}`, detalhes: { codigo } };
	}

	const execucao: Execucao = {
		id,
		emitente: emitter.id,
		nomeEmitente: emitter.name,
		cenario: cenario.id,
		origem,
		resultado: veredito.resultado,
		resumo: veredito.resumo.slice(0, 500),
		detalhes: veredito.detalhes ?? {},
		iniciadaEm: new Date(inicio).toISOString(),
		duracaoMs: Date.now() - inicio,
	};
	await d1
		.prepare(
			`INSERT INTO test_runs (id, emitter_id, emitter_name, scenario, origin, status, summary, detail, started_at, duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			execucao.id,
			execucao.emitente,
			execucao.nomeEmitente,
			execucao.cenario,
			execucao.origem,
			execucao.resultado,
			execucao.resumo,
			JSON.stringify(execucao.detalhes),
			inicio,
			execucao.duracaoMs,
		)
		.run();
	return execucao;
}

export async function listarExecucoes(d1: D1Database, limite: number): Promise<Execucao[]> {
	const { results } = await d1
		.prepare("SELECT * FROM test_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
		.bind(Math.min(Math.max(limite, 1), 200))
		.all<Record<string, unknown>>();
	return results.map((r) => ({
		id: r.id as string,
		emitente: r.emitter_id as string,
		nomeEmitente: r.emitter_name as string,
		cenario: r.scenario as string,
		origem: r.origin as Origem,
		resultado: r.status as ResultadoTeste,
		resumo: r.summary as string,
		detalhes: JSON.parse(r.detail as string) as Record<string, unknown>,
		iniciadaEm: new Date(r.started_at as number).toISOString(),
		duracaoMs: r.duration_ms as number,
	}));
}

export async function lerPerfil(d1: D1Database, emitterId: string): Promise<PerfilTeste | null> {
	const row = await d1
		.prepare("SELECT profile FROM test_profiles WHERE emitter_id = ?")
		.bind(emitterId)
		.first<{ profile: string }>();
	return row ? (JSON.parse(row.profile) as PerfilTeste) : null;
}

export async function gravarPerfil(d1: D1Database, emitterId: string, perfil: PerfilTeste): Promise<void> {
	await d1
		.prepare(
			`INSERT INTO test_profiles (emitter_id, profile, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (emitter_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`,
		)
		.bind(emitterId, JSON.stringify(perfil), Date.now())
		.run();
}
