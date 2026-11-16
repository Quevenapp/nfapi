declare module "*?raw" {
	const content: string;
	export default content;
}

declare namespace Cloudflare {
	interface Env {
		DB: D1Database;
		VAULT_DB: D1Database;
		VAULT_DOCS: R2Bucket;
		MASTER_KEY: string;
		ADMIN_TOKEN: string;
		VAULT_SECRET: string;
		API_MIGRATIONS: import("cloudflare:test").D1Migration[];
		VAULT_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
