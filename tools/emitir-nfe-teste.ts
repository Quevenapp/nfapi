// Emissão REAL de NF-e e NFC-e de teste na HOMOLOGAÇÃO da SEFAZ.
//
// Roda tudo nesta máquina, com o mesmo código que o cofre usa:
//   pedido (JSON) -> XML -> assinatura com o certificado A1 -> proxy mTLS -> SEFAZ
//
// As notas geradas não têm valor fiscal, mas são emitidas em nome do titular
// do certificado. O certificado e a senha não saem desta máquina.
// O script nunca envia para produção.
//
// Uso:
//   pnpm emitir-nfe-teste <certificado.pfx> <pedido.json> [opções]
//   pnpm emitir-nfe-teste <certificado.pfx> --completo <pedido-nfe.json> <pedido-nfce.json>
//   pnpm emitir-nfe-teste <certificado.pfx> --status <UF>
//   pnpm emitir-nfe-teste <certificado.pfx> --cancelar <arquivo-nfe.xml> "justificativa"
//
// Opções da emissão:
//   --nfce                      o pedido é de NFC-e (modelo 65); o padrão é NF-e (modelo 55)
//   --numero <n>                número da nota (padrão: 1)
//   --carta "<texto>"           depois de autorizada, registra uma carta de correção (só NF-e)
//   --cancelar-depois "<just>"  depois de autorizada, cancela a nota
//   --nao-enviar                monta e assina o XML, grava em tools/saida e para
//   --sim                       não pede confirmação antes de enviar
//
// --completo percorre o roteiro inteiro com uma só senha: NF-e (emite, corrige e
// cancela) e NFC-e (emite e cancela). Aceita --numero e --numero-nfce.
//
// A senha é pedida no terminal (ou lida da variável NFAPI_PFX_SENHA).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { autorizadorNfe } from "../vault/src/fiscal/dados.ts";
import { CODIGO_UF, gerarCodigoNumerico } from "../vault/src/nfe/chave.ts";
import { montarCancelamentoNfe, montarCartaCorrecao } from "../vault/src/nfe/eventos.ts";
import { suplementoNfce } from "../vault/src/nfe/qrcode.ts";
import { NfceInput, NfeInput, type PedidoNfe } from "../vault/src/nfe/schema.ts";
import {
	type Servico,
	consReciNFe,
	consStatServ,
	envEvento,
	enviNFe,
	lerRespostaAutorizacao,
	lerRespostaEventoNfe,
	lerStatusServico,
	nfeProc,
	procEventoNFe,
	requisicaoSoap,
} from "../vault/src/nfe/sefaz.ts";
import { comSuplementoNfce, montarNfe } from "../vault/src/nfe/xml.ts";
import { parsePfx } from "../vault/src/pfx.ts";
import { SignError, signXml } from "../vault/src/signer.ts";

const AMBIENTE = "homologacao" as const; // fixo de propósito.
const SAIDA = path.join(import.meta.dirname, "saida");
const JUSTIFICATIVA = "Nota de teste emitida em homologacao pelo NFapi";
type Modelo = "55" | "65";

function sair(mensagem: string, codigo = 1): never {
	console.error(`\n${mensagem}`);
	process.exit(codigo);
}

// ---------- Argumentos ----------

const args = process.argv.slice(2);
/** Quantos valores cada opção consome. */
const VALORES: Record<string, number> = { "--numero": 1, "--numero-nfce": 1, "--status": 1, "--carta": 1, "--cancelar-depois": 1, "--cancelar": 2, "--completo": 2 };
const consumidos = new Set<number>();
args.forEach((a, i) => {
	for (let k = 1; k <= (VALORES[a] ?? 0); k++) consumidos.add(i + k);
});
const opcao = (nome: string, posicao = 1) => {
	const i = args.indexOf(nome);
	return i >= 0 ? args[i + posicao] : undefined;
};
const [arquivoPfx, arquivoPedido] = args.filter((a, i) => !a.startsWith("--") && !consumidos.has(i));
const modo = args.includes("--status") ? "status" : args.includes("--cancelar") ? "cancelar" : args.includes("--completo") ? "completo" : "emitir";
const USO =
	'Uso: pnpm emitir-nfe-teste <certificado.pfx> <pedido.json> [--nfce] [--numero N] [--carta "texto"] [--cancelar-depois "justificativa"] [--nao-enviar] [--sim]\n' +
	"     pnpm emitir-nfe-teste <certificado.pfx> --completo <pedido-nfe.json> <pedido-nfce.json>\n" +
	"     pnpm emitir-nfe-teste <certificado.pfx> --status <UF>\n" +
	'     pnpm emitir-nfe-teste <certificado.pfx> --cancelar <arquivo-nfe.xml> "justificativa"';
