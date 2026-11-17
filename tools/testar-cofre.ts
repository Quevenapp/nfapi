// Teste de ponta a ponta de um cofre PUBLICADO, pela API que os sistemas
// clientes usam, sempre em HOMOLOGAÇÃO:
//
//   estado do cofre -> séries -> status da SEFAZ -> NF-e (emite, repete a
//   referência, corrige, baixa o XML, cancela) -> NFC-e (emite, cancela)
//
// Exige uma chave de API criada no painel do cofre com o escopo "Somente
// homologação": com ela o cofre recusa qualquer pedido de produção. A chave é
// pedida no terminal (ou lida da variável NFAPI_CHAVE) e não é gravada.
//
// Uso:
//   pnpm testar-cofre <https://endereco-do-cofre> <pedido-nfe.json> [<pedido-nfce.json>] [--sim]
//
// Antes, no painel do cofre: cadastre uma série de homologação para cada
// documento e crie a chave de teste.

import fs from "node:fs";
import readline from "node:readline";

type Json = Record<string, any>;

function sair(mensagem: string, codigo = 1): never {
	console.error(`\n${mensagem}`);
	process.exit(codigo);
}

const args = process.argv.slice(2);
/** --contingencia: testa só a fila de contingência da NFC-e; o pedido informado é o de NFC-e. */
const soContingencia = args.includes("--contingencia");
const posicionais = args.filter((a) => !a.startsWith("--"));
const endereco = posicionais[0];
const arquivoNfe = soContingencia ? undefined : posicionais[1];
const arquivoNfce = soContingencia ? posicionais[1] : posicionais[2];
if (!endereco || (!soContingencia && (!arquivoNfe || !fs.existsSync(arquivoNfe))) || (soContingencia && !arquivoNfce) || (arquivoNfce && !fs.existsSync(arquivoNfce))) {
	sair(
		"Uso: pnpm testar-cofre <https://endereco-do-cofre> <pedido-nfe.json> [<pedido-nfce.json>] [--sim]\n" +
			"     pnpm testar-cofre <https://endereco-do-cofre> <pedido-nfce.json> --contingencia [--sim]",
		2,
	);
}
let base: URL;
try {
	base = new URL(endereco);
} catch {
	sair("O endereço do cofre não é uma URL válida.", 2);
}
// http só é aceito para um cofre de desenvolvimento nesta máquina.
if (base.protocol !== "https:" && base.hostname !== "localhost") sair("O endereço do cofre precisa começar com https://", 2);

function perguntar(pergunta: string, oculto = false): Promise<string> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		let mudo = false;
		// biome-ignore lint/suspicious/noExplicitAny: API interna do readline para não ecoar a chave
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

const chave = (process.env.NFAPI_CHAVE ?? (await perguntar("Chave de API do cofre (escopo somente homologação): ", true))).trim();
if (!/^nfapi_[A-Za-z0-9_-]{40,60}$/.test(chave)) sair("Isso não parece uma chave de API do cofre (nfapi_...).");

async function api(method: string, caminho: string, corpo?: unknown) {
	const inicio = Date.now();
	const res = await fetch(new URL(caminho, base), {
		method,
		headers: { authorization: `Bearer ${chave}`, ...(corpo === undefined ? {} : { "content-type": "application/json" }) },
		body: corpo === undefined ? undefined : JSON.stringify(corpo),
	});
	const texto = await res.text();
	let json: Json | null = null;
	try {
		json = JSON.parse(texto) as Json;
	} catch {
		// resposta que não é JSON (o XML, por exemplo)
	}
	return { status: res.status, json, texto, ms: Date.now() - inicio };
}

const passos: [string, boolean, string][] = [];
function registrar(nome: string, ok: boolean, detalhe: string) {
	passos.push([nome, ok, detalhe]);
	console.log(`  ${ok ? "OK    " : "FALHOU"}  ${nome}: ${detalhe}`);
	return ok;
}
const motivo = (r: { status: number; json: Json | null; texto: string }) => {
	const e = r.json?.erro;
	const mensagens = (r.json?.mensagens ?? r.json?.nfe?.mensagens ?? r.json?.nfce?.mensagens ?? []) as { codigo: string; descricao: string }[];
	const sefaz = mensagens.map((m) => `[${m.codigo}] ${m.descricao}`).join(" ");
	return `HTTP ${r.status} ${e ? `${e.codigo}: ${e.mensagem}` : r.texto.slice(0, 200)}${sefaz ? ` | ${sefaz}` : ""}`;
};
const lerPedido = (arquivo: string) => {
	const { _instrucoes, ambiente, referencia, ...pedido } = JSON.parse(fs.readFileSync(arquivo, "utf8").replace(/^﻿/, "")) as Json;
	return pedido;
};

// ---------- Estado do cofre ----------

