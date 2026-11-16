// Emissões no D1: metadados, numeração das séries e idempotência.

import type { Ambiente } from "@nfapi/fiscal-data";
import type { Mensagem } from "@nfapi/nfse-nacional";

export type EmissionStatus = "processando" | "autorizada" | "rejeitada" | "erro" | "indefinida";

export interface Emission {
	id: string;
	accountId: string;
	emitterId: string;
	docId: string;
	kind: "nfse";
	environment: Ambiente;
	reference: string | null;
	serie: string;
	number: number;
	documentId: string;
	status: EmissionStatus;
	accessKey: string | null;
	fiscalNumber: string | null;
	messages: Mensagem[];
	documentKey: string | null;
	journalKey: string | null;
	createdAt: number;
	updatedAt: number;
}

type Row = Record<string, unknown>;

const toEmission = (r: Row): Emission => ({
	id: r.id as string,
	accountId: r.account_id as string,
	emitterId: r.emitter_id as string,
	docId: r.doc_id as string,
	kind: r.kind as "nfse",
	environment: r.environment as Ambiente,
	reference: (r.reference as string | null) ?? null,
	serie: r.serie as string,
	number: r.number as number,
	documentId: r.document_id as string,
	status: r.status as EmissionStatus,
	accessKey: (r.access_key as string | null) ?? null,
	fiscalNumber: (r.fiscal_number as string | null) ?? null,
	messages: JSON.parse(r.messages as string) as Mensagem[],
	documentKey: (r.document_key as string | null) ?? null,
	journalKey: (r.journal_key as string | null) ?? null,
	createdAt: r.created_at as number,
	updatedAt: r.updated_at as number,
});

interface SerieKey {
	accountId: string;
	docId: string;
	kind: "nfse";
	environment: Ambiente;
	serie: string;
}

/** Reserva o próximo número da série, de forma atômica. */
export async function nextNumber(db: D1Database, k: SerieKey): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO series (account_id, doc_id, kind, environment, serie, last_number)
			 VALUES (?, ?, ?, ?, ?, 1)
			 ON CONFLICT (account_id, doc_id, kind, environment, serie)
			 DO UPDATE SET last_number = last_number + 1
			 RETURNING last_number`,
		)
		.bind(k.accountId, k.docId, k.kind, k.environment, k.serie)
		.first<{ last_number: number }>();
	if (!row) throw new Error("Falha ao reservar o número da série.");
	return row.last_number;
}

/** Quando o cliente informa o número, a série avança para não reutilizá-lo depois. */
export async function noteNumber(db: D1Database, k: SerieKey, number: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO series (account_id, doc_id, kind, environment, serie, last_number)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (account_id, doc_id, kind, environment, serie)
			 DO UPDATE SET last_number = MAX(last_number, excluded.last_number)`,
		)
		.bind(k.accountId, k.docId, k.kind, k.environment, k.serie, number)
		.run();
}

/** Grava a emissão. Devolve false se o número (ou a referência) já estiver em uso. */
export async function insertEmission(db: D1Database, e: Emission): Promise<boolean> {
	try {
		await db
			.prepare(
				`INSERT INTO emissions
				 (id, account_id, emitter_id, doc_id, kind, environment, reference, serie, number,
				  document_id, status, messages, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
			)
			.bind(
				e.id,
				e.accountId,
				e.emitterId,
				e.docId,
				e.kind,
				e.environment,
				e.reference,
				e.serie,
				e.number,
				e.documentId,
				e.status,
				e.createdAt,
				e.updatedAt,
			)
			.run();
		return true;
	} catch (err) {
		if (/UNIQUE constraint/i.test(String(err instanceof Error ? err.message : err))) return false;
		throw err;
	}
}

export async function updateEmission(
	db: D1Database,
	id: string,
	patch: Partial<
		Pick<
			Emission,
			"status" | "accessKey" | "fiscalNumber" | "messages" | "documentKey" | "journalKey" | "documentId" | "emitterId"
		>
	>,
): Promise<Emission> {
	const current = await db.prepare("SELECT * FROM emissions WHERE id = ?").bind(id).first<Row>();
	if (!current) throw new Error(`Emissão ${id} inexistente.`);
	const next = { ...toEmission(current), ...patch, updatedAt: Date.now() };
	await db
		.prepare(
			`UPDATE emissions SET status = ?, access_key = ?, fiscal_number = ?, messages = ?,
			 document_key = ?, journal_key = ?, document_id = ?, emitter_id = ?, updated_at = ? WHERE id = ?`,
		)
		.bind(
			next.status,
			next.accessKey,
			next.fiscalNumber,
			JSON.stringify(next.messages),
			next.documentKey,
			next.journalKey,
			next.documentId,
			next.emitterId,
			next.updatedAt,
			id,
		)
		.run();
	return next;
}

export async function getEmission(db: D1Database, accountId: string, id: string): Promise<Emission | null> {
	const row = await db
		.prepare("SELECT * FROM emissions WHERE account_id = ? AND id = ?")
		.bind(accountId, id)
		.first<Row>();
	return row ? toEmission(row) : null;
}

export async function findByReference(
	db: D1Database,
	k: Omit<SerieKey, "serie">,
	reference: string,
): Promise<Emission | null> {
	const row = await db
		.prepare(
			`SELECT * FROM emissions
			 WHERE account_id = ? AND doc_id = ? AND kind = ? AND environment = ? AND reference = ?`,
		)
		.bind(k.accountId, k.docId, k.kind, k.environment, reference)
		.first<Row>();
	return row ? toEmission(row) : null;
}

export async function listEmissions(
	db: D1Database,
	accountId: string,
	opts: { emitterId?: string; limit: number },
): Promise<Emission[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM emissions WHERE account_id = ? AND (? IS NULL OR emitter_id = ?)
			 ORDER BY created_at DESC LIMIT ?`,
		)
		.bind(accountId, opts.emitterId ?? null, opts.emitterId ?? null, opts.limit)
		.all<Row>();
	return results.map(toEmission);
}
