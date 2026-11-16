-- Quem usa a API.
CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'ativa',
	created_at INTEGER NOT NULL
);

-- Chaves de API. Só o hash SHA-256 é gravado; a chave aparece uma única vez.
CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	prefix TEXT NOT NULL,
	key_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
);
CREATE INDEX api_keys_account ON api_keys (account_id);

-- Emitentes: um CNPJ/CPF com seu cofre pareado. A chave HMAC do pareamento
-- fica cifrada (AES-GCM) com chave derivada do MASTER_KEY.
CREATE TABLE emitters (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	doc_kind TEXT NOT NULL,
	doc_id TEXT NOT NULL,
	name TEXT NOT NULL,
	vault_url TEXT NOT NULL,
	pairing_id TEXT NOT NULL,
	pairing_key_iv TEXT NOT NULL,
	pairing_key_ct TEXT NOT NULL,
	vault_version TEXT NOT NULL,
	vault_protocol INTEGER NOT NULL,
	allow_production INTEGER NOT NULL DEFAULT 0,
	cert_issuer TEXT NOT NULL,
	cert_not_after INTEGER NOT NULL,
	status TEXT NOT NULL,
	status_detail TEXT NOT NULL DEFAULT '',
	checked_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (account_id, doc_id)
);
