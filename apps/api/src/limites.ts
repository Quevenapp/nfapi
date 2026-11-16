// Limite de taxa simples, em janela fixa, guardado no D1.

/**
 * Conta mais um uso de `key` na janela atual. Devolve false quando o limite já
 * foi atingido. O incremento é atômico (UPSERT), então chamadas simultâneas não
 * passam do limite por corrida.
 */
export async function dentroDoLimite(
	d1: D1Database,
	key: string,
	limite: number,
	janelaSegundos: number,
): Promise<boolean> {
	const janela = Math.floor(Date.now() / 1000 / janelaSegundos);
	const row = await d1
		.prepare(
			`INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1)
			 ON CONFLICT (key, window) DO UPDATE SET count = count + 1
			 RETURNING count`,
		)
		.bind(key, janela)
		.first<{ count: number }>();
	// Limpeza ocasional das janelas antigas.
	if (Math.random() < 0.02) {
		await d1.prepare("DELETE FROM rate_limits WHERE window < ?").bind(janela - 2).run();
	}
	return (row?.count ?? 1) <= limite;
}

/** IP de quem chamou, como o Cloudflare informa. */
export function ipDoCliente(headers: Headers): string {
	return headers.get("cf-connecting-ip") ?? "desconhecido";
}