console.log(`\nCofre: ${base.origin}\n`);
const cofre = await api("GET", "/v1/cofre");
if (cofre.status !== 200 || !cofre.json) sair(`Não foi possível ler o estado do cofre: ${motivo(cofre)}`);
const estado = cofre.json;
if (estado.chave?.escopo !== "homologacao") {
	sair('Esta chave não é de teste. Crie no painel do cofre uma chave com o escopo "Somente homologação" e use-a aqui.');
}
registrar("Estado do cofre", estado.certificado !== null, `versão ${estado.versao}${estado.atualizacao?.pendente ? ` (há a ${estado.atualizacao.versaoPublicada})` : ""}; certificado ${estado.certificado ? `válido por ${estado.certificado.diasRestantes} dias` : "AUSENTE"}`);

const series = ((await api("GET", "/v1/series")).json?.series ?? []) as Json[];
const serieDe = (modelo: string) => series.filter((s) => s.modelo === modelo && s.ambiente === "homologacao");
for (const modelo of soContingencia ? ["nfce"] : arquivoNfce ? ["nfe", "nfce"] : ["nfe"]) {
	const lista = serieDe(modelo);
	registrar(`Série de ${modelo} em homologação`, lista.length > 0, lista.length ? lista.map((s) => `série ${s.serie}, próxima nota ${s.proximoNumero}`).join("; ") : "nenhuma cadastrada no painel do cofre");
}

const pedidoNfe = arquivoNfe ? lerPedido(arquivoNfe) : null;
const uf = (pedidoNfe ?? lerPedido(arquivoNfce as string)).emitente?.endereco?.uf ?? "SP";
const status = await api("GET", `/v1/sefaz/status?uf=${uf}&modelo=${soContingencia ? "nfce" : "nfe"}`);
registrar("Conexão do cofre com a SEFAZ", status.json?.emOperacao === true, status.json?.mensagem ? `[${status.json.mensagem.codigo}] ${status.json.mensagem.descricao} (${status.ms} ms)` : motivo(status));

if (passos.some(([, ok]) => !ok)) sair("\nCorrija os itens acima antes de emitir.");
if (!args.includes("--sim")) {
	const oQue = soContingencia
		? "uma NFC-e em CONTINGÊNCIA (o teste espera até 8 minutos o cofre transmiti-la sozinho)"
		: arquivoNfce ? "uma NF-e e uma NFC-e" : "uma NF-e";
	const resposta = await perguntar(`\nEmitir e cancelar ${oQue} de teste em HOMOLOGAÇÃO por este cofre? [s/N] `);
	if (resposta.trim().toLowerCase() !== "s") sair("Cancelado: nada foi emitido.", 0);
}

// ---------- Emissão pela API ----------

const corrida = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const justificativa = "Nota de teste emitida em homologacao pelo NFapi";

async function exercitar(doc: "nfe" | "nfce", pedido: Json) {
	const nome = doc === "nfe" ? "NF-e" : "NFC-e";
	const corpo = { ...pedido, ambiente: "homologacao", referencia: `teste-${doc}-${corrida}` };
	console.log(`\n${nome}`);

	const emitida = await api("POST", `/v1/${doc}`, corpo);
	const nota = emitida.json ?? {};
	if (!registrar(`${nome}: emissão`, emitida.status === 201 && nota.situacao === "autorizada", emitida.status === 201 ? `nº ${nota.numero}, série ${nota.serie}, protocolo ${nota.protocolo}, R$ ${Number(nota.valor).toFixed(2)} (${emitida.ms} ms)` : motivo(emitida))) return;
	console.log(`          chave ${nota.chaveAcesso}`);

	const repetida = await api("POST", `/v1/${doc}`, corpo);
	registrar(`${nome}: mesma referência não emite de novo`, repetida.status === 200 && repetida.json?.id === nota.id, repetida.status === 200 ? "devolveu a mesma emissão" : motivo(repetida));

	const alterada = await api("POST", `/v1/${doc}`, { ...corpo, naturezaOperacao: "Conteudo alterado de proposito" });
	registrar(`${nome}: referência com outro conteúdo é recusada`, alterada.status === 409 && alterada.json?.erro?.codigo === "referencia_com_conteudo_diferente", alterada.status === 409 ? "409, como esperado" : motivo(alterada));

	const xml = await api("GET", `/v1/${doc}/${nota.id}/xml`);
	registrar(`${nome}: XML arquivado`, xml.status === 200 && xml.texto.startsWith("<nfeProc") && xml.texto.includes(`<nProt>${nota.protocolo}</nProt>`), xml.status === 200 ? `${xml.texto.length} caracteres, com o protocolo` : motivo(xml));

	if (doc === "nfe") {
		const carta = await api("POST", `/v1/nfe/${nota.id}/carta-correcao`, { correcao: "Correcao de teste: informacoes complementares da nota" });
		registrar("NF-e: carta de correção", carta.status === 200 && carta.json?.cartasCorrecao === 1, carta.status === 200 ? "registrada" : motivo(carta));
	} else {
		registrar("NFC-e: QR Code", typeof nota.qrCode === "string" && nota.qrCode.includes(nota.chaveAcesso), String(nota.qrCode));
	}

	const cancelada = await api("POST", `/v1/${doc}/${nota.id}/cancelar`, { justificativa });
	registrar(`${nome}: cancelamento`, cancelada.status === 200 && cancelada.json?.situacao === "cancelada" && cancelada.json?.repetido === false, cancelada.status === 200 ? `cancelada (${cancelada.ms} ms)` : motivo(cancelada));
}

