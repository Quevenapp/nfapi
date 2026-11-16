// QR Code da NFC-e emitida online (tpEmis = 1), na versão 3 (NT 2025.001):
//
//   <endereço da UF>?p=<chave>|3|<tpAmb>
//
// A versão 3 dispensa o CSC (código de segurança do contribuinte) e é aceita
// em todas as UFs desde 09/2025. A versão 2, com CSC e hash, continua válida
// para o governo, mas o cofre não a usa: assim o emitente não precisa cadastrar
// nada além do certificado.

import type { Ambiente, Autorizador } from "../fiscal/dados";

export function suplementoNfce(
	chave: string,
	ambiente: Ambiente,
	enderecos: NonNullable<Autorizador["nfce"]>,
): { qrCode: string; urlChave: string } {
	const tpAmb = ambiente === "homologacao" ? "2" : "1";
	return { qrCode: `${enderecos.qrCode}?p=${chave}|3|${tpAmb}`, urlChave: enderecos.urlChave };
}
