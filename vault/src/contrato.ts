// Contrato da API do cofre (OpenAPI 3.1), servido em GET /v1/openapi.json e
// copiado em docs/openapi.json a cada versão.
//
// Os formatos de pedido saem dos mesmos schemas que validam as requisições,
// então o contrato não tem como divergir do que o cofre aceita.

import { z } from "zod";
import { EXEMPLO_NFCE, EXEMPLO_NFE, EXEMPLO_NFSE } from "./contrato-exemplos";
import { CancelamentoNfe, CartaCorrecao, InutilizacaoInput, NfceInput, NfeInput } from "./nfe/schema";
import { CancelamentoInput, NfseInput } from "./nfse";
import { VAULT_VERSION } from "./protocol";

type Json = Record<string, unknown>;

function esquema(schema: z.ZodType): Json {
	const { $schema: _descartado, ...resto } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Json;
	return resto;
}

const ref = (nome: string) => ({ $ref: `#/components/schemas/${nome}` });
const corpo = (schema: Json, exemplo?: unknown) => ({
	required: true,
	content: { "application/json": { schema, ...(exemplo ? { example: exemplo } : {}) } },
});
const resposta = (descricao: string, schema?: Json) => ({
	description: descricao,
	...(schema ? { content: { "application/json": { schema } } } : {}),
});

const ERROS: Record<number, string> = {
	400: "Pedido inválido. `erro.mensagem` aponta o campo.",
	401: "Chave de API ausente, inválida ou revogada.",
	403: "A chave só opera em homologação.",
	404: "Emissão inexistente.",
	409: "Conflito: referência em andamento, referência reenviada com outro conteúdo, certificado ausente ou nota em situação que não permite a operação.",
	422: "Recusado pelo governo ou barrado pelo cofre antes de transmitir. Com rejeição, o corpo traz a emissão e as mensagens (cStat e xMotivo).",
	502: "Sem resposta conclusiva do governo. Repita o pedido com a mesma referência: o cofre consulta antes de reenviar.",
	500: "Falha inesperada do cofre (erro_interno). Pode ser repetido; com referência, a repetição é segura.",
	503: "O cofre não está pronto para atender (cofre_nao_configurado): a instalação não foi concluída.",
};
/** Toda operação pode devolver 500 e 503, além dos erros próprios dela. */
const erros = (...codigos: number[]) => Object.fromEntries([...codigos, 500, 503].map((c) => [String(c), resposta(ERROS[c] as string, ref("Erro"))]));

const texto = { type: "string" };
const textoOuNulo = { type: ["string", "null"] };
const dataHora = { type: "string", format: "date-time" };
const mensagens = {
	type: "array",
	description: "Código e descrição devolvidos pelo governo (na NF-e e NFC-e, cStat e xMotivo) ou pelo cofre.",
	items: { type: "object", properties: { codigo: texto, descricao: texto }, required: ["codigo", "descricao"] },
};
const AMBIENTE = { type: "string", enum: ["homologacao", "producao"] };

const Cabecalho = {
	type: "object",
	properties: {
		ambiente: { ...AMBIENTE, default: "homologacao" },
		referencia: {
			type: "string",
			pattern: "^[A-Za-z0-9._:-]{1,80}$",
			description:
				"Identificador do pedido no seu sistema. Repetir a referência com o mesmo conteúdo devolve a mesma emissão; com conteúdo diferente, o cofre recusa (409 referencia_com_conteudo_diferente). Só uma nota rejeitada pode ser reenviada corrigida com a mesma referência.",
		},
	},
};

