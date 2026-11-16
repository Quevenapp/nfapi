import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Testes de integração dentro do workerd: a API fala com o cofre real (o código
// de vault/), cada um com seu próprio banco D1 local. Só o transporte mTLS do
// cofre é simulado.
export default defineConfig(async () => {
	const here = import.meta.dirname;
	const [apiMigrations, vaultMigrations] = await Promise.all([
		readD1Migrations(path.join(here, "migrations")),
		readD1Migrations(path.join(here, "../../vault/migrations")),
	]);
	return {
		plugins: [
			cloudflareTest({
				miniflare: {
					compatibilityDate: "2026-11-01",
					compatibilityFlags: ["nodejs_compat"],
					d1Databases: ["DB", "VAULT_DB"],
					r2Buckets: ["VAULT_DOCS"],
					bindings: {
						API_MIGRATIONS: apiMigrations,
						VAULT_MIGRATIONS: vaultMigrations,
						// Segredos fixos, usados somente nos testes.
						MASTER_KEY: "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a",
						ADMIN_TOKEN: "a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7",
						VAULT_SECRET: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
					},
				},
			}),
		],
		test: {
			include: ["test/**/*.test.ts"],
			setupFiles: ["./test/aplicar-migracoes.ts"],
		},
	};
});
