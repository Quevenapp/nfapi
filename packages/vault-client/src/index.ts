// Cliente do cofre: tudo o que a API central pede ao Worker do emitente passa
// por aqui, assinado com a chave do pareamento.
//
// O contrato (tipos, cabeçalhos, assinatura) vem do próprio cofre, que é a
// fonte única de verdade do protocolo.

import {
	type CertificateInfo,
	type ErrorBody,
	type HealthResponse,
	type PairingCode,
	type SignRequest,
	type SignResponse,
	type TransmitRequest,
	type TransmitResponse,
	fromHex,
	signRequest,
} from "../../../vault/src/protocol";

export * from "../../../vault/src/protocol";

export type VaultErrorCode =
	/** Não foi possível conectar ao cofre (rede, DNS, Worker fora do ar). */
	| "cofre_inacessivel"
	/** O cofre respondeu algo que não é o protocolo esperado. */
	| "resposta_invalida"
	| (string & {});

/** Erro devolvido pelo cofre ou ocorrido ao tentar falar com ele. */
export class VaultError extends Error {
	readonly code: VaultErrorCode;
	/** Status HTTP devolvido pelo cofre; 0 quando não houve resposta. */
	readonly status: number;

	constructor(status: number, code: VaultErrorCode, message: string) {
		super(message);
		this.name = "VaultError";
		this.status = status;
		this.code = code;
	}
}

export interface DocumentEntry {
	key: string;
	contentType: string;
	size: number;
	sha256: string;
	meta: Record<string, unknown>;
	createdAt: string;
}

export interface VaultClientOptions {
	/** Origem do cofre, ex.: https://nfapi-cofre.empresa.workers.dev */
	url: string;
	pairingId: string;
	/** Chave HMAC do pareamento (32 bytes). */
	key: Uint8Array;
	/** Permite trocar o fetch (testes, service bindings). */
	fetch?: typeof fetch;
	timeoutMs?: number;
}

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

/**
 * Só aceitamos cofres em https com nome de host público: a URL vem de um
 * código colado pelo usuário e a API não pode ser usada para alcançar
 * endereços internos.
 */
export function assertVaultUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new VaultError(0, "url_invalida", "URL do cofre inválida.");
	}
	const host = url.hostname.toLowerCase();
	const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
	const isLocal = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
	if (url.protocol !== "https:" || url.username || url.password || isIp || isLocal || !host.includes(".")) {
		throw new VaultError(0, "url_invalida", "O cofre precisa estar em uma URL https pública.");
	}
	if (url.port && url.port !== "443") {
		throw new VaultError(0, "url_invalida", "O cofre precisa responder na porta 443.");
	}
	return url;
}

export class VaultClient {
	readonly origin: string;
	private readonly pairingId: string;
	private readonly key: Uint8Array;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: VaultClientOptions) {
		this.origin = assertVaultUrl(options.url).origin;
		this.pairingId = options.pairingId;
		this.key = options.key;
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? 60_000;
	}

	/** Cria o cliente a partir do código que o emitente copia da tela /setup. */
	static fromPairingCode(code: PairingCode, extra: Pick<VaultClientOptions, "fetch" | "timeoutMs"> = {}) {
		return new VaultClient({ url: code.url, pairingId: code.id, key: fromHex(code.key), ...extra });
	}

	health(): Promise<HealthResponse> {
		return this.json("GET", "/v1/health");
	}

	async certificate(): Promise<CertificateInfo | null> {
		return (await this.health()).certificate;
	}

	sign(request: SignRequest): Promise<SignResponse> {
		return this.json("POST", "/v1/sign", encoder.encode(JSON.stringify(request)));
	}

	transmit(request: TransmitRequest): Promise<TransmitResponse> {
		return this.json("POST", "/v1/transmit", encoder.encode(JSON.stringify(request)));
	}

	async putDocument(
		key: string,
		body: Uint8Array | string,
		options: { contentType: string; meta?: Record<string, unknown> },
	): Promise<DocumentEntry> {
		const headers: Record<string, string> = { "content-type": options.contentType };
		if (options.meta) headers["x-nfapi-meta"] = JSON.stringify(options.meta);
		const bytes = typeof body === "string" ? encoder.encode(body) : body;
		const out = await this.json<{ document: DocumentEntry }>("PUT", documentPath(key), bytes, headers);
		return out.document;
	}

	/** Devolve o conteúdo bruto do documento, ou null se não existir. */
	async getDocument(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
		const res = await this.send("GET", documentPath(key));
		if (res.status === 404) return null;
		if (!res.ok) throw await toVaultError(res);
		return {
			body: await res.arrayBuffer(),
			contentType: res.headers.get("content-type") ?? "application/octet-stream",
		};
	}

	async listDocuments(options: { prefix?: string; limit?: number; before?: number } = {}): Promise<DocumentEntry[]> {
		const query = new URLSearchParams();
		if (options.prefix) query.set("prefix", options.prefix);
		if (options.limit) query.set("limit", String(options.limit));
		if (options.before) query.set("before", String(options.before));
		const suffix = query.size > 0 ? `?${query}` : "";
		const out = await this.json<{ documents: DocumentEntry[] }>("GET", `/v1/documents${suffix}`);
		return out.documents;
	}

	private async json<T>(
		method: string,
		path: string,
		body: Uint8Array = EMPTY,
		headers: Record<string, string> = {},
	): Promise<T> {
		const res = await this.send(method, path, body, headers);
		if (!res.ok) throw await toVaultError(res);
		try {
			return (await res.json()) as T;
		} catch {
			throw new VaultError(res.status, "resposta_invalida", "O cofre devolveu uma resposta que não é JSON.");
		}
	}

	private async send(
		method: string,
		path: string,
		body: Uint8Array = EMPTY,
		headers: Record<string, string> = {},
	): Promise<Response> {
		const auth = await signRequest({ key: this.key, pairingId: this.pairingId, method, path, body });
		const init: RequestInit = {
			method,
			headers: { ...headers, ...auth },
			signal: AbortSignal.timeout(this.timeoutMs),
			// Nunca seguir redirecionamentos: a assinatura vale só para este destino.
			// (O Workers não aceita redirect "error"; um 3xx vira resposta inválida.)
			redirect: "manual",
		};
		if (method !== "GET" && method !== "HEAD") {
			init.body = body as BodyInit;
			(init.headers as Record<string, string>)["content-type"] ??= "application/json";
		}
		try {
			return await this.fetchImpl(this.origin + path, init);
		} catch (err) {
			throw new VaultError(
				0,
				"cofre_inacessivel",
				`Não foi possível conectar ao cofre: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

function documentPath(key: string): string {
	return `/v1/documents/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function toVaultError(res: Response): Promise<VaultError> {
	const body = (await res.json().catch(() => null)) as Partial<ErrorBody> | null;
	if (body?.error?.code) return new VaultError(res.status, body.error.code, body.error.message ?? "");
	return new VaultError(
		res.status,
		"resposta_invalida",
		`O endereço informado não respondeu como um cofre NFapi (HTTP ${res.status}).`,
	);
}
