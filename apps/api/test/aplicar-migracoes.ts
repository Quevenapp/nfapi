import { applyD1Migrations, env } from "cloudflare:test";

// Cria as tabelas da API e do cofre nos bancos D1 locais.
await applyD1Migrations(env.DB, env.API_MIGRATIONS);
await applyD1Migrations(env.VAULT_DB, env.VAULT_MIGRATIONS);
