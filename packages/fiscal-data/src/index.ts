// Dados fiscais: tudo aqui muda por publicação do governo, não por decisão de
// código. É a área que o monitor de IA pode atualizar sozinho quando os testes
// passam (ver plano: "atualização por risco").

import nfse from "../data/nfse-nacional.json";

export type Ambiente = "producao" | "homologacao";

/** Leiautes da DPS que a API sabe gerar. */
export type LeiauteDps = "1.01" | "1.01-nt009";

export type PerfilAssinatura = "rsa-sha1" | "rsa-sha256";

export interface NfseAmbiente {
	/** Base da API SEFIN Nacional (emissão, consulta e eventos). */
	sefin: string;
	leiaute: LeiauteDps;
	/** Pasta dos XSD oficiais em schemas/nfse/. */
	schemas: string;
}

export const NFSE_NACIONAL = nfse as {
	assinatura: PerfilAssinatura;
	ambientes: Record<Ambiente, NfseAmbiente>;
};

export function nfseAmbiente(ambiente: Ambiente): NfseAmbiente {
	return NFSE_NACIONAL.ambientes[ambiente];
}