if (!arquivoPfx || !fs.existsSync(arquivoPfx) || (modo === "emitir" && (!arquivoPedido || !fs.existsSync(arquivoPedido)))) sair(USO, 2);

const inteiro = (nome: string) => {
	const n = Number(opcao(nome) ?? 1);
	if (!Number.isInteger(n) || n < 1) sair(`${nome} deve ser um inteiro positivo.`, 2);
	return n;
};

function perguntar(pergunta: string, oculto = false): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		let mudo = false;
		// biome-ignore lint/suspicious/noExplicitAny: API interna do readline para não ecoar a senha
		(rl as any)._writeToOutput = (texto: string) => {
			if (!mudo) process.stdout.write(texto);
		};
		rl.question(pergunta, (resposta) => {
			rl.close();
			if (oculto) process.stdout.write("\n");
			resolve(resposta);
		});
		mudo = oculto;
	});
}

// ---------- Certificado ----------

const senha = process.env.NFAPI_PFX_SENHA ?? (await perguntar("Senha do certificado: ", true));
let cert: ReturnType<typeof parsePfx>;
try {
	cert = parsePfx(new Uint8Array(fs.readFileSync(arquivoPfx)), senha);
} catch (err) {
	sair(`Não foi possível ler o certificado: ${err instanceof Error ? err.message : err}`);
}
if (cert.notAfter.getTime() < Date.now()) sair("O certificado está vencido.");
if (cert.holder.kind !== "cnpj") sair("A NF-e de teste precisa de um certificado de pessoa jurídica (CNPJ).");

const assinar = (xml: string, tag: "infNFe" | "infEvento") => {
	try {
		return signXml({ xml, tag, profile: "rsa-sha1", privateKeyPem: cert.privateKeyPem, certificatePem: cert.certificatePem, holder: cert.holder, allowProduction: false }).xml;
	} catch (err) {
		sair(`Falha ao assinar: ${err instanceof SignError ? `${err.code} — ${err.message}` : err}`);
	}
};

// ---------- Transmissão pelo proxy mTLS (o mesmo código do Container) ----------

