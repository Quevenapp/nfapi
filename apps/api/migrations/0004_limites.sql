-- Limite de taxa das rotas públicas (janela fixa). A chave identifica a rota e
-- quem chama (ex.: "cadastro:203.0.113.7").
CREATE TABLE rate_limits (
	key TEXT NOT NULL,
	window INTEGER NOT NULL,
	count INTEGER NOT NULL,
	PRIMARY KEY (key, window)
);
