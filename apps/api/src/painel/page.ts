// Painel de administração do NFapi, servido em /painel.
//
// HTML, CSS e JS em rotas separadas, para uma CSP sem 'unsafe-inline'. O JS não
// usa innerHTML: todo texto vindo do servidor entra por textContent.

export const PAINEL_HTML = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>NFapi Admin</title>
<link rel="stylesheet" href="/painel/app.css">
</head>
<body>
<main>
	<header>
		<h1>NFapi Admin</h1>
		<p class="muted">Testes de homologação dos documentos fiscais.</p>
	</header>

	<section id="login" class="card">
		<h2>Entrar</h2>
		<form id="login-form">
			<label for="token">Token de administração</label>
			<input id="token" type="password" autocomplete="off" required>
			<button type="submit">Entrar</button>
		</form>
		<p id="login-error" class="bad" role="alert"></p>
	</section>

	<div id="panel" hidden>
		<section class="card">
			<h2>Contas e cofres</h2>
			<p class="muted small">Cada conta tem suas chaves de API e seus emitentes (cofres pareados).</p>

			<label for="account">Conta</label>
			<select id="account"></select>
			<p id="no-accounts" class="warn" hidden>Nenhuma conta ainda. Crie a primeira abaixo.</p>

			<div id="account-detail" hidden>
				<h3>Chaves de API</h3>
				<ul id="keys" class="results"></ul>
				<button type="button" id="key-new" class="ghost">Gerar nova chave</button>

				<h3>Cofres conectados</h3>
				<ul id="vaults" class="results"></ul>
				<form id="pair-form">
					<label for="pair-code">Código de pareamento (gerado na tela /setup do cofre)</label>
					<textarea id="pair-code" rows="3" placeholder="nfapi-cofre-v1...." required></textarea>
					<button type="submit">Conectar cofre</button>
					<span id="pair-message" role="status"></span>
				</form>
			</div>

			<div id="key-box" hidden>
				<p class="warn">Copie agora: a chave de API aparece uma única vez.</p>
				<textarea id="key-value" readonly rows="2"></textarea>
				<button type="button" id="key-copy" class="ghost">Copiar chave</button>
			</div>

			<h3>Nova conta</h3>
			<form id="account-form">
				<div class="grid">
					<div>
						<label for="a-nome">Nome</label>
						<input id="a-nome" type="text" minlength="2" maxlength="120" required>
					</div>
					<div>
						<label for="a-email">E-mail</label>
						<input id="a-email" type="email" maxlength="200" required>
					</div>
				</div>
				<button type="submit" class="ghost">Criar conta</button>
				<span id="account-message" role="status"></span>
			</form>
		</section>

		<section class="card">
			<h2>Emitente de teste</h2>
			<p class="muted small">Os testes usam o certificado instalado no cofre deste emitente e rodam <strong>somente em homologação</strong>.</p>
			<p id="no-emitters" class="warn" hidden>Nenhum emitente conectado. Conecte um cofre pela API (POST /v1/emitentes) para poder testar.</p>
			<div id="emitter-box" hidden>
				<label for="emitter">Emitente</label>
				<select id="emitter"></select>
				<dl id="emitter-info"></dl>

				<h3>Dados fiscais usados nos testes</h3>
				<form id="profile-form">
					<div class="grid">
						<div>
							<label for="p-municipio">Município (código IBGE)</label>
							<input id="p-municipio" type="text" inputmode="numeric" pattern="[0-9]{7}" maxlength="7" placeholder="3550308" required>
						</div>
						<div>
							<label for="p-servico">Código de tributação nacional</label>
							<input id="p-servico" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="010701" required>
						</div>
						<div>
							<label for="p-simples">Simples Nacional</label>
							<select id="p-simples">
								<option value="nao_optante">Não optante</option>
								<option value="mei">MEI</option>
								<option value="me_epp">ME / EPP</option>
							</select>
						</div>
						<div>
							<label for="p-apuracao">Apuração (só ME/EPP)</label>
							<select id="p-apuracao">
								<option value="">Não se aplica</option>
								<option value="1">1: tudo pelo Simples</option>
								<option value="2">2: ISSQN fora do Simples</option>
								<option value="3">3: tudo fora do Simples</option>
							</select>
						</div>
						<div>
							<label for="p-serie">Série reservada aos testes</label>
							<input id="p-serie" type="text" inputmode="numeric" pattern="[0-9]{1,5}" maxlength="5" value="900" required>
						</div>
					</div>
					<button type="submit" class="ghost">Salvar dados de teste</button>
					<span id="profile-message" role="status"></span>
				</form>
			</div>
		</section>

		<section class="card" id="scenarios-card" hidden>
			<h2>Cenários</h2>
			<div id="scenarios"></div>
			<div class="row">
				<button type="button" id="run">Executar selecionados</button>
				<button type="button" id="select-all" class="ghost">Marcar todos os disponíveis</button>
			</div>
			<p id="run-message" role="status"></p>
			<ul id="results" class="results"></ul>
		</section>

		<section class="card">
			<h2>Histórico</h2>
			<p class="muted small">Inclui as execuções feitas pela IA antes de aplicar uma atualização.</p>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Quando</th><th>Emitente</th><th>Cenário</th><th>Origem</th><th>Resultado</th><th>Resumo</th></tr></thead>
					<tbody id="history"></tbody>
				</table>
			</div>
		</section>
	</div>