let proxy: { server: import("node:http").Server; porta: number } | undefined;
async function chamar(modelo: Modelo, uf: string, servico: Servico, dados: string) {
	const autorizador = autorizadorNfe(modelo, uf, AMBIENTE);
	if (!autorizador) sair(`A UF ${uf} ainda não tem autorizador configurado para o modelo ${modelo}.`);
	if (!proxy) {
		const { server } = (await import("../vault/container/server.mjs")) as { server: import("node:http").Server };
		const porta = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port)));
		proxy = { server, porta };
	}
	const requisicao = requisicaoSoap(servico, autorizador.servicos[servico], dados, "teste");
	const res = await fetch(`http://127.0.0.1:${proxy.porta}/transmit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...requisicao, certPem: cert.certificatePem, chainPem: cert.chainPem, keyPem: cert.privateKeyPem }),
	});
	const lido = (await res.json()) as { error?: { code: string; message: string }; status: number; bodyB64: string; ms: number; tls: { protocol: string } };
	if (lido.error) sair(`A conexão com a SEFAZ falhou: ${lido.error.code} — ${lido.error.message}`);
	const corpo = Buffer.from(lido.bodyB64, "base64").toString("utf8");
	console.log(`POST ${requisicao.url}  ->  HTTP ${lido.status} em ${lido.ms} ms (${lido.tls.protocol})`);
	return { status: lido.status, corpo };
}
const encerrar = (codigo: number): never => {
	proxy?.server.close();
	process.exit(codigo);
};
fs.mkdirSync(SAIDA, { recursive: true });

// ---------- Nota: preparar e transmitir ----------

interface Nota {
	modelo: Modelo;
	uf: string;
	chave: string;
	assinada: string;
	resumo: string;
}

function prepararNota(arquivo: string, nfce: boolean, numero: number): Nota {
	let bruto: unknown;
	try {
		bruto = JSON.parse(fs.readFileSync(arquivo, "utf8").replace(/^﻿/, ""));
	} catch (err) {
		sair(`${arquivo} não é um JSON válido: ${err instanceof Error ? err.message : err}`);
	}
	const lido = (nfce ? NfceInput : NfeInput).safeParse(bruto);
	if (!lido.success) {
		const problemas = lido.error.issues.map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`);
		sair(`${arquivo} tem ${problemas.length} problema(s):\n${problemas.join("\n")}`);
	}
	const modelo: Modelo = nfce ? "65" : "55";
	const pedido = { ...lido.data, modelo } as PedidoNfe;
	const uf = pedido.emitente.endereco.uf;
	const autorizador = autorizadorNfe(modelo, uf, AMBIENTE);
	if (!autorizador) sair(`A UF ${uf} ainda não tem autorizador configurado para o modelo ${modelo}.`);
	const serie = pedido.serie ?? 1;
	const montada = montarNfe(pedido, { ambiente: AMBIENTE, cnpj: pedido.emitente.cnpj ?? cert.holder.id, serie, numero, cNF: gerarCodigoNumerico(numero), versaoAplicativo: "NFapi-teste" });
	let xml = montada.xml;
	if (nfce && autorizador.nfce) {
		const supl = suplementoNfce(montada.chave, AMBIENTE, autorizador.nfce);
		xml = comSuplementoNfce(xml, supl.qrCode, supl.urlChave);
	}
	const assinada = assinar(xml, "infNFe");
	fs.writeFileSync(path.join(SAIDA, `${montada.chave}-enviada.xml`), assinada);
	const resumo = `${nfce ? "NFC-e (modelo 65)" : "NF-e (modelo 55)"}, série ${serie}, número ${numero}, ${pedido.itens.length} item(ns), R$ ${montada.total.toFixed(2)}, autorizador ${autorizador.nome}\n             chave ${montada.chave}`;
	return { modelo, uf, chave: montada.chave, assinada, resumo };
}

/** Transmite a nota. Devolve o protocolo quando autorizada; null nos demais casos. */
async function transmitirNota(nota: Nota): Promise<string | null> {
	let envio = await chamar(nota.modelo, nota.uf, "autorizacao", enviNFe(nota.assinada, String(Date.now())));
	fs.writeFileSync(path.join(SAIDA, `${nota.chave}-resposta.xml`), envio.corpo);
	let resposta = lerRespostaAutorizacao(envio.status, envio.corpo, nota.chave);
	for (let i = 0; resposta.tipo === "em_processamento" && i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		envio = await chamar(nota.modelo, nota.uf, "retAutorizacao", consReciNFe("2", resposta.recibo));
		resposta = lerRespostaAutorizacao(envio.status, envio.corpo, nota.chave);
	}
	if (resposta.tipo === "autorizada") {
		const destino = path.join(SAIDA, `${nota.chave}-nfe.xml`);
		fs.writeFileSync(destino, nfeProc(nota.assinada, resposta.protNFe));
		console.log(`  NOTA AUTORIZADA: [${resposta.mensagem.codigo}] ${resposta.mensagem.descricao}
    Chave de acesso: ${nota.chave}
    Protocolo      : ${resposta.protocolo}
    Autorizada em  : ${resposta.recebidaEm ?? "(não informado)"}
    XML gravado em : ${destino}\n`);
		return resposta.protocolo;
	}
	if (resposta.tipo === "rejeitada" || resposta.tipo === "denegada") {
		console.log(`  Nota ${resposta.tipo === "denegada" ? "DENEGADA" : "REJEITADA"} pela SEFAZ: [${resposta.mensagem.codigo}] ${resposta.mensagem.descricao}\n`);
		return null;
	}
	const detalhe = resposta.tipo === "em_processamento" ? `lote ainda em processamento (recibo ${resposta.recibo})` : resposta.detalhe;
	console.log(`  Resposta INDEFINIDA: ${detalhe}\n  Início do corpo recebido:\n${envio.corpo.slice(0, 800)}\n`);
	return null;
}