const EmissaoNfe = {
	type: "object",
	properties: {
		id: texto,
		modelo: { type: "string", enum: ["nfe", "nfce"] },
		ambiente: AMBIENTE,
		referencia: textoOuNulo,
		serie: { type: "integer" },
		numero: { type: "integer" },
		situacao: {
			type: "string",
			enum: ["processando", "autorizada", "contingencia", "rejeitada", "denegada", "erro", "indefinida", "cancelada"],
			description:
				"`indefinida`: a resposta do governo se perdeu; use POST .../consultar ou repita o pedido com a mesma referência. `erro`: barrada pelo cofre antes de transmitir. `contingencia`: NFC-e emitida offline; vale para o consumidor, ainda sem protocolo, e o cofre a transmite quando a SEFAZ voltar.",
		},
		chaveAcesso: textoOuNulo,
		protocolo: textoOuNulo,
		emitidaEm: { ...textoOuNulo, description: "Data e hora de emissão que estão no XML (dhEmi), com o fuso da UF." },
		autorizadaEm: { ...textoOuNulo, description: "Data e hora em que a SEFAZ autorizou (dhRecbto). Com o protocolo, vai impressa no DANFE e no DANFCE." },
		valor: { type: ["number", "null"], description: "Valor total da nota (vNF), somado pelo cofre." },
		qrCode: { ...textoOuNulo, description: "Só na NFC-e: conteúdo do QR Code." },
		urlConsulta: { ...textoOuNulo, description: "Só na NFC-e: endereço de consulta pela chave." },
		cartasCorrecao: { type: "integer" },
		contingencia: {
			type: ["object", "null"],
			description: "Só na NFC-e emitida em contingência offline; null nas demais.",
			properties: {
				pendente: { type: "boolean", description: "A nota ainda aguarda a transmissão à SEFAZ." },
				desde: { ...textoOuNulo, description: "Quando o emitente entrou em contingência (dhCont)." },
				motivo: textoOuNulo,
				tentativasDeTransmissao: { type: "integer" },
				ultimaTentativa: textoOuNulo,
				notaNormalEmConferencia: { ...textoOuNulo, description: "Chave da NFC-e normal da mesma venda que ficou sem resposta: o cofre ainda vai conferi-la na SEFAZ." },
				falhaNaConferencia: { ...textoOuNulo, description: "A SEFAZ rejeitou o cancelamento da nota normal: precisa de ação do emitente." },
				notaNormalCancelada: { ...textoOuNulo, description: "Chave da NFC-e normal que acabou autorizada e foi cancelada por substituição (evento 110112)." },
			},
		},
		mensagens,
		xmlDisponivel: { type: "boolean", description: "Na contingência pendente, o XML é a nota assinada sem protocolo; depois de autorizada, o nfeProc." },
		criadaEm: dataHora,
		atualizadaEm: dataHora,
	},
	required: ["id", "modelo", "ambiente", "serie", "numero", "situacao", "mensagens", "xmlDisponivel"],
};

const negrito = { type: "boolean" };
const LinhaDoCupom = {
	description: "Uma linha do cupom. O campo `tipo` diz o formato.",
	oneOf: [
		{
			type: "object",
			description: "Texto livre: razão social, dizeres obrigatórios, informações adicionais.",
			properties: {
				tipo: { const: "texto" },
				texto,
				alinhamento: { type: "string", enum: ["esquerda", "centro", "direita"] },
				negrito,
				tamanho: { type: "string", enum: ["normal", "dobrado"], description: "`dobrado`: altura e largura dobradas, quando a impressora tiver." },
			},
			required: ["tipo", "texto", "alinhamento", "negrito", "tamanho"],
		},
		{ type: "object", description: "Linha separadora, do jeito que o caixa costuma imprimir.", properties: { tipo: { const: "separador" } }, required: ["tipo"] },
		{
			type: "object",
			description: "Item da venda, em campos: o caixa monta as colunas conforme a largura da bobina.",
			properties: {
				tipo: { const: "item" },
				numero: { type: "integer" },
				codigo: texto,
				descricao: texto,
				quantidade: { type: "number" },
				unidade: texto,
				valorUnitario: { type: "number" },
				valorTotal: { type: "number" },
				quantidadeTexto: { ...texto, description: "A quantidade já no formato de impressão (vírgula decimal)." },
				valorUnitarioTexto: texto,
				valorTotalTexto: texto,
			},
			required: ["tipo", "numero", "codigo", "descricao", "quantidade", "unidade", "valorUnitario", "valorTotal", "quantidadeTexto", "valorUnitarioTexto", "valorTotalTexto"],
		},
		{
			type: "object",
			description: "Rótulo à esquerda e valor à direita: totais, formas de pagamento, troco, tributos.",
			properties: { tipo: { const: "par" }, rotulo: texto, valor: texto, negrito },
			required: ["tipo", "rotulo", "valor", "negrito"],
		},
		{
			type: "object",
			description: "Chave de acesso: só os 44 caracteres. Imprima em 11 blocos de 4, separados por espaço.",
			properties: { tipo: { const: "chave" }, chave: texto },
			required: ["tipo", "chave"],
		},
		{
			type: "object",
			description: "QR Code: gere a imagem a partir do texto, sem alterar nem truncar, em preto e branco puro.",
			properties: { tipo: { const: "qrcode" }, texto, tamanhoMinimoMm: { type: "number", description: "Lado mínimo da imagem impressa, em milímetros." } },
			required: ["tipo", "texto", "tamanhoMinimoMm"],
		},
	],
};

