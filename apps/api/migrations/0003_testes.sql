-- Testes de homologação executados pelo admin ou pela IA.

-- Dados fiscais usados nos testes de cada emitente (município, serviço, regime).
CREATE TABLE test_profiles (
	emitter_id TEXT PRIMARY KEY,
	profile TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);

-- Histórico das execuções. Não guarda XML: só o resultado e os detalhes.
CREATE TABLE test_runs (
	id TEXT PRIMARY KEY,
	emitter_id TEXT NOT NULL,
	emitter_name TEXT NOT NULL,
	scenario TEXT NOT NULL,
	-- admin | ia
	origin TEXT NOT NULL,
	-- aprovado | reprovado | erro
	status TEXT NOT NULL,
	summary TEXT NOT NULL,
	detail TEXT NOT NULL DEFAULT '{}',
	started_at INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL
);
CREATE INDEX test_runs_started ON test_runs (started_at DESC);
