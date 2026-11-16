// Emissão REAL de uma NF-e ou NFC-e de teste na HOMOLOGAÇÃO da SEFAZ.
//
// Roda tudo nesta máquina, com o mesmo código que o cofre usa:
//   pedido (JSON) -> XML -> assinatura com o certificado A1 -> proxy mTLS -> SEFAZ
//
// A nota gerada não tem valor fiscal, mas é emitida em nome do titular do
// certificado. O certificado e a senha não saem desta máquina.
// O script nunca envia para produção.
//
// Uso:
//   pnpm emitir-nfe-teste <certificado.pfx> <pedido.json> [opções]
//   pnpm emitir-nfe-teste <certificado.pfx> --status <UF>
//   pnpm emitir-nfe-teste <certificado.pfx> --cancelar <arquivo-nfe.xml> "justificativa"
//
// Opções da emissão:
//   --nfce          o pedido é de NFC-e (modelo 65); o padrão é NF-e (modelo 55)
//   --numero <n>    número da nota (padrão: 1)
//   --nao-enviar    monta e assina o XML, grava em tools/saida e para
//   --sim           não pede confirmação antes de enviar
//
// A senha é pedida no terminal (ou lida da variável NFAPI_PFX_SENHA).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { autorizadorNfe } from "../vault/src/fiscal/dados.ts";
import { CODIGO_UF, gerarCodigoNumerico } from "../vault/src/nfe/chave.ts";
import { montarCancelamentoNfe } from "../vault/src/nfe/eventos.ts";
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

function sair(mensagem: string, codigo = 1): never {
	console.error(`\n${mensagem}`);
	process.exit(codigo);
}

const args = process.argv.slice(2);
const opcao = (nome: string, posicao = 1) => {
	const i = args.indexOf(nome);
	return i >= 0 ? args[i + posicao] : undefined;
};
const COM_VALOR = ["--numero", "--status"];
const posicionais = args.filter((a, i) => !a.startsWith("--") && !COM_VALOR.includes(args[i - 1] ?? "") && args[i - 1] !== "--cancelar" && args[i - 2] !== "--cancelar");
const [arquivoPfx, arquivoPedido] = posicionais;
const modo = args.includes("--status") ? "status" : args.includes("--cancelar") ? "cancelar" : "emitir";
if (!arquivoPfx || !fs.existsSync(arquivoPfx) || (modo === "emitir" && (!arquivoPedido || !fs.existsSync(arquivoPedido)))) {
	sair("Uso: pnpm emitir-nfe-teste <certificado.pfx> <pedido.json> [--nfce] [--numero N] [--nao-enviar] [--sim]\n     pnpm emitir-nfe-teste <certificado.pfx> --status <UF>\n     pnpm emitir-nfe-teste <certificado.pfx> --cancelar <arquivo-nfe.xml> \"justificativa\"", 2);
}

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
async function chamar(modelo: "55" | "65", uf: string, servico: Servico, dados: string) {
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
	console.log(`POST ${requisicao.url}\nHTTP ${lido.status} em ${lido.ms} ms (${lido.tls.protocol})`);
	return { status: lido.status, corpo };
}
const encerrar = (codigo: number): never => {
	proxy?.server.close();
	process.exit(codigo);
};
fs.mkdirSync(SAIDA, { recursive: true });

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

// ---------- Cancelamento ----------

if (modo === "cancelar") {
	const arquivo = opcao("--cancelar") ?? "";
	const justificativa = opcao("--cancelar", 2) ?? "";
	if (!fs.existsSync(arquivo) || justificativa.trim().length < 15) sair('Uso: --cancelar <arquivo-nfe.xml> "justificativa com 15 caracteres ou mais"', 2);
	const xml = fs.readFileSync(arquivo, "utf8");
	const chave = /Id="NFe([0-9A-Z]{44})"/.exec(xml)?.[1];
	const protocolo = /<nProt>(\d+)<\/nProt>/.exec(xml)?.[1];
	const uf = Object.entries(CODIGO_UF).find(([, codigo]) => codigo === chave?.slice(0, 2))?.[0];
	if (!chave || !protocolo || !uf) sair("O arquivo não é uma NF-e autorizada (nfeProc) gerada por este script.");
	if (!/<tpAmb>2<\/tpAmb>/.test(xml)) sair("Este script só cancela notas de homologação.");
	const modelo = chave.slice(20, 22) as "55" | "65";
	const evento = montarCancelamentoNfe({ ambiente: AMBIENTE, cnpj: chave.slice(6, 20), chave }, protocolo, justificativa.trim());
	const assinado = assinar(evento.xml, "infEvento");
	const { status, corpo } = await chamar(modelo, uf, "evento", envEvento(assinado, String(Date.now())));
	fs.writeFileSync(path.join(SAIDA, `${chave}-cancelamento-resposta.xml`), corpo);
	const r = lerRespostaEventoNfe(status, corpo);
	if (r.tipo === "registrado") {
		const destino = path.join(SAIDA, `${chave}-cancelamento.xml`);
		fs.writeFileSync(destino, procEventoNFe(assinado, r.retEvento));
		console.log(`\nCANCELAMENTO REGISTRADO: [${r.mensagem.codigo}] ${r.mensagem.descricao}\n  Protocolo: ${r.protocolo}\n  Gravado em: ${destino}`);
		encerrar(0);
	}
	console.log(`\nCancelamento NÃO registrado: ${r.tipo === "indefinida" ? r.detalhe : `[${r.mensagem.codigo}] ${r.mensagem.descricao}`}`);
	encerrar(1);
}