const Cupom = {
	type: "object",
	description:
		"Conteúdo do DANFE NFC-e, na ordem e com os dizeres do manual oficial (versão 6.0), para o caixa imprimir na bobina. " +
		"Imprima as seções na ordem em que vêm e as linhas na ordem em que vêm. Não há largura, corte nem avanço de papel: isso é do caixa. " +
		"Os textos fixos usam só caracteres das páginas de código comuns de impressora; os que vêm da nota (nomes, descrições, informações adicionais) saem como estão no XML.",
	properties: {
		id: texto,
		situacao: { type: "string", description: "Situação da emissão no cofre. Uma nota `cancelada` ainda devolve o cupom: não o entregue ao consumidor." },
		modelo: { const: "nfce" },
		chaveAcesso: texto,
		ambiente: AMBIENTE,
		contingencia: { type: "boolean", description: "Nota emitida em contingência offline. Imprima também a via do estabelecimento (`?via=estabelecimento`)." },
		pendenteDeAutorizacao: { type: "boolean", description: "A nota em contingência ainda não foi autorizada: o cupom sai com os dizeres de contingência e sem protocolo." },
		via: { type: "string", enum: ["consumidor", "estabelecimento"] },
		numero: { type: "integer" },
		serie: { type: "integer" },
		emitidaEm: texto,
		protocolo: textoOuNulo,
		autorizadaEm: textoOuNulo,
		valorAPagar: { type: "number" },
		qrCode: { ...texto, description: "O mesmo texto da linha `qrcode`, para quem monta o cupom por conta própria." },
		urlConsulta: { ...texto, description: "Endereço de consulta pela chave de acesso." },
		secoes: {
			type: "array",
			description: "Divisões do DANFE NFC-e que têm conteúdo, na ordem de impressão.",
			items: {
				type: "object",
				properties: {
					divisao: { type: "string", enum: ["cabecalho", "itens", "totais", "consulta", "consumidor", "identificacao", "qrcode", "mensagem_fiscal", "mensagem_contribuinte"] },
					linhas: { type: "array", items: ref("LinhaDoCupom") },
				},
				required: ["divisao", "linhas"],
			},
		},
	},
	required: ["id", "situacao", "modelo", "chaveAcesso", "ambiente", "contingencia", "pendenteDeAutorizacao", "via", "numero", "serie", "emitidaEm", "valorAPagar", "qrCode", "urlConsulta", "secoes"],
};

const OpcoesNfce = {
	type: "object",
	properties: {
		contingencia: {
			type: "string",
			enum: ["nunca", "automatica", "forcada"],
			default: "nunca",
			description:
				"O que fazer quando a SEFAZ não responde. `automatica`: o cofre espera até 20 segundos e, sem resposta conclusiva, emite a nota em contingência offline (tipo de emissão 9), com número novo, e a devolve com `situacao: \"contingencia\"` para o caixa imprimir; enquanto a SEFAZ segue fora, as vendas seguintes saem direto em contingência. `forcada`: emite direto em contingência. `nunca`: devolve 502. O cofre transmite as notas pendentes sozinho quando a SEFAZ volta. Não entra na comparação de conteúdo da referência. O DANFCE da nota em contingência tem textos e vias próprios, e o prazo legal de transmissão é o fim do primeiro dia útil seguinte.",
		},
	},
};

const EmissaoNfse = {
	type: "object",
	properties: {
		id: texto,
		ambiente: AMBIENTE,
		referencia: textoOuNulo,
		serie: texto,
		numero: { type: "integer", description: "Número da DPS." },
		idDps: texto,
		situacao: { type: "string", enum: ["processando", "autorizada", "rejeitada", "erro", "indefinida", "cancelada"] },
		chaveAcesso: textoOuNulo,
		numeroNfse: textoOuNulo,
		mensagens,
		xmlDisponivel: { type: "boolean" },
		criadaEm: dataHora,
		atualizadaEm: dataHora,
	},
	required: ["id", "ambiente", "serie", "numero", "situacao", "mensagens", "xmlDisponivel"],
};

