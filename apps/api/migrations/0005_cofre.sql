-- Proteção contra repetição das requisições que os cofres assinam para a API
-- (o painel do usuário, na tela /setup do cofre, pede cancelamentos por aqui).
CREATE TABLE api_nonces (
	nonce TEXT PRIMARY KEY,
	expires_at INTEGER NOT NULL
);
CREATE INDEX api_nonces_expires_at ON api_nonces (expires_at);