</main>
<script src="/painel/app.js"></script>
</body>
</html>`;

export const PAINEL_CSS = String.raw`:root {
	--bg: #f5f6f8; --card: #ffffff; --text: #16202c; --muted: #5b6776; --line: #d9dee5;
	--accent: #0b5cd6; --accent-text: #ffffff; --ok: #12773d; --bad: #b3261e; --warn: #8a5300;
	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0f141a; --card: #18202a; --text: #e7ecf2; --muted: #9aa7b6; --line: #2b3643;
		--accent: #5c9dff; --accent-text: #0b1420; --ok: #5fd08d; --bad: #ff8a80; --warn: #f2b65a;
	}
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
header { margin-bottom: 20px; }
h1 { font-size: 1.6rem; margin: 0 0 4px; }
h2 { font-size: 1.1rem; margin: 0 0 12px; }
h3 { font-size: 0.95rem; margin: 20px 0 4px; }
p { margin: 0 0 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
.muted { color: var(--muted); }
.small { font-size: 0.875rem; }
.ok { color: var(--ok); }
.bad { color: var(--bad); }
.warn { color: var(--warn); font-weight: 600; }
label { display: block; font-weight: 600; font-size: 0.9rem; margin: 12px 0 4px; }
input[type="text"], input[type="password"], input[type="email"], select, textarea {
	width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
	background: var(--bg); color: var(--text); font: inherit;
}
textarea { font-family: ui-monospace, Consolas, monospace; font-size: 0.8rem; word-break: break-all; resize: vertical; }
.results li.line { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.results li.line .acts { display: flex; gap: 8px; flex-wrap: wrap; }
.results li.line button { margin-top: 0; padding: 6px 12px; }
button.danger { border-color: var(--bad); color: var(--bad); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0 16px; }
button {
	margin-top: 14px; padding: 10px 16px; border: 1px solid var(--accent); border-radius: 8px;
	background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer;
}
button.ghost { background: transparent; color: var(--accent); }
button:disabled { opacity: 0.6; cursor: progress; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 12px 0 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.group-title { font-weight: 700; margin: 14px 0 2px; }
.scenario { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--line); }
.scenario input { margin-top: 5px; width: 18px; height: 18px; flex: none; }
.scenario label { margin: 0; font-weight: 600; }
.scenario .detail { display: block; font-weight: 400; color: var(--muted); font-size: 0.875rem; }
.scenario.off label { color: var(--muted); }
.results { list-style: none; margin: 14px 0 0; padding: 0; }
.results li { padding: 10px 0; border-top: 1px solid var(--line); }
.results .head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-weight: 600; }
.results .detail { display: block; color: var(--muted); font-size: 0.875rem; overflow-wrap: anywhere; }
pre { margin: 8px 0 0; padding: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; font-size: 0.8rem; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
details summary { cursor: pointer; color: var(--accent); font-size: 0.875rem; margin-top: 4px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 999px; border: 1px solid currentColor; font-size: 0.8rem; font-weight: 700; white-space: nowrap; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
th, td { text-align: left; padding: 6px 12px 6px 0; border-top: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; border-top: 0; white-space: nowrap; }
td.nowrap { white-space: nowrap; }
[hidden] { display: none !important; }`;

export const PAINEL_JS = String.raw`(function () {
	"use strict";
	var token = "";
	var state = { cenarios: [], emitentes: [] };
	var $ = function (id) { return document.getElementById(id); };
	var DOCS = { cofre: "Cofre", nfse: "NFS-e", nfe: "NF-e", nfce: "NFC-e" };
	var RESULT = { aprovado: ["Aprovado", "ok"], reprovado: ["Reprovado", "bad"], erro: ["Erro", "warn"] };

	function el(tag, props, children) {
		var node = document.createElement(tag);
		Object.keys(props || {}).forEach(function (k) {
			if (k === "text") node.textContent = props[k];
			else if (props[k] !== false && props[k] !== undefined) node.setAttribute(k, props[k] === true ? "" : props[k]);
		});
		(children || []).forEach(function (c) { node.appendChild(c); });
		return node;
	}
	function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
	function date(iso) { return new Date(iso).toLocaleString("pt-BR"); }
	function badge(resultado) {
		var r = RESULT[resultado] || [resultado, "muted"];
		return el("span", { class: "badge " + r[1], text: r[0] });
	}

	async function api(method, path, body) {
		var init = { method: method, headers: { authorization: "Bearer " + token } };
		if (body !== undefined) {
			init.headers["content-type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		var res = await fetch(path, init);
		var json = await res.json().catch(function () { return null; });
		if (!res.ok) throw new Error((json && json.erro && json.erro.mensagem) || ("Erro HTTP " + res.status));
		return json;
	}
	async function busy(button, task) {
		button.disabled = true;
		try { return await task(); } finally { button.disabled = false; }
	}
	function message(id, text, kind) { $(id).textContent = text; $(id).className = kind || ""; }

	function current() {
		return state.emitentes.find(function (e) { return e.id === $("emitter").value; });
	}

	function renderEmitter() {
		var e = current();
		var info = $("emitter-info");
		clear(info);
		if (!e) return;
		var rows = [
			[e.documento.tipo.toUpperCase(), e.documento.numero],
			["Conta", e.conta.nome],
			["Cofre", e.cofre.situacao + (e.cofre.producaoLiberada ? " · produção liberada" : " · produção bloqueada")],
			["Certificado", "válido até " + date(e.certificadoValidoAte)]
		];
		rows.forEach(function (r) {
			info.appendChild(el("dt", { text: r[0] }));
			info.appendChild(el("dd", { text: r[1] }));
		});
		var p = e.perfil || {};
		$("p-municipio").value = p.codigoMunicipio || "";
		$("p-servico").value = p.codigoTributacaoNacional || "";
		$("p-simples").value = p.simplesNacional || "nao_optante";
		$("p-apuracao").value = p.apuracaoSimples ? String(p.apuracaoSimples) : "";
		$("p-serie").value = p.serie || "900";
		message("profile-message", e.perfil ? "" : "Preencha para liberar os testes fiscais.", e.perfil ? "" : "warn");
	}

	function renderScenarios() {
		var box = $("scenarios");
		clear(box);
		var lastDoc = "";
		state.cenarios.forEach(function (c) {
			if (c.documento !== lastDoc) {
				box.appendChild(el("p", { class: "group-title", text: DOCS[c.documento] || c.documento }));
				lastDoc = c.documento;
			}
			var id = "c-" + c.id;
			var label = el("label", { for: id, text: c.nome }, []);
			label.appendChild(el("span", { class: "detail", text: c.disponivel ? c.descricao : c.motivo }));
			box.appendChild(el("div", { class: "scenario" + (c.disponivel ? "" : " off") }, [
				el("input", { type: "checkbox", id: id, value: c.id, checked: c.disponivel, disabled: !c.disponivel }),
				label
			]));
		});
	}

	function resultItem(x) {
		var cenario = state.cenarios.find(function (c) { return c.id === x.cenario; });
		var head = el("div", { class: "head" }, [
			el("span", { text: cenario ? cenario.nome : x.cenario }),
			badge(x.resultado)
		]);
		var item = el("li", {}, [head, el("span", { class: "detail", text: x.resumo + " (" + x.duracaoMs + " ms)" })]);
		if (Object.keys(x.detalhes || {}).length) {
			item.appendChild(el("details", {}, [
				el("summary", { text: "Detalhes" }),
				el("pre", { text: JSON.stringify(x.detalhes, null, 2) })
			]));
		}
		return item;
	}

	async function renderHistory() {
		var data = await api("GET", "/admin/testes/execucoes?limite=40");
		var body = $("history");
		clear(body);
		data.execucoes.forEach(function (x) {
			var cenario = state.cenarios.find(function (c) { return c.id === x.cenario; });
			body.appendChild(el("tr", {}, [
				el("td", { class: "nowrap", text: date(x.iniciadaEm) }),
				el("td", { text: x.nomeEmitente }),
				el("td", { text: cenario ? cenario.nome : x.cenario }),
				el("td", { text: x.origem === "ia" ? "IA" : "Admin" }),
				el("td", {}, [badge(x.resultado)]),
				el("td", { text: x.resumo })
			]));
		});
		if (!data.execucoes.length) {
			body.appendChild(el("tr", {}, [el("td", { colspan: "6", class: "muted", text: "Nenhuma execução ainda." })]));
		}
	}

	async function refresh(keep) {
		var selected = keep ? $("emitter").value : "";
		state = await api("GET", "/admin/testes");
		var select = $("emitter");
		clear(select);
		state.emitentes.forEach(function (e) {
			select.appendChild(el("option", { value: e.id, text: e.nome + " — " + e.documento.numero }));
		});
		if (selected) select.value = selected;
		var has = state.emitentes.length > 0;
		$("no-emitters").hidden = has;
		$("emitter-box").hidden = !has;
		$("scenarios-card").hidden = !has;
		renderEmitter();
		if (!keep) renderScenarios();
		await renderHistory();
	}

	// ---------- Contas e cofres ----------

	function showKey(chave) {
		$("key-value").value = chave.chave;
		$("key-box").hidden = false;
		$("key-copy").textContent = "Copiar chave";
	}

	function line(title, detail, buttons) {
		var info = el("span", {}, [el("strong", { text: title }), el("span", { class: "detail", text: detail })]);
		return el("li", { class: "line" }, [info, el("span", { class: "acts" }, buttons)]);
	}

	function action(text, danger, handler) {
		var button = el("button", { type: "button", class: danger ? "ghost danger" : "ghost", text: text });
		button.addEventListener("click", function () { busy(button, handler).catch(function (err) { alert(err.message); }); });
		return button;
	}

	async function loadAccount() {
		var id = $("account").value;
		$("account-detail").hidden = !id;
		if (!id) return;
		var data = await api("GET", "/admin/contas/" + id);

		var keys = $("keys");
		clear(keys);
		data.chaves.forEach(function (k) {
			var detail = k.prefixo + "… · criada em " + date(k.criadaEm) +
				(k.revogadaEm ? " · revogada em " + date(k.revogadaEm) : (k.ultimoUso ? " · último uso " + date(k.ultimoUso) : " · nunca usada"));
			keys.appendChild(line(k.nome, detail, k.revogadaEm ? [] : [
				action("Revogar", true, async function () {
					if (!confirm("Revogar a chave \"" + k.nome + "\"? Quem a usa perde o acesso na hora.")) return;
					await api("DELETE", "/admin/chaves/" + k.id);
					await loadAccount();
				})
			]));
		});

		var vaults = $("vaults");
		clear(vaults);
		if (!data.emitentes.length) vaults.appendChild(el("li", { class: "muted", text: "Nenhum cofre conectado a esta conta." }));
		data.emitentes.forEach(function (e) {
			var detail = e.documento.tipo.toUpperCase() + " " + e.documento.numero + " · " + e.cofre.situacao +
				(e.cofre.detalhe ? " (" + e.cofre.detalhe + ")" : "") +
				" · " + (e.cofre.producaoLiberada ? "produção liberada" : "produção bloqueada") +
				" · certificado até " + date(e.certificado.validoAte);
			vaults.appendChild(line(e.nome, detail, [
				action("Verificar", false, async function () {
					await api("POST", "/admin/emitentes/" + e.id + "/verificar");
					await loadAccount();
					await refresh(true);
				}),
				action("Desconectar", true, async function () {
					if (!confirm("Desconectar o cofre de \"" + e.nome + "\"? O certificado e os XML continuam no cofre.")) return;
					await api("DELETE", "/admin/emitentes/" + e.id);
					await loadAccount();
					await refresh(false);
				})
			]));
		});
	}

	async function loadAccounts(selected) {
		var data = await api("GET", "/admin/contas");
		var select = $("account");
		var keep = selected || select.value;
		clear(select);
		data.contas.forEach(function (a) {
			select.appendChild(el("option", { value: a.id, text: a.nome + " — " + a.email }));
		});
		if (keep) select.value = keep;
		$("no-accounts").hidden = data.contas.length > 0;
		select.hidden = data.contas.length === 0;
		await loadAccount();
	}

	$("account").addEventListener("change", function () {
		$("key-box").hidden = true;
		loadAccount();
	});

	$("account-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		message("account-message", "");
		try {
			var data = await busy(ev.submitter, function () {
				return api("POST", "/admin/contas", { nome: $("a-nome").value, email: $("a-email").value });
			});
			$("a-nome").value = "";
			$("a-email").value = "";
			await loadAccounts(data.conta.id);
			showKey(data.chave);
			message("account-message", "Conta criada.", "ok");
		} catch (err) {
			message("account-message", err.message, "bad");
		}
	});

	$("key-new").addEventListener("click", async function (ev) {
		try {
			var data = await busy(ev.currentTarget, function () {
				return api("POST", "/admin/contas/" + $("account").value + "/chaves", { nome: "Chave criada em " + new Date().toLocaleDateString("pt-BR") });
			});
			await loadAccount();
			showKey(data.chave);
		} catch (err) {
			alert(err.message);
		}
	});

	$("key-copy").addEventListener("click", async function () {
		$("key-value").select();
		try {
			await navigator.clipboard.writeText($("key-value").value);
			$("key-copy").textContent = "Copiada";
		} catch (e) {
			document.execCommand("copy");
		}
	});

	$("pair-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		message("pair-message", "Consultando o cofre…");
		try {
			await busy(ev.submitter, function () {
				return api("POST", "/admin/contas/" + $("account").value + "/emitentes", { codigoPareamento: $("pair-code").value.trim() });
			});
			$("pair-code").value = "";
			message("pair-message", "Cofre conectado.", "ok");
			await loadAccount();
			await refresh(false);
		} catch (err) {
			message("pair-message", err.message, "bad");
		}
	});

	$("login-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		token = $("token").value.trim();
		message("login-error", "");
		try {
			await refresh(false);
			await loadAccounts();
			$("token").value = "";
			$("login").hidden = true;
			$("panel").hidden = false;
		} catch (err) {
			token = "";
			message("login-error", err.message, "bad");
		}
	});

	$("emitter").addEventListener("change", renderEmitter);

	$("profile-form").addEventListener("submit", async function (ev) {
		ev.preventDefault();
		var perfil = {
			codigoMunicipio: $("p-municipio").value.trim(),
			codigoTributacaoNacional: $("p-servico").value.trim(),
			simplesNacional: $("p-simples").value,
			serie: $("p-serie").value.trim()
		};
		if ($("p-apuracao").value) perfil.apuracaoSimples = Number($("p-apuracao").value);
		try {
			await busy(ev.submitter, function () { return api("PUT", "/admin/testes/perfis/" + $("emitter").value, perfil); });
			await refresh(true);
			message("profile-message", "Dados salvos.", "ok");
		} catch (err) {
			message("profile-message", err.message, "bad");
		}
	});

	$("select-all").addEventListener("click", function () {
		document.querySelectorAll("#scenarios input:not(:disabled)").forEach(function (i) { i.checked = true; });
	});

	$("run").addEventListener("click", async function (ev) {
		var ids = Array.prototype.map.call(document.querySelectorAll("#scenarios input:checked"), function (i) { return i.value; });
		var list = $("results");
		clear(list);
		if (!ids.length) return message("run-message", "Marque ao menos um cenário.", "warn");
		message("run-message", "Executando " + ids.length + " cenário(s) em homologação… a primeira conexão do cofre pode levar alguns segundos.");
		try {
			var data = await busy(ev.currentTarget, function () {
				return api("POST", "/admin/testes/execucoes", { emitente: $("emitter").value, cenarios: ids });
			});
			var ok = data.execucoes.filter(function (x) { return x.resultado === "aprovado"; }).length;
			message("run-message", ok + " de " + data.execucoes.length + " aprovado(s).", data.aprovado ? "ok" : "bad");
			data.execucoes.forEach(function (x) { list.appendChild(resultItem(x)); });
		} catch (err) {
			message("run-message", err.message, "bad");
		}
		await renderHistory();
	});
})();`;