const id = { name: "id", in: "path", required: true, schema: texto, description: "Id da emissão no cofre." };
const filtros = [
	{ name: "referencia", in: "query", schema: texto, description: "Pesquisa pela referência do seu sistema. A referência é única por ambiente: combine com `ambiente`." },
	{ name: "ambiente", in: "query", schema: AMBIENTE, description: "Só as emissões deste ambiente. Sem o filtro, vêm as dos dois." },
	{ name: "limite", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
];
const xml = { description: "XML autorizado.", content: { "application/xml": { schema: texto } } };
const xmlDoEvento = { description: "XML do evento com o retorno do governo, como deve ser guardado e entregue.", content: { "application/xml": { schema: texto } } };

/** Resposta de cancelamento e de carta de correção: a emissão e se o pedido era repetido. */
const comRepetido = (emissao: Json) => ({
	allOf: [
		emissao,
		{
			type: "object",
			properties: {
				repetido: {
					type: "boolean",
					description: "true quando o evento já estava registrado e nada novo foi enviado ao governo. Use para não lançar o efeito duas vezes.",
				},
			},
			required: ["repetido"],
		},
	],
});

/**
 * Códigos de `erro.codigo` da API. A lista cresce com as versões: trate um
 * código desconhecido pelo status HTTP. Um teste confere que todo código
 * usado no cofre está aqui.
 */
export const CODIGOS_DE_ERRO: Record<string, { status: number; quando: string }> = {
	requisicao_invalida: { status: 400, quando: "O corpo ou um parâmetro não passou na validação; `mensagem` (e `campo`, na NF-e e NFC-e) aponta onde." },
	nao_autenticado: { status: 401, quando: "Chave de API ausente, inválida ou revogada." },
	chave_somente_homologacao: { status: 403, quando: "A chave é de teste e o pedido é de produção." },
	nao_encontrado: { status: 404, quando: "Emissão, XML ou rota inexistente." },
	certificado_ausente: { status: 409, quando: "Não há certificado instalado no cofre." },
	certificado_vencido: { status: 409, quando: "O certificado instalado venceu." },
	emissao_em_andamento: { status: 409, quando: "Já há um pedido com a mesma referência em andamento. Aguarde e consulte." },
	referencia_com_conteudo_diferente: { status: 409, quando: "A referência já foi usada com outro conteúdo. Não repita: é um documento novo ou um erro do chamador." },
	numero_ja_utilizado: { status: 409, quando: "NFS-e: o número informado no pedido já foi usado na série." },
	nfe_nao_autorizada: { status: 409, quando: "Cancelamento ou carta de correção de NF-e/NFC-e que não está autorizada, ou cupom de NFC-e sem XML arquivado." },
	nfse_nao_autorizada: { status: 409, quando: "Cancelamento de NFS-e que não está autorizada." },
	faixa_em_uso: { status: 409, quando: "Inutilização de faixa que contém nota autorizada ou em andamento." },
	serie_nao_cadastrada: { status: 422, quando: "A série do pedido não está cadastrada no cofre para o modelo e o ambiente." },
	serie_obrigatoria: { status: 422, quando: "Há mais de uma série cadastrada e o pedido não disse qual." },
	uf_nao_suportada: { status: 422, quando: "O cofre ainda não tem autorizador para a UF do emitente." },
	emitente_divergente: { status: 422, quando: "O emitente não é o titular do certificado nem uma filial de mesma raiz de CNPJ." },
	producao_bloqueada: { status: 422, quando: "O pedido é de produção e o emitente não liberou a produção no cofre." },
	nfe_rejeitada: { status: 422, quando: "A SEFAZ rejeitou a nota; `mensagens` traz cStat e xMotivo. Corrija e reenvie, com a mesma referência se quiser." },
	nfe_denegada: { status: 422, quando: "A SEFAZ denegou o uso da nota. O número fica consumido." },
	nfse_rejeitada: { status: 422, quando: "A SEFIN rejeitou a NFS-e; `mensagens` traz os códigos." },
	cancelamento_rejeitado: { status: 422, quando: "O governo rejeitou o cancelamento (por exemplo, fora do prazo)." },
	carta_rejeitada: { status: 422, quando: "A SEFAZ rejeitou a carta de correção." },
	carta_nao_se_aplica: { status: 422, quando: "Carta de correção pedida para documento que não é NF-e." },
	limite_de_cartas: { status: 422, quando: "A nota já tem 20 cartas de correção." },
	inutilizacao_rejeitada: { status: 422, quando: "A SEFAZ rejeitou a inutilização." },
	inutilizacao_extinta: { status: 422, quando: "A UF não tem mais inutilização de numeração (SP, AC e BA)." },
	host_nao_permitido: { status: 422, quando: "Falha interna: o cofre recusou transmitir para um endereço que não é do governo." },
	certificado_do_cliente_invalido: { status: 422, quando: "O governo recusou o certificado na conexão." },
	sem_resposta_conclusiva: { status: 502, quando: "A resposta do governo se perdeu ou não foi conclusiva. Na NF-e e NFC-e, chame /consultar; em qualquer documento, repetir com a mesma referência consulta antes de reenviar. Na NFC-e, `contingencia: \"automatica\"` troca este erro por uma nota em contingência." },
	sem_conexao: { status: 200, quando: "Só em GET /v1/sefaz/status, dentro de `mensagem.codigo`: não foi possível falar com a SEFAZ." },
	erro_interno: { status: 500, quando: "Falha inesperada do cofre." },
	cofre_nao_configurado: { status: 503, quando: "O segredo do cofre está ausente ou é fraco demais: a instalação não foi concluída." },
};

/** Rotas de NF-e ou de NFC-e: os dois modelos têm o mesmo desenho. */
function rotasNfe(doc: "nfe" | "nfce", nome: string, pedido: string, exemplo: unknown): Json {
	const tags = [nome];
	const base = `/v1/${doc}`;
	const emissao = ref("EmissaoNfe");
	const rotas: Json = {
		[base]: {
			post: {
				tags,
				summary: `Emite uma ${nome}`,
				description: "O cofre reserva o número na série, monta e assina o XML, transmite e arquiva a nota autorizada. A série precisa estar cadastrada no cofre.",
				requestBody: corpo(ref(pedido), exemplo),
				responses: {
					"201": resposta(doc === "nfce" ? "Autorizada, ou emitida em contingência (`situacao`)." : "Autorizada.", emissao),
					"200": resposta("A referência já tinha uma nota: nada foi reenviado.", emissao),
					...erros(400, 401, 403, 409, 422, 502),
				},
			},
			get: {
				tags,
				summary: `Lista as emissões de ${nome}`,
				parameters: filtros,
				responses: { "200": resposta("Emissões, da mais nova para a mais antiga.", { type: "object", properties: { [doc]: { type: "array", items: emissao } } }), ...erros(401) },
			},
		},
		[`${base}/{id}`]: { get: { tags, summary: "Consulta o registro da emissão no cofre", parameters: [id], responses: { "200": resposta("A emissão.", emissao), ...erros(401, 404) } } },
		[`${base}/{id}/consultar`]: {
			post: {
				tags,
				summary: "Consulta a SEFAZ e fecha uma emissão sem resposta conclusiva",
				description: "Para emissões em situação `indefinida`. Numa NFC-e em `contingencia`, tenta transmiti-la agora, sem esperar o agendador do cofre. Nas demais situações devolve o registro como está.",
				parameters: [id],
				responses: { "200": resposta("A emissão, atualizada quando a SEFAZ respondeu.", emissao), ...erros(401, 404, 409) },
			},
		},
		[`${base}/{id}/xml`]: { get: { tags, summary: "Baixa o XML autorizado (nfeProc)", parameters: [id], responses: { "200": xml, ...erros(401, 404) } } },
		[`${base}/{id}/cancelar`]: {
			post: {
				tags,
				summary: `Cancela a ${nome}`,
				description: "Repetir o pedido de uma nota já cancelada devolve 200.",
				parameters: [id],
				requestBody: corpo(ref("CancelamentoNfe"), { justificativa: "Pedido cancelado pelo cliente antes da entrega" }),
				responses: { "200": resposta("Cancelada, agora ou antes (`repetido`).", comRepetido(emissao)), ...erros(400, 401, 403, 404, 409, 422, 502) },
			},
		},
	};
	rotas[`${base}/{id}/cancelamento/xml`] = {
		get: { tags, summary: "Baixa o XML do evento de cancelamento (procEventoNFe)", parameters: [id], responses: { "200": xmlDoEvento, ...erros(401, 404) } },
	};
	if (doc === "nfce") {
		rotas[`${base}/{id}/cupom`] = {
			get: {
				tags,
				summary: "Conteúdo do DANFE NFC-e (cupom) em JSON, para imprimir na bobina",
				description:
					"Montado a partir do XML arquivado, com as divisões e os dizeres obrigatórios do manual do DANFE NFC-e. " +
					"Serve para a nota autorizada e para a nota em contingência; nas demais situações (rejeitada sem XML, em processamento) responde 409 nfe_nao_autorizada.",
				parameters: [
					id,
					{ name: "via", in: "query", schema: { type: "string", enum: ["consumidor", "estabelecimento"], default: "consumidor" }, description: "A via do estabelecimento só existe na nota em contingência; nas demais o cupom sai sempre como via do consumidor." },
				],
				responses: { "200": resposta("O cupom.", ref("Cupom")), ...erros(400, 401, 404, 409) },
			},
		};
	}
	if (doc === "nfe") {
		rotas[`${base}/{id}/carta-correcao/{sequencia}/xml`] = {
			get: {
				tags,
				summary: "Baixa o XML de uma carta de correção (procEventoNFe)",
				parameters: [id, { name: "sequencia", in: "path", required: true, schema: { type: "integer", minimum: 1, maximum: 20 }, description: "Número da carta, de 1 até `cartasCorrecao`." }],
				responses: { "200": xmlDoEvento, ...erros(401, 404) },
			},
		};
		rotas[`${base}/{id}/carta-correcao`] = {
			post: {
				tags,
				summary: "Registra uma carta de correção",
				description: "Até 20 por nota. A carta mais recente substitui as anteriores, então o texto deve trazer todas as correções.",
				parameters: [id],
				requestBody: corpo(ref("CartaCorrecao"), { correcao: "Endereço de entrega: Rua das Acácias, 45, sala 2" }),
				responses: { "200": resposta("Registrada.", comRepetido(emissao)), ...erros(400, 401, 403, 404, 409, 422, 502) },
			},
		};
	}
	return rotas;
}

export function contratoOpenApi(): Json {
	const nfse = ref("EmissaoNfse");
	return {
		openapi: "3.1.0",
		info: {
			title: "Cofre NFapi",
			version: VAULT_VERSION,
			description:
				"API de emissão de notas fiscais do cofre NFapi, que roda na conta Cloudflare do emitente. " +
				"Todas as chamadas levam uma chave de API criada na tela /setup do cofre. " +
				"O cofre não calcula imposto: o sistema que chama informa bases, alíquotas e valores; o cofre numera, monta o XML, soma os totais, assina, transmite e arquiva. " +
				"Erros vêm sempre como `{ \"erro\": { \"codigo\", \"mensagem\" } }`.",
			license: { name: "MIT" },
		},
		servers: [{ url: "https://{cofre}", variables: { cofre: { default: "nfapi-cofre.sua-conta.workers.dev", description: "Endereço do seu cofre." } } }],
		security: [{ chaveDeApi: [] }],
		tags: [{ name: "NF-e" }, { name: "NFC-e" }, { name: "NFS-e" }, { name: "Numeração" }, { name: "Cofre" }],
		paths: {
			...rotasNfe("nfe", "NF-e", "PedidoNfe", EXEMPLO_NFE),
			...rotasNfe("nfce", "NFC-e", "PedidoNfce", EXEMPLO_NFCE),
			"/v1/nfse": {
				post: {
					tags: ["NFS-e"],
					summary: "Emite uma NFS-e (Sistema Nacional)",
					requestBody: corpo(ref("PedidoNfse"), EXEMPLO_NFSE),
					responses: { "201": resposta("Autorizada.", nfse), "200": resposta("A referência já tinha uma nota.", nfse), ...erros(400, 401, 403, 409, 422, 502) },
				},
				get: { tags: ["NFS-e"], summary: "Lista as emissões de NFS-e", parameters: filtros, responses: { "200": resposta("Emissões.", { type: "object", properties: { nfse: { type: "array", items: nfse } } }), ...erros(401) } },
			},
			"/v1/nfse/{id}": { get: { tags: ["NFS-e"], summary: "Consulta a emissão", parameters: [id], responses: { "200": resposta("A emissão.", nfse), ...erros(401, 404) } } },
			"/v1/nfse/{id}/xml": { get: { tags: ["NFS-e"], summary: "Baixa o XML da NFS-e", parameters: [id], responses: { "200": xml, ...erros(401, 404) } } },
			"/v1/nfse/{id}/cancelamento/xml": {
				get: { tags: ["NFS-e"], summary: "Baixa o XML do evento de cancelamento", parameters: [id], responses: { "200": xmlDoEvento, ...erros(401, 404) } },
			},
			"/v1/nfse/{id}/cancelar": {
				post: {
					tags: ["NFS-e"],
					summary: "Cancela a NFS-e",
					parameters: [id],
					requestBody: corpo(ref("CancelamentoNfse"), { motivo: "erro_emissao", justificativa: "Nota emitida com o valor incorreto" }),
					responses: { "200": resposta("Cancelada, agora ou antes (`repetido`).", comRepetido(nfse)), ...erros(400, 401, 403, 404, 409, 422, 502) },
				},
			},
			"/v1/inutilizacoes": {
				post: {
					tags: ["Numeração"],
					summary: "Inutiliza uma faixa de numeração de NF-e ou NFC-e",
					description: "Para números que não serão usados (lacunas). A faixa não pode conter nota autorizada ou em andamento neste cofre. Em SP, AC e BA a inutilização foi extinta: o cofre responde 422 inutilizacao_extinta.",
					requestBody: corpo(ref("Inutilizacao"), { modelo: "nfe", ambiente: "homologacao", uf: "RJ", serie: 1, numeroInicial: 15, numeroFinal: 15, justificativa: "Número pulado por falha no sistema anterior" }),
					responses: {
						"201": resposta("Homologada pela SEFAZ.", ref("InutilizacaoRegistrada")),
						"200": resposta("A faixa já estava inutilizada (`repetido`): repetir o pedido é seguro.", ref("InutilizacaoRegistrada")),
						...erros(400, 401, 403, 409, 422, 502),
					},
				},
				get: {
					tags: ["Numeração"],
					summary: "Lista as inutilizações registradas por este cofre",
					description: "Serve para conferir uma inutilização cuja resposta se perdeu. Se a faixa não estiver na lista, repita o POST: o cofre e a SEFAZ reconhecem a faixa já inutilizada.",
					parameters: [
						{ name: "modelo", in: "query", schema: { type: "string", enum: ["nfe", "nfce"] } },
						{ name: "ambiente", in: "query", schema: AMBIENTE },
						{ name: "serie", in: "query", schema: { type: "integer" } },
					],
					responses: { "200": resposta("Inutilizações, da mais nova para a mais antiga.", { type: "object", properties: { inutilizacoes: { type: "array", items: ref("InutilizacaoRegistrada") } } }), ...erros(400, 401) },
				},
			},
			"/v1/inutilizacoes/{id}": {
				get: { tags: ["Numeração"], summary: "Consulta uma inutilização", parameters: [{ ...id, description: "Id da inutilização no cofre." }], responses: { "200": resposta("A inutilização.", ref("InutilizacaoRegistrada")), ...erros(401, 404) } },
			},
			"/v1/inutilizacoes/{id}/xml": {
				get: { tags: ["Numeração"], summary: "Baixa o XML da inutilização (ProcInutNFe)", parameters: [{ ...id, description: "Id da inutilização no cofre." }], responses: { "200": xmlDoEvento, ...erros(401, 404) } },
			},
			"/v1/series": {
				get: {
					tags: ["Numeração"],
					summary: "Séries cadastradas e o próximo número de cada uma",
					description: "As séries são cadastradas pelo emitente na tela do cofre, com o número inicial. O pedido de emissão escolhe a série entre as cadastradas.",
					responses: { "200": resposta("Séries.", { type: "object", properties: { series: { type: "array", items: ref("Serie") } } }), ...erros(401) },
				},
			},
			"/v1/cofre": {
				get: {
					tags: ["Cofre"],
					summary: "Estado do cofre",
					description: "Versão instalada, atualização pendente, validade do certificado e ambientes liberados. Nunca inclui chaves nem segredos.",
					responses: { "200": resposta("Estado.", ref("Cofre")), ...erros(401) },
				},
			},
			"/v1/sefaz/status": {
				get: {
					tags: ["Cofre"],
					summary: "Status do serviço de autorização da SEFAZ",
					parameters: [
						{ name: "uf", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 2 } },
						{ name: "modelo", in: "query", schema: { type: "string", enum: ["nfe", "nfce"], default: "nfe" } },
						{ name: "ambiente", in: "query", schema: { ...AMBIENTE, default: "homologacao" } },
					],
					responses: { "200": resposta("Status.", ref("StatusSefaz")), ...erros(400, 401, 403, 409, 422) },
				},
			},
			"/v1/openapi.json": { get: { tags: ["Cofre"], summary: "Este contrato", security: [], responses: { "200": resposta("OpenAPI 3.1.") } } },
		},
		components: {
			securitySchemes: { chaveDeApi: { type: "http", scheme: "bearer", description: "Chave de API do cofre: `Authorization: Bearer nfapi_...`." } },
			schemas: {
				Erro: {
					type: "object",
					properties: {
						erro: {
							type: "object",
							properties: {
								codigo: {
									type: "string",
									description: "Código estável do erro; a tabela está em `x-codigos`. Novos códigos podem surgir em versões novas: trate um código desconhecido pelo status HTTP.",
									"x-codigos": CODIGOS_DE_ERRO,
								},
								mensagem: texto,
							},
							required: ["codigo", "mensagem"],
						},
						campo: { ...textoOuNulo, description: "Em erros de validação da NF-e e NFC-e: o campo recusado." },
						nfe: ref("EmissaoNfe"),
						nfce: ref("EmissaoNfe"),
						nfse: ref("EmissaoNfse"),
						mensagens,
					},
					required: ["erro"],
				},
				Cabecalho,
				PedidoNfe: { allOf: [ref("Cabecalho"), esquema(NfeInput)] },
				OpcoesNfce,
				PedidoNfce: { allOf: [ref("Cabecalho"), ref("OpcoesNfce"), esquema(NfceInput)] },
				PedidoNfse: { allOf: [ref("Cabecalho"), esquema(NfseInput)] },
				CancelamentoNfe: esquema(CancelamentoNfe),
				CancelamentoNfse: esquema(CancelamentoInput),
				CartaCorrecao: esquema(CartaCorrecao),
				Inutilizacao: esquema(InutilizacaoInput),
				EmissaoNfe,
				EmissaoNfse,
				Cupom,
				LinhaDoCupom,
				InutilizacaoRegistrada: {
					type: "object",
					properties: {
						id: texto,
						modelo: texto,
						ambiente: AMBIENTE,
						serie: { type: "integer" },
						numeroInicial: { type: "integer" },
						numeroFinal: { type: "integer" },
						protocolo: { ...textoOuNulo, description: "Nulo quando a SEFAZ só confirmou que a faixa já estava inutilizada." },
						justificativa: texto,
						xmlDisponivel: { type: "boolean" },
						criadaEm: dataHora,
						repetido: { type: "boolean", description: "Só na resposta do POST: a faixa já estava inutilizada." },
					},
				},
				Serie: {
					type: "object",
					properties: {
						modelo: { type: "string", enum: ["nfe", "nfce"] },
						ambiente: AMBIENTE,
						serie: { type: "integer" },
						proximoNumero: { type: "integer", description: "Número que a próxima nota da série vai receber." },
						descricao: textoOuNulo,
						cnpj: texto,
					},
				},
				Cofre: {
					type: "object",
					properties: {
						versao: texto,
						atualizacao: { type: "object", properties: { versaoPublicada: textoOuNulo, pendente: { type: "boolean" } } },
						certificado: {
							type: ["object", "null"],
							properties: {
								titular: texto,
								documento: { type: "object", properties: { kind: { type: "string", enum: ["cnpj", "cpf"] }, id: texto } },
								validoAte: dataHora,
								diasRestantes: { type: "integer" },
							},
						},
						producaoLiberada: { type: "boolean" },
						contingencia: {
							type: "object",
							properties: { notasPendentes: { type: "integer", description: "NFC-e emitidas em contingência que ainda aguardam a transmissão à SEFAZ." } },
						},
						chave: { type: "object", properties: { escopo: { type: "string", enum: ["completo", "homologacao"] }, ambientes: { type: "array", items: AMBIENTE } } },
						documentos: {
							type: "object",
							description: "O que este cofre emite e, para NF-e e NFC-e, em quais UFs.",
							properties: {
								nfse: { type: "boolean" },
								nfe: { type: "object", properties: { ufs: { type: "array", items: texto } } },
								nfce: { type: "object", properties: { ufs: { type: "array", items: texto } } },
							},
						},
					},
				},
				StatusSefaz: {
					type: "object",
					properties: {
						modelo: texto,
						uf: texto,
						ambiente: AMBIENTE,
						autorizador: texto,
						emOperacao: { type: "boolean" },
						mensagem: { type: "object", properties: { codigo: texto, descricao: texto } },
						tempoMedioSegundos: { type: ["number", "null"] },
					},
				},
			},
		},
	};
}