/** Assina e transmite um evento. Devolve true quando a SEFAZ o registra. */
async function registrarEvento(modelo: Modelo, uf: string, chave: string, evento: { xml: string }, nome: string, sufixo: string): Promise<boolean> {
	const assinado = assinar(evento.xml, "infEvento");
	const { status, corpo } = await chamar(modelo, uf, "evento", envEvento(assinado, String(Date.now())));
	fs.writeFileSync(path.join(SAIDA, `${chave}-${sufixo}-resposta.xml`), corpo);
	const r = lerRespostaEventoNfe(status, corpo);
	if (r.tipo === "registrado") {
		fs.writeFileSync(path.join(SAIDA, `${chave}-${sufixo}.xml`), procEventoNFe(assinado, r.retEvento));
		console.log(`  ${nome} REGISTRADO: [${r.mensagem.codigo}] ${r.mensagem.descricao} (protocolo ${r.protocolo})\n`);
		return true;
	}
	console.log(`  ${nome} NÃO registrado: ${r.tipo === "indefinida" ? r.detalhe : `[${r.mensagem.codigo}] ${r.mensagem.descricao}`}\n`);
	return false;
}

const cnpjDaChave = (chave: string) => chave.slice(6, 20);
const carta = (nota: Pick<Nota, "modelo" | "uf" | "chave">, texto: string) =>
	registrarEvento(nota.modelo, nota.uf, nota.chave, montarCartaCorrecao({ ambiente: AMBIENTE, cnpj: cnpjDaChave(nota.chave), chave: nota.chave }, 1, texto), "Carta de correção", "cce-01");
const cancelar = (nota: Pick<Nota, "modelo" | "uf" | "chave">, protocolo: string, justificativa: string) =>
	registrarEvento(nota.modelo, nota.uf, nota.chave, montarCancelamentoNfe({ ambiente: AMBIENTE, cnpj: cnpjDaChave(nota.chave), chave: nota.chave }, protocolo, justificativa), "Cancelamento", "cancelamento");

async function confirmar(pergunta: string) {
	if (args.includes("--sim")) return;
	const resposta = await perguntar(`${pergunta} [s/N] `);
	if (resposta.trim().toLowerCase() !== "s") sair("Cancelado: nada foi transmitido.", 0);
}

// ---------- Status do serviço ----------

if (modo === "status") {
	const uf = (opcao("--status") ?? "").toUpperCase();
	if (!CODIGO_UF[uf]) sair("Informe a UF: --status SP", 2);
	for (const modelo of ["55", "65"] as const) {
		if (!autorizadorNfe(modelo, uf, AMBIENTE)) continue;
		const { corpo } = await chamar(modelo, uf, "status", consStatServ("2", CODIGO_UF[uf] as string));
		const status = lerStatusServico(corpo);
		console.log(`  modelo ${modelo}: ${status ? `[${status.mensagem.codigo}] ${status.mensagem.descricao}` : `sem retorno reconhecível: ${corpo.slice(0, 300)}`}\n`);
	}
	encerrar(0);
}

// ---------- Cancelamento de uma nota já autorizada ----------

