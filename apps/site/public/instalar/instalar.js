// Gerador do segredo do cofre.
//
// O segredo nasce e morre nesta aba: é gerado com o gerador criptográfico do
// navegador, não é enviado a nenhum servidor e não é gravado em armazenamento
// local. A página não carrega nenhum recurso externo (ver a CSP em _headers).

(function () {
	"use strict";
	var $ = function (id) { return document.getElementById(id); };
	var campo = $("segredo");

	// 32 bytes aleatórios em hexadecimal: 64 caracteres, 256 bits.
	function gerarSegredo() {
		var bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		var hex = "";
		for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
		return hex;
	}

	function avisar(texto) {
		$("aviso").textContent = texto;
	}

	$("gerar").addEventListener("click", function () {
		if (campo.value && !confirm("Gerar um novo segredo? O anterior deixa de aparecer nesta página.")) return;
		campo.value = gerarSegredo();
		$("caixa-segredo").hidden = false;
		$("gerar").textContent = "Gerar outro segredo";
		avisar("Segredo gerado. Copie ou baixe antes de sair desta página.");
	});

	$("copiar").addEventListener("click", async function () {
		try {
			await navigator.clipboard.writeText(campo.value);
			avisar("Copiado. Cole no campo VAULT_SECRET do formulário do Cloudflare.");
		} catch (e) {
			// Sem permissão de área de transferência: seleciona para cópia manual.
			campo.type = "text";
			campo.select();
			avisar("Não foi possível copiar automaticamente. O segredo está selecionado: use Ctrl+C.");
		}
	});

	$("baixar").addEventListener("click", function () {
		var conteudo =
			"Segredo do cofre NFapi (VAULT_SECRET)\r\n" +
			"Gerado em: " + new Date().toLocaleString("pt-BR") + "\r\n\r\n" +
			campo.value + "\r\n\r\n" +
			"Use este valor no campo VAULT_SECRET ao instalar o cofre no Cloudflare\r\n" +
			"e para entrar na tela /setup do seu cofre.\r\n" +
			"Guarde este arquivo em local seguro e não o compartilhe.\r\n";
		var url = URL.createObjectURL(new Blob([conteudo], { type: "text/plain;charset=utf-8" }));
		var link = document.createElement("a");
		link.href = url;
		link.download = "nfapi-cofre-segredo.txt";
		document.body.appendChild(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
		avisar("Arquivo nfapi-cofre-segredo.txt baixado. Guarde-o em local seguro.");
	});

	$("mostrar").addEventListener("click", function (ev) {
		var visivel = campo.type === "text";
		campo.type = visivel ? "password" : "text";
		ev.currentTarget.textContent = visivel ? "Mostrar" : "Ocultar";
		ev.currentTarget.setAttribute("aria-pressed", String(!visivel));
	});

	// Sair da página com um segredo gerado pede confirmação.
	window.addEventListener("beforeunload", function (ev) {
		if (campo.value) ev.preventDefault();
	});
})();