/**
 * Fila de contingência: emite uma NFC-e em contingência (forçada) e espera o
 * agendador do cofre, que roda a cada 5 minutos, transmiti-la sem ajuda.
 */
async function exercitarContingencia(pedido: Json) {
	console.log("\nNFC-e em contingência");
	const emitida = await api("POST", "/v1/nfce", { ...pedido, ambiente: "homologacao", referencia: `teste-contingencia-${corrida}`, contingencia: "forcada" });
	const nota = emitida.json ?? {};
	const offline = typeof nota.qrCode === "string" && nota.qrCode.split("|").length === 8;
	if (!registrar("Emissão em contingência", emitida.status === 201 && nota.situacao === "contingencia" && nota.chaveAcesso?.[34] === "9" && offline && nota.protocolo === null,
		emitida.status === 201 ? `nº ${nota.numero}, série ${nota.serie}, situação ${nota.situacao}, sem protocolo (${emitida.ms} ms)` : motivo(emitida))) return;
	console.log(`          chave ${nota.chaveAcesso}`);

	const pendentes = (await api("GET", "/v1/cofre")).json?.contingencia?.notasPendentes;
	registrar("Nota na fila do cofre", pendentes >= 1, `${pendentes} nota(s) pendente(s)`);
	const xmlAntes = await api("GET", `/v1/nfce/${nota.id}/xml`);
	registrar("XML assinado disponível antes da autorização", xmlAntes.status === 200 && xmlAntes.texto.startsWith("<NFe") && xmlAntes.texto.includes("<tpEmis>9</tpEmis>"), xmlAntes.status === 200 ? `${xmlAntes.texto.length} caracteres` : motivo(xmlAntes));

	console.log("  Aguardando o agendador do cofre transmitir a nota (até 8 minutos)...");
	const inicio = Date.now();
	let atual = nota;
	while (atual.situacao === "contingencia" && Date.now() - inicio < 8 * 60_000) {
		await new Promise((resolve) => setTimeout(resolve, 30_000));
		atual = (await api("GET", `/v1/nfce/${nota.id}`)).json ?? atual;
		process.stdout.write(`    ${Math.round((Date.now() - inicio) / 1000)} s: ${atual.situacao}\n`);
	}
	const sozinho = registrar("Transmissão automática pelo agendador", atual.situacao === "autorizada" && atual.chaveAcesso === nota.chaveAcesso,
		atual.situacao === "autorizada" ? `autorizada em ${Math.round((Date.now() - inicio) / 1000)} s, protocolo ${atual.protocolo}` : `continua ${atual.situacao}: ${JSON.stringify(atual.mensagens)}`);
	if (!sozinho && atual.situacao === "contingencia") {
		// O agendador não agiu: tenta transmitir pela API, para o teste não deixar nota pendente.
		atual = (await api("POST", `/v1/nfce/${nota.id}/consultar`)).json ?? atual;
		registrar("Transmissão pedida pela API (/consultar)", atual.situacao === "autorizada", `situação ${atual.situacao}`);
	}
	if (atual.situacao !== "autorizada") return;

	const xml = await api("GET", `/v1/nfce/${nota.id}/xml`);
	registrar("XML com o protocolo depois da autorização", xml.status === 200 && xml.texto.startsWith("<nfeProc") && xml.texto.includes(`<nProt>${atual.protocolo}</nProt>`), xml.status === 200 ? `${xml.texto.length} caracteres` : motivo(xml));
	const cancelada = await api("POST", `/v1/nfce/${nota.id}/cancelar`, { justificativa });
	registrar("Cancelamento", cancelada.status === 200 && cancelada.json?.situacao === "cancelada", cancelada.status === 200 ? "cancelada" : motivo(cancelada));
	const evento = await api("GET", `/v1/nfce/${nota.id}/cancelamento/xml`);
	registrar("XML do evento de cancelamento", evento.status === 200 && evento.texto.startsWith("<procEventoNFe"), evento.status === 200 ? `${evento.texto.length} caracteres` : motivo(evento));
}

if (soContingencia) await exercitarContingencia(lerPedido(arquivoNfce as string));
else {
	await exercitar("nfe", pedidoNfe as Json);
	if (arquivoNfce) await exercitar("nfce", lerPedido(arquivoNfce));
}

const falhas = passos.filter(([, ok]) => !ok);
console.log(`\nResultado: ${passos.length - falhas.length} de ${passos.length} passos certos.${falhas.length ? ` Falharam: ${falhas.map(([nome]) => nome).join("; ")}.` : ""}`);
process.exit(falhas.length ? 1 : 0);