if (modo === "cancelar") {
	const arquivo = opcao("--cancelar") ?? "";
	const justificativa = (opcao("--cancelar", 2) ?? "").trim();
	if (!fs.existsSync(arquivo) || justificativa.length < 15) sair('Uso: --cancelar <arquivo-nfe.xml> "justificativa com 15 caracteres ou mais"', 2);
	const xml = fs.readFileSync(arquivo, "utf8");
	const chave = /Id="NFe([0-9A-Z]{44})"/.exec(xml)?.[1];
	const protocolo = /<nProt>(\d+)<\/nProt>/.exec(xml)?.[1];
	const uf = Object.entries(CODIGO_UF).find(([, codigo]) => codigo === chave?.slice(0, 2))?.[0];
	if (!chave || !protocolo || !uf) sair("O arquivo não é uma NF-e autorizada (nfeProc) gerada por este script.");
	if (!/<tpAmb>2<\/tpAmb>/.test(xml)) sair("Este script só cancela notas de homologação.");
	encerrar((await cancelar({ modelo: chave.slice(20, 22) as Modelo, uf, chave }, protocolo, justificativa)) ? 0 : 1);
}

// ---------- Roteiro completo ----------

if (modo === "completo") {
	const [pedidoNfe, pedidoNfce] = [opcao("--completo", 1) ?? "", opcao("--completo", 2) ?? ""];
	if (!fs.existsSync(pedidoNfe) || !fs.existsSync(pedidoNfce)) sair(USO, 2);
	const nfe = prepararNota(pedidoNfe, false, inteiro("--numero"));
	const nfce = prepararNota(pedidoNfce, true, inteiro("--numero-nfce"));
	console.log(`
Emitente   : ${cert.commonName}
Ambiente   : homologação (sem valor fiscal)

Roteiro:
  1. Emitir   ${nfe.resumo}
  2. Registrar uma carta de correção nessa NF-e
  3. Cancelar essa NF-e
  4. Emitir   ${nfce.resumo}
  5. Cancelar essa NFC-e
`);
	await confirmar("Executar o roteiro na SEFAZ em HOMOLOGAÇÃO?");

	const passos: [string, boolean][] = [];
	console.log("\n[1] NF-e: emissão");
	const protocoloNfe = await transmitirNota(nfe);
	passos.push(["NF-e: emissão", protocoloNfe !== null]);
	if (protocoloNfe) {
		console.log("[2] NF-e: carta de correção");
		passos.push(["NF-e: carta de correção", await carta(nfe, "Correcao de teste: informacoes complementares da nota")]);
		console.log("[3] NF-e: cancelamento");
		passos.push(["NF-e: cancelamento", await cancelar(nfe, protocoloNfe, JUSTIFICATIVA)]);
	}
	console.log("[4] NFC-e: emissão");
	const protocoloNfce = await transmitirNota(nfce);
	passos.push(["NFC-e: emissão", protocoloNfce !== null]);
	if (protocoloNfce) {
		console.log("[5] NFC-e: cancelamento");
		passos.push(["NFC-e: cancelamento", await cancelar(nfce, protocoloNfce, JUSTIFICATIVA)]);
	}
	console.log("Resultado do roteiro:");
	for (const [nome, ok] of passos) console.log(`  ${ok ? "OK    " : "FALHOU"}  ${nome}`);
	encerrar(passos.every(([, ok]) => ok) ? 0 : 1);
}

// ---------- Emissão de uma nota ----------

const nota = prepararNota(arquivoPedido as string, args.includes("--nfce"), inteiro("--numero"));
console.log(`
Emitente   : ${cert.commonName}
Ambiente   : homologação (sem valor fiscal)
Documento  : ${nota.resumo}
`);
if (args.includes("--nao-enviar")) {
	console.log("--nao-enviar: nada foi transmitido.");
	process.exit(0);
}
await confirmar(`Enviar esta nota à SEFAZ de ${nota.uf} em HOMOLOGAÇÃO?`);

const protocolo = await transmitirNota(nota);
if (!protocolo) encerrar(1);
let tudoCerto = true;
const textoDaCarta = opcao("--carta");
if (textoDaCarta && nota.modelo === "55") tudoCerto = (await carta(nota, textoDaCarta)) && tudoCerto;
const justificativa = opcao("--cancelar-depois");
if (justificativa) tudoCerto = (await cancelar(nota, protocolo as string, justificativa)) && tudoCerto;
encerrar(tudoCerto ? 0 : 1);
