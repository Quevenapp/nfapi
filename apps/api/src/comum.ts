// Tipos e utilitários compartilhados pelas rotas da API.

import { z } from "@hono/zod-openapi";
import type { VaultClient } from "@nfapi/vault-client";
import type { Context } from "hono";
import type * as db from "./db";

export interface ApiEnv {
	DB: D1Database;
	MASTER_KEY: string;
	ADMIN_TOKEN: string;
	/**
	 * Opcional. Token de escopo reduzido para a IA: só consulta e executa os
	 * testes de homologação, sem acesso ao restante da administração.
	 */
	TESTES_TOKEN?: string;
}

export type Ctx = {
	Bindings: ApiEnv;
	Variables: { account: db.Account; origem: "admin" | "ia" };
};
export type C = Context<Ctx>;

/** O que as rotas fiscais precisam das rotas de emitentes. */
export interface RotasDeps {
	vaultFor(c: C, emitter: db.Emitter): Promise<VaultClient>;
}

export const Erro = z
	.object({
		erro: z.object({
			codigo: z.string().openapi({ example: "nao_autenticado" }),
			mensagem: z.string(),
		}),
	})
	.openapi("Erro");

export type Status = 400 | 401 | 404 | 409 | 422 | 429 | 500 | 502 | 503;

export function erro<S extends Status>(c: C, status: S, codigo: string, mensagem: string) {
	return c.json({ erro: { codigo, mensagem } }, status);
}

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
	description,
	content: { "application/json": { schema } },
});

export const erros = {
	400: json(Erro, "Requisição inválida."),
	401: json(Erro, "Chave de API ausente, inválida ou revogada."),
	404: json(Erro, "Recurso inexistente nesta conta."),
} as const;

export const security = [{ chaveApi: [] }];

export const iso = (ms: number) => new Date(ms).toISOString();
