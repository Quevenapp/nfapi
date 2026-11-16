import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { dentroDoLimite, ipDoCliente } from "../src/limites";

const SAIDA_DOS_WORKERS = "2a06:98c0:3600::103";
const h = (init: Record<string, string>) => new Headers(init);

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM rate_limits").run();
});

describe("limite de taxa", () => {
	it("conta por chave e barra a partir do limite", async () => {
		for (let i = 0; i < 3; i++) expect(await dentroDoLimite(env.DB, "rota:a", 3, 3600)).toBe(true);
		expect(await dentroDoLimite(env.DB, "rota:a", 3, 3600)).toBe(false);
		// Outra chave tem a própria contagem.
		expect(await dentroDoLimite(env.DB, "rota:b", 3, 3600)).toBe(true);
	});

	it("identifica cofres pela zona do Worker, e não pelo endereço de saída compartilhado", () => {
		const cofreA = ipDoCliente(h({ "cf-connecting-ip": SAIDA_DOS_WORKERS, "cf-worker": "Empresa-A.workers.dev" }));
		const cofreB = ipDoCliente(h({ "cf-connecting-ip": SAIDA_DOS_WORKERS, "cf-worker": "empresa-b.workers.dev" }));
		expect(cofreA).toBe("worker:empresa-a.workers.dev");
		expect(cofreB).not.toBe(cofreA);
	});

	it("um cliente comum não muda de identidade inventando o cabeçalho CF-Worker", () => {
		const real = ipDoCliente(h({ "cf-connecting-ip": "203.0.113.7" }));
		const forjado = ipDoCliente(h({ "cf-connecting-ip": "203.0.113.7", "cf-worker": "qualquer.workers.dev" }));
		expect(forjado).toBe(real);
		expect(ipDoCliente(h({}))).toBe("desconhecido");
	});
});