// ---------- Emissão ----------

const nfce = args.includes("--nfce");
let bruto: Record<string, unknown>;
try {
	bruto = JSON.parse(fs.readFileSync(arquivoPedido as string, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
} catch (err) {
	sair(`O pedido não é um JSON válido: ${err instanceof Error ? err.message : err}`);
}
const lido = (nfce ? NfceInput : NfeInput).safeParse(bruto);
if (!lido.success) {
	const problemas = lido.error.issues.map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`);
	sair(`O pedido tem ${problemas.length} problema(s):\n${problemas.join("\n")}`);
}
const modelo = nfce ? "65" : "55";
const pedido = { ...lido.data, modelo } as PedidoNfe;
const uf = pedido.emitente.endereco.uf;
const autorizador = autorizadorNfe(modelo, uf, AMBIENTE);
if (!autorizador) sair(`A UF ${uf} ainda não tem autorizador configurado para o modelo ${modelo}.`);
const numero = Number(opcao("--numero") ?? 1);
const serie = pedido.serie ?? 1;
if (!Number.isInteger(numero) || numero < 1) sair("--numero deve ser um inteiro positivo.", 2);

const montada = montarNfe(pedido, {
	ambiente: AMBIENTE,
	cnpj: pedido.emitente.cnpj ?? cert.holder.id,
	serie,
	numero,
	cNF: gerarCodigoNumerico(numero),
	versaoAplicativo: "NFapi-teste",
});
let xml = montada.xml;
if (nfce && autorizador.nfce) {
	const supl = suplementoNfce(montada.chave, AMBIENTE, autorizador.nfce);
	xml = comSuplementoNfce(xml, supl.qrCode, supl.urlChave);
}
const assinada = assinar(xml, "infNFe");
const arquivoEnviado = path.join(SAIDA, `${montada.chave}-enviada.xml`);
fs.writeFileSync(arquivoEnviado, assinada);

console.log(`
Emitente   : ${cert.commonName}
Ambiente   : homologação (sem valor fiscal)    Autorizador: ${autorizador.nome}
Documento  : ${nfce ? "NFC-e (modelo 65)" : "NF-e (modelo 55)"}, série ${serie}, número ${numero}
Chave      : ${montada.chave}
Itens      : ${pedido.itens.length}    Valor total: R$ ${montada.total.toFixed(2)}
XML gravado: ${arquivoEnviado}
`);

if (args.includes("--nao-enviar")) {
	console.log("--nao-enviar: nada foi transmitido.");
	process.exit(0);
}
if (!args.includes("--sim")) {
	const resposta = await perguntar(`Enviar esta nota à SEFAZ de ${uf} em HOMOLOGAÇÃO? [s/N] `);
	if (resposta.trim().toLowerCase() !== "s") sair("Cancelado: nada foi transmitido.", 0);
}

let envio = await chamar(modelo, uf, "autorizacao", enviNFe(assinada, String(Date.now())));
fs.writeFileSync(path.join(SAIDA, `${montada.chave}-resposta.xml`), envio.corpo);
let resposta = lerRespostaAutorizacao(envio.status, envio.corpo, montada.chave);
for (let i = 0; resposta.tipo === "em_processamento" && i < 5; i++) {
	await new Promise((resolve) => setTimeout(resolve, 2000));
	envio = await chamar(modelo, uf, "retAutorizacao", consReciNFe("2", resposta.recibo));
	resposta = lerRespostaAutorizacao(envio.status, envio.corpo, montada.chave);
}

if (resposta.tipo === "autorizada") {
	const destino = path.join(SAIDA, `${montada.chave}-nfe.xml`);
	fs.writeFileSync(destino, nfeProc(assinada, resposta.protNFe));
	console.log(`\nNOTA AUTORIZADA: [${resposta.mensagem.codigo}] ${resposta.mensagem.descricao}
  Chave de acesso: ${montada.chave}
  Protocolo      : ${resposta.protocolo}
  Autorizada em  : ${resposta.recebidaEm ?? "(não informado)"}
  XML gravado em : ${destino}`);
	encerrar(0);
}
if (resposta.tipo === "rejeitada" || resposta.tipo === "denegada") {
	console.log(`\nNota ${resposta.tipo === "denegada" ? "DENEGADA" : "REJEITADA"} pela SEFAZ:\n  [${resposta.mensagem.codigo}] ${resposta.mensagem.descricao}`);
	encerrar(1);
}
const detalhe = resposta.tipo === "em_processamento" ? `lote ainda em processamento (recibo ${resposta.recibo})` : resposta.detalhe;
console.log(`\nResposta INDEFINIDA: ${detalhe}\nInício do corpo recebido:\n${envio.corpo.slice(0, 800)}`);
encerrar(1);
