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
};
const erros = (...codigos: number[]) => Object.fromEntries(codigos.map((c) => [String(c), resposta(ERROS[c] as string, ref("Erro"))]));

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
			enum: ["processando", "autorizada", "rejeitada", "denegada", "erro", "indefinida", "cancelada"],
			description:
				"`indefinida`: a resposta do governo se perdeu; use POST .../consultar ou repita o pedido com a mesma referência. `erro`: barrada pelo cofre antes de transmitir.",
		},
		chaveAcesso: textoOuNulo,
		protocolo: textoOuNulo,
		valor: { type: ["number", "null"], description: "Valor total da nota (vNF), somado pelo cofre." },
		qrCode: { ...textoOuNulo, description: "Só na NFC-e: conteúdo do QR Code." },
		urlConsulta: { ...textoOuNulo, description: "Só na NFC-e: endereço de consulta pela chave." },
		cartasCorrecao: { type: "integer" },
		mensagens,
		xmlDisponivel: { type: "boolean" },
		criadaEm: dataHora,
		atualizadaEm: dataHora,
	},
	required: ["id", "modelo", "ambiente", "serie", "numero", "situacao", "mensagens", "xmlDisponivel"],
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
	{ name: "referencia", in: "query", schema: texto, description: "Pesquisa pela referência do seu sistema." },
	{ name: "limite", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
];
const xml = { description: "XML autorizado.", content: { "application/xml": { schema: texto } } };

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
				responses: { "201": resposta("Autorizada.", emissao), "200": resposta("A referência já tinha uma nota: nada foi reenviado.", emissao), ...erros(400, 401, 403, 409, 422, 502) },
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
				description: "Para emissões em situação `indefinida`. Nas demais situações devolve o registro como está.",
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
				responses: { "200": resposta("Cancelada.", emissao), ...erros(400, 401, 403, 404, 409, 422, 502) },
			},
		},
	};
	if (doc === "nfe") {
		rotas[`${base}/{id}/carta-correcao`] = {
			post: {
				tags,
				summary: "Registra uma carta de correção",
				description: "Até 20 por nota. A carta mais recente substitui as anteriores, então o texto deve trazer todas as correções.",
				parameters: [id],
				requestBody: corpo(ref("CartaCorrecao"), { correcao: "Endereço de entrega: Rua das Acácias, 45, sala 2" }),
				responses: { "200": resposta("Registrada.", emissao), ...erros(400, 401, 403, 404, 409, 422, 502) },
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
			"/v1/nfse/{id}/cancelar": {
				post: {
					tags: ["NFS-e"],
					summary: "Cancela a NFS-e",
					parameters: [id],
					requestBody: corpo(ref("CancelamentoNfse"), { motivo: "erro_emissao", justificativa: "Nota emitida com o valor incorreto" }),
					responses: { "200": resposta("Cancelada.", nfse), ...erros(400, 401, 403, 404, 409, 422, 502) },
				},
			},
			"/v1/inutilizacoes": {
				post: {
					tags: ["Numeração"],
					summary: "Inutiliza uma faixa de numeração de NF-e ou NFC-e",
					description: "Para números que não serão usados (lacunas). A faixa não pode conter nota autorizada ou em andamento neste cofre.",
					requestBody: corpo(ref("Inutilizacao"), { modelo: "nfe", ambiente: "homologacao", uf: "SP", serie: 1, numeroInicial: 15, numeroFinal: 15, justificativa: "Número pulado por falha no sistema anterior" }),
					responses: { "201": resposta("Homologada pela SEFAZ.", ref("InutilizacaoRegistrada")), ...erros(400, 401, 403, 409, 422, 502) },
				},
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
						erro: { type: "object", properties: { codigo: texto, mensagem: texto }, required: ["codigo", "mensagem"] },
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
				PedidoNfce: { allOf: [ref("Cabecalho"), esquema(NfceInput)] },
				PedidoNfse: { allOf: [ref("Cabecalho"), esquema(NfseInput)] },
				CancelamentoNfe: esquema(CancelamentoNfe),
				CancelamentoNfse: esquema(CancelamentoInput),
				CartaCorrecao: esquema(CartaCorrecao),
				Inutilizacao: esquema(InutilizacaoInput),
				EmissaoNfe,
				EmissaoNfse,
				InutilizacaoRegistrada: {
					type: "object",
					properties: { id: texto, modelo: texto, ambiente: AMBIENTE, serie: { type: "integer" }, numeroInicial: { type: "integer" }, numeroFinal: { type: "integer" }, protocolo: textoOuNulo, criadaEm: dataHora },
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
