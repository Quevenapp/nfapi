// Emissão REAL de uma NFS-e de teste na PRODUÇÃO RESTRITA do Sistema Nacional.
//
// Roda tudo nesta máquina, com o mesmo código que o cofre usa:
//   pedido (JSON) -> DPS -> assinatura com o certificado A1 -> proxy mTLS -> SEFIN
//
// A nota gerada não tem valor fiscal (ambiente de testes), mas é emitida em nome
// do titular do certificado. O certificado e a senha não saem desta máquina.
// O script nunca envia para produção.
//
// Uso:
//   pnpm emitir-teste <certificado.pfx> <pedido.json> [opções]
//
// Opções:
//   --nao-enviar             monta e assina a DPS, grava em tools/saida e para
//   --assinatura <perfil>    rsa-sha256 (padrão) ou rsa-sha1
//   --numero <n>             número da DPS (substitui o do pedido)
//   --sim                    não pede confirmação antes de enviar
//
// A senha é pedida no terminal (ou lida da variável NFAPI_PFX_SENHA).

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { NFSE_NACIONAL, type PerfilAssinatura, nfseAmbiente } from "../vault/src/fiscal/dados.ts";
import { NfseInput, corpoEmissao, lerMensagens, lerRespostaEmissao, montarDps } from "../vault/src/nfse/index.ts";
import { parsePfx } from "../vault/src/pfx.ts";
import { SignError, signXml } from "../vault/src/signer.ts";

const AMBIENTE = "homologacao" as const; // produção restrita; fixo de propósito.
const SAIDA = path.join(import.meta.dirname, "saida");

function sair(mensagem: string, codigo = 1): never {
	console.error(`\n${mensagem}`);
	process.exit(codigo);
}

const args = process.argv.slice(2);
const opcao = (nome: string) => {
	const i = args.indexOf(nome);
	return i >= 0 ? args[i + 1] : undefined;
};
const posicionais = args.filter((a, i) => {
	if (a.startsWith("--")) return false;
	const anterior = args[i - 1];
	return anterior !== "--assinatura" && anterior !== "--numero";
});
const [arquivoPfx, arquivoPedido] = posicionais;
if (!arquivoPfx || !arquivoPedido || !fs.existsSync(arquivoPfx) || !fs.existsSync(arquivoPedido)) {
	sair("Uso: pnpm emitir-teste <certificado.pfx> <pedido.json> [--nao-enviar] [--assinatura rsa-sha1] [--numero N] [--sim]", 2);
}
const perfil = (opcao("--assinatura") ?? NFSE_NACIONAL.assinatura) as PerfilAssinatura;
if (perfil !== "rsa-sha1" && perfil !== "rsa-sha256") sair("--assinatura deve ser rsa-sha1 ou rsa-sha256.", 2);

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

// ---------- 1. Certificado ----------

const senha = process.env.NFAPI_PFX_SENHA ?? (await perguntar("Senha do certificado: ", true));
let cert: ReturnType<typeof parsePfx>;
try {
	cert = parsePfx(new Uint8Array(fs.readFileSync(arquivoPfx)), senha);
} catch (err) {
	sair(`Não foi possível ler o certificado: ${err instanceof Error ? err.message : err}`);
}
if (cert.notAfter.getTime() < Date.now()) sair("O certificado está vencido.");

// ---------- 2. Pedido ----------

let bruto: Record<string, unknown>;
try {
	bruto = JSON.parse(fs.readFileSync(arquivoPedido, "utf8").replace(/^﻿/, "")) as Record<string, unknown>;
} catch (err) {
	sair(`O pedido não é um JSON válido: ${err instanceof Error ? err.message : err}`);
}
if (opcao("--numero")) bruto.numero = Number(opcao("--numero"));

const lido = NfseInput.safeParse(bruto);
if (!lido.success) {
	const problemas = lido.error.issues.map((i) => `  - ${i.path.join(".") || "(raiz)"}: ${i.message}`);
	sair(`O pedido tem ${problemas.length} problema(s):\n${problemas.join("\n")}`);
}
const pedido = lido.data;
const config = nfseAmbiente(AMBIENTE);

// ---------- 3. DPS e assinatura ----------

const dps = montarDps(pedido, {
	ambiente: AMBIENTE,
	leiaute: config.leiaute,
	emitente: { tipo: cert.holder.kind, numero: cert.holder.id },
	numero: pedido.numero ?? 1,
	versaoAplicativo: "NFapi-teste",
});

let assinada: string;
try {
	assinada = signXml({
		xml: dps.xml,
		tag: "infDPS",
		profile: perfil,
		privateKeyPem: cert.privateKeyPem,
		certificatePem: cert.certificatePem,
		holder: cert.holder,
		allowProduction: false,
	}).xml;
} catch (err) {
	sair(`Falha ao assinar: ${err instanceof SignError ? `${err.code} — ${err.message}` : err}`);
}

