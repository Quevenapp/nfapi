-- Emissões de documentos fiscais. Só metadados: o XML fica no cofre do emitente.
--
-- A chave fiscal é (conta, documento do emitente), e não o id do emitente, para
-- que o histórico e a numeração sobrevivam a desconectar e reconectar o cofre.
CREATE TABLE emissions (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	emitter_id TEXT NOT NULL,
	doc_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	environment TEXT NOT NULL,
	reference TEXT,
	serie TEXT NOT NULL,
	number INTEGER NOT NULL,
	document_id TEXT NOT NULL,
	-- processando | autorizada | rejeitada | erro (não chegou a ser transmitida)
	-- | indefinida (transmitida, sem resposta conclusiva)
	status TEXT NOT NULL,
	access_key TEXT,
	fiscal_number TEXT,
	messages TEXT NOT NULL DEFAULT '[]',
	document_key TEXT,
	journal_key TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- Idempotência: a mesma referência nunca gera duas notas.
CREATE UNIQUE INDEX emissions_reference
	ON emissions (account_id, doc_id, kind, environment, reference)
	WHERE reference IS NOT NULL;
-- Um número de DPS por série.
CREATE UNIQUE INDEX emissions_number
	ON emissions (account_id, doc_id, kind, environment, serie, number);
CREATE INDEX emissions_account ON emissions (account_id, created_at DESC);

-- Último número usado em cada série.
CREATE TABLE series (
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	doc_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	environment TEXT NOT NULL,
	serie TEXT NOT NULL,
	last_number INTEGER NOT NULL,
	PRIMARY KEY (account_id, doc_id, kind, environment, serie)
);
