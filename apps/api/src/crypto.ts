// Segredos da API central: chaves de API (só o hash é gravado) e chaves de
// pareamento dos cofres (gravadas cifradas com chave derivada do MASTER_KEY).

const encoder = new TextEncoder();
const SALT = encoder.encode("nfapi-api");

export function secretIsStrong(secret: string | undefined): secret is string {
	return typeof secret === "string" && secret.trim().length >= 32;
}

function toBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = "";
	for (const b of view) out += b.toString(16).padStart(2, "0");
	return out;
}

async function sealingKey(masterKey: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey("raw", encoder.encode(masterKey), "HKDF", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode("pairing-key/v1") },
		material,
		256,
	);
	return crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** O `context` (id do emitente) amarra o texto cifrado à linha a que pertence. */
export async function seal(
	masterKey: string,
	context: string,
	data: Uint8Array,
): Promise<{ iv: string; ciphertext: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const out = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: encoder.encode(context) },
		await sealingKey(masterKey),
		data as BufferSource,
	);
	return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(out)) };
}

export async function open(
	masterKey: string,
	context: string,
	iv: string,
	ciphertext: string,
): Promise<Uint8Array> {
	const out = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(context) },
		await sealingKey(masterKey),
		fromBase64(ciphertext),
	);
	return new Uint8Array(out);
}

// ---------- Chaves de API ----------

const KEY_PREFIX = "nfapi_";

export function looksLikeApiKey(value: string): boolean {
	return /^nfapi_[A-Za-z0-9_-]{40,60}$/.test(value);
}

export async function hashApiKey(key: string): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(key)));
}

/** Gera uma chave nova. `prefix` é o trecho seguro de exibir em listagens. */
export async function newApiKey(): Promise<{ key: string; prefix: string; hash: string }> {
	const random = toBase64(crypto.getRandomValues(new Uint8Array(32)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const key = KEY_PREFIX + random;
	return { key, prefix: key.slice(0, 12), hash: await hashApiKey(key) };
}

/** Comparação em tempo constante (via hash) para o token de administração. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const [x, y] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const p = new Uint8Array(x);
	const q = new Uint8Array(y);
	let diff = 0;
	for (let i = 0; i < p.length; i++) diff |= (p[i] ?? 0) ^ (q[i] ?? 0);
	return diff === 0;
}

export function newId(prefix: "cta" | "chv" | "emi" | "nfs"): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	return `${prefix}_${toHex(bytes)}`;
}