fs.mkdirSync(SAIDA, { recursive: true });
const arquivoDps = path.join(SAIDA, `${dps.id}-dps.xml`);
fs.writeFileSync(arquivoDps, assinada);

console.log(`
Emitente   : ${cert.commonName}
Ambiente   : produção restrita (testes, sem valor fiscal)
Leiaute    : ${config.leiaute}    Assinatura: ${perfil}
DPS        : série ${pedido.serie}, número ${pedido.numero ?? 1}
Id         : ${dps.id}
Município  : ${pedido.prestador.codigoMunicipio}    Serviço: ${pedido.servico.codigoTributacaoNacional}
Tomador    : ${pedido.tomador ? `${pedido.tomador.nome} (${pedido.tomador.cnpj ?? pedido.tomador.cpf})` : "não informado"}
Valor      : R$ ${pedido.valores.servico.toFixed(2)}
DPS gravada: ${arquivoDps}
`);

if (args.includes("--nao-enviar")) {
	console.log("--nao-enviar: nada foi transmitido.");
	process.exit(0);
}
if (!args.includes("--sim")) {
	const resposta = await perguntar("Enviar esta DPS à SEFIN Nacional (produção restrita)? [s/N] ");
	if (resposta.trim().toLowerCase() !== "s") sair("Cancelado: nada foi transmitido.", 0);
}

// ---------- 4. Transmissão pelo proxy mTLS (o mesmo código do Container) ----------

const { server } = (await import("../vault/container/server.mjs")) as {
	server: import("node:http").Server;
};
const porta = await new Promise<number>((resolve) =>
	server.listen(0, "127.0.0.1", () => resolve((server.address() as import("node:net").AddressInfo).port)),
);

const url = `${config.sefin}/nfse`;
const res = await fetch(`http://127.0.0.1:${porta}/transmit`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		url,
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		bodyB64: Buffer.from(await corpoEmissao(assinada)).toString("base64"),
		certPem: cert.certificatePem,
		chainPem: cert.chainPem,
		keyPem: cert.privateKeyPem,
		timeoutMs: 60_000,
	}),
});
const proxy = (await res.json()) as {
	error?: { code: string; message: string };
	status: number;
	bodyB64: string;
	ms: number;
	tls: { protocol: string };
};
server.close();

if (proxy.error) sair(`A conexão com a SEFIN falhou: ${proxy.error.code} — ${proxy.error.message}`);

const corpo = Buffer.from(proxy.bodyB64, "base64").toString("utf8");
fs.writeFileSync(path.join(SAIDA, `${dps.id}-resposta.json`), corpo);
console.log(`\nPOST ${url}\nHTTP ${proxy.status} em ${proxy.ms} ms (${proxy.tls.protocol})\n`);

const resposta = await lerRespostaEmissao(proxy.status, corpo);
if (resposta.tipo === "autorizada") {
	const arquivoNfse = path.join(SAIDA, `${resposta.chaveAcesso}-nfse.xml`);
	fs.writeFileSync(arquivoNfse, resposta.xml);
	console.log(`NFS-e AUTORIZADA
  Chave de acesso: ${resposta.chaveAcesso}
  Número         : ${resposta.numeroNfse ?? "(não encontrado no XML)"}
  XML gravado em : ${arquivoNfse}`);
	for (const a of resposta.alertas) console.log(`  Alerta ${a.codigo}: ${a.descricao}`);
	process.exit(0);
}

if (resposta.tipo === "rejeitada") {
	console.log("NFS-e REJEITADA pela SEFIN:");
	for (const r of resposta.rejeicoes) {
		console.log(`  ${r.codigo}: ${r.descricao}${r.complemento ? ` (${r.complemento})` : ""}`);
	}
	const assinatura = resposta.rejeicoes.some((r) => /assinatura/i.test(r.descricao));
	if (assinatura && perfil === "rsa-sha256") {
		console.log("\nA rejeição cita a assinatura. Tente de novo com:  --assinatura rsa-sha1");
	}
	process.exit(1);
}

// Resposta fora do esperado: mostra o que veio, para análise.
let extra = "";
try {
	const mensagens = lerMensagens(Object.values(JSON.parse(corpo) as Record<string, unknown>).find(Array.isArray));
	extra = mensagens.map((m) => `  ${m.codigo}: ${m.descricao}`).join("\n");
} catch {
	// corpo não é JSON
}
console.log(`Resposta INDEFINIDA: ${resposta.detalhe}\n${extra}\nCorpo recebido (início):\n${corpo.slice(0, 600)}`);
process.exit(1);
