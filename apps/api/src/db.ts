// Acesso ao D1 da API central.

export interface Account {
	id: string;
	name: string;
	email: string;
	status: string;
	createdAt: number;
}

export interface ApiKey {
	id: string;
	accountId: string;
	name: string;
	prefix: string;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export type EmitterStatus =
	| "ativo"
	| "inacessivel"
	| "pareamento_recusado"
	| "sem_certificado"
	| "certificado_vencido"
	| "cofre_desatualizado";

export interface Emitter {
	id: string;
	accountId: string;
	docKind: "cnpj" | "cpf";
	docId: string;
	name: string;
	vaultUrl: string;
	pairingId: string;
	pairingKeyIv: string;
	pairingKeyCt: string;
	vaultVersion: string;
	vaultProtocol: number;
	allowProduction: boolean;
	certIssuer: string;
	certNotAfter: number;
	status: EmitterStatus;
	statusDetail: string;
	checkedAt: number;
	createdAt: number;
}

type Row = Record<string, unknown>;

const toAccount = (r: Row): Account => ({
	id: r.id as string,
	name: r.name as string,
	email: r.email as string,
	status: r.status as string,
	createdAt: r.created_at as number,
});

const toApiKey = (r: Row): ApiKey => ({
	id: r.id as string,
	accountId: r.account_id as string,
	name: r.name as string,
	prefix: r.prefix as string,
	createdAt: r.created_at as number,
	lastUsedAt: (r.last_used_at as number | null) ?? null,
	revokedAt: (r.revoked_at as number | null) ?? null,
});

const toEmitter = (r: Row): Emitter => ({
	id: r.id as string,
	accountId: r.account_id as string,
	docKind: r.doc_kind as "cnpj" | "cpf",
	docId: r.doc_id as string,
	name: r.name as string,
	vaultUrl: r.vault_url as string,
	pairingId: r.pairing_id as string,
	pairingKeyIv: r.pairing_key_iv as string,
	pairingKeyCt: r.pairing_key_ct as string,
	vaultVersion: r.vault_version as string,
	vaultProtocol: r.vault_protocol as number,
	allowProduction: r.allow_production === 1,
	certIssuer: r.cert_issuer as string,
	certNotAfter: r.cert_not_after as number,
	status: r.status as EmitterStatus,
	statusDetail: r.status_detail as string,
	checkedAt: r.checked_at as number,
	createdAt: r.created_at as number,
});

// ---------- Contas ----------

export async function createAccount(
	db: D1Database,
	input: { id: string; name: string; email: string },
): Promise<Account | null> {
	const now = Date.now();
	const res = await db
		.prepare("INSERT OR IGNORE INTO accounts (id, name, email, created_at) VALUES (?, ?, ?, ?)")
		.bind(input.id, input.name, input.email, now)
		.run();
	if (res.meta.changes === 0) return null;
	return { id: input.id, name: input.name, email: input.email, status: "ativa", createdAt: now };
}

export async function getAccount(db: D1Database, id: string): Promise<Account | null> {
	const row = await db.prepare("SELECT * FROM accounts WHERE id = ?").bind(id).first<Row>();
	return row ? toAccount(row) : null;
}

export async function listAccounts(db: D1Database): Promise<Account[]> {
	const { results } = await db.prepare("SELECT * FROM accounts ORDER BY created_at DESC").all<Row>();
	return results.map(toAccount);
}

// ---------- Chaves de API ----------

export async function createApiKey(
	db: D1Database,
	input: { id: string; accountId: string; name: string; prefix: string; hash: string },
): Promise<ApiKey> {
	const now = Date.now();
	await db
		.prepare(
			"INSERT INTO api_keys (id, account_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.bind(input.id, input.accountId, input.name, input.prefix, input.hash, now)
		.run();
	return {
		id: input.id,
		accountId: input.accountId,
		name: input.name,
		prefix: input.prefix,
		createdAt: now,
		lastUsedAt: null,
		revokedAt: null,
	};
}

/** Localiza a conta dona de uma chave ativa. */
export async function findAccountByKeyHash(
	db: D1Database,
	hash: string,
): Promise<{ account: Account; keyId: string } | null> {
	const row = await db
		.prepare(
			`SELECT a.*, k.id AS key_id FROM api_keys k JOIN accounts a ON a.id = k.account_id
			 WHERE k.key_hash = ? AND k.revoked_at IS NULL AND a.status = 'ativa'`,
		)
		.bind(hash)
		.first<Row>();
	return row ? { account: toAccount(row), keyId: row.key_id as string } : null;
}

export async function touchApiKey(db: D1Database, id: string): Promise<void> {
	await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

export async function listApiKeys(db: D1Database, accountId: string): Promise<ApiKey[]> {
	const { results } = await db
		.prepare("SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at DESC")
		.bind(accountId)
		.all<Row>();
	return results.map(toApiKey);
}

export async function revokeApiKey(db: D1Database, id: string): Promise<boolean> {
	const res = await db
		.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
		.bind(Date.now(), id)
		.run();
	return res.meta.changes > 0;
}

// ---------- Emitentes ----------

export async function findEmitterByDoc(
	db: D1Database,
	accountId: string,
	docId: string,
): Promise<Emitter | null> {
	const row = await db
		.prepare("SELECT * FROM emitters WHERE account_id = ? AND doc_id = ?")
		.bind(accountId, docId)
		.first<Row>();
	return row ? toEmitter(row) : null;
}

export async function getEmitter(
	db: D1Database,
	accountId: string,
	id: string,
): Promise<Emitter | null> {
	const row = await db
		.prepare("SELECT * FROM emitters WHERE account_id = ? AND id = ?")
		.bind(accountId, id)
		.first<Row>();
	return row ? toEmitter(row) : null;
}

/** Uso administrativo: emitentes de todas as contas, com o nome da conta. */
export async function listAllEmitters(db: D1Database): Promise<(Emitter & { accountName: string })[]> {
	const { results } = await db
		.prepare(
			`SELECT e.*, a.name AS account_name FROM emitters e JOIN accounts a ON a.id = e.account_id
			 ORDER BY e.created_at DESC`,
		)
		.all<Row>();
	return results.map((r) => ({ ...toEmitter(r), accountName: r.account_name as string }));
}

/** Uso administrativo: localiza o emitente sem filtrar por conta. */
export async function getEmitterById(db: D1Database, id: string): Promise<Emitter | null> {
	const row = await db.prepare("SELECT * FROM emitters WHERE id = ?").bind(id).first<Row>();
	return row ? toEmitter(row) : null;
}

export async function listEmitters(db: D1Database, accountId: string): Promise<Emitter[]> {
	const { results } = await db
		.prepare("SELECT * FROM emitters WHERE account_id = ? ORDER BY created_at DESC")
		.bind(accountId)
		.all<Row>();
	return results.map(toEmitter);
}

/**
 * Grava um emitente ou atualiza o existente (mesmo id). Usa UPSERT, e não
 * REPLACE: o REPLACE apaga a linha antes de regravar e dispararia exclusões em
 * cascata nas tabelas que referenciam o emitente.
 */
export async function saveEmitter(db: D1Database, e: Emitter): Promise<void> {
	await db
		.prepare(
			`INSERT INTO emitters
			 (id, account_id, doc_kind, doc_id, name, vault_url, pairing_id, pairing_key_iv, pairing_key_ct,
			  vault_version, vault_protocol, allow_production, cert_issuer, cert_not_after,
			  status, status_detail, checked_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET
			  name = excluded.name, vault_url = excluded.vault_url, pairing_id = excluded.pairing_id,
			  pairing_key_iv = excluded.pairing_key_iv, pairing_key_ct = excluded.pairing_key_ct,
			  vault_version = excluded.vault_version, vault_protocol = excluded.vault_protocol,
			  allow_production = excluded.allow_production, cert_issuer = excluded.cert_issuer,
			  cert_not_after = excluded.cert_not_after, status = excluded.status,
			  status_detail = excluded.status_detail, checked_at = excluded.checked_at`,
		)
		.bind(
			e.id,
			e.accountId,
			e.docKind,
			e.docId,
			e.name,
			e.vaultUrl,
			e.pairingId,
			e.pairingKeyIv,
			e.pairingKeyCt,
			e.vaultVersion,
			e.vaultProtocol,
			e.allowProduction ? 1 : 0,
			e.certIssuer,
			e.certNotAfter,
			e.status,
			e.statusDetail,
			e.checkedAt,
			e.createdAt,
		)
		.run();
}

export async function deleteEmitter(db: D1Database, accountId: string, id: string): Promise<boolean> {
	const res = await db
		.prepare("DELETE FROM emitters WHERE account_id = ? AND id = ?")
		.bind(accountId, id)
		.run();
	return res.meta.changes > 0;
}
