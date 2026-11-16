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

/**
 * Endereço que o Cloudflare informa em CF-Connecting-IP quando a chamada parte
 * de outro Worker. É o mesmo para todos os Workers, então não identifica ninguém.
 */
const SAIDA_DOS_WORKERS = "2a06:98c0:3600::103";

/**
 * Quem está chamando, para fins de limite de taxa. Chamadas feitas por um
 * Worker (o caso do cofre no cadastro) são identificadas pela zona do Worker,
 * que o Cloudflare informa em CF-Worker; as demais, pelo IP.
 *
 * CF-Worker só é considerado quando o IP é o de saída dos Workers: assim um
 * cliente comum não troca de identidade inventando esse cabeçalho.
 */
export function ipDoCliente(headers: Headers): string {
	const ip = headers.get("cf-connecting-ip") ?? "desconhecido";
	const worker = headers.get("cf-worker");
	return ip === SAIDA_DOS_WORKERS && worker ? `worker:${worker.toLowerCase()}` : ip;
}
