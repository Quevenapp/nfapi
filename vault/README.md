# Cofre NFapi

O cofre é o emissor de notas fiscais do [NFapi](https://github.com/Quevenapp/nfapi). Ele roda na **sua** conta Cloudflare: guarda o certificado digital A1, expõe a API que os seus sistemas chamam para emitir, monta e assina os documentos, fala com o governo (SEFAZ e NFS-e Nacional) e arquiva os XML. Não há serviço intermediário.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/nfapi/tree/main/vault)

## O que é criado na sua conta

| Recurso | Para quê |
|---|---|
| Worker `nfapi-cofre` | A API de emissão (`/v1/...`) e o painel do emitente (`/setup`) |
| Container | Conexão mTLS com o governo (os servidores das SEFAZ usam certificados ICP-Brasil, que o Workers sozinho não aceita) |
| Banco D1 `nfapi-cofre` | Certificado cifrado, chaves de API, emissões, numeração, auditoria e índice dos documentos |
| Bucket R2 `nfapi-cofre-docs` | XML autorizados, eventos e o diário de transmissões |

O Container exige o plano **Workers Paid** (US$ 5/mês) na sua conta Cloudflare.

## Instalação

O passo a passo completo, com gerador do segredo, está em **<https://nfapi.queven.app/instalar>**. Em resumo:

1. Gere o segredo do cofre (`VAULT_SECRET`) na página acima, ou com o comando abaixo, e guarde-o em local seguro:

   ```bash
   openssl rand -hex 32
   ```

   Ele cifra o certificado e é a senha do painel. Se for perdido, será preciso reinstalar o certificado.
2. Clique em **Deploy to Cloudflare**. No campo `VAULT_SECRET`, apague o que o navegador tiver preenchido sozinho e cole o segredo. Deixe **Proteger com Cloudflare Access** desligado.
3. Abra `https://<seu-cofre>/setup`, entre com o segredo e:
   - envie o arquivo `.pfx` do certificado A1 e a senha dele;
   - rode o **teste de conexão**, que consulta os serviços de homologação;
   - crie uma **chave de API** para cada sistema que vai emitir;
   - para NF-e e NFC-e, cadastre as **séries** (com o número da próxima nota);
   - configure o **gatilho de atualização** (veja abaixo); enquanto ele faltar, o painel avisa no topo.

A produção começa **bloqueada**: o cofre só emite em homologação até você liberar no painel.

## API

Todas as chamadas levam a chave de API em `Authorization: Bearer nfapi_...`.

O contrato completo (OpenAPI 3.1), com todos os campos e exemplos, está em [`docs/openapi.json`](docs/openapi.json) e é servido pelo próprio cofre em `GET /v1/openapi.json`, sempre na versão instalada.

Os três documentos têm o mesmo desenho; `{doc}` é `nfse`, `nfe` (modelo 55) ou `nfce` (modelo 65):

| Rota | O que faz |
|---|---|
| `POST /v1/{doc}` | Emite |
| `GET /v1/{doc}` | Lista as emissões (`?referencia=` pesquisa pela referência do seu sistema) |
| `GET /v1/{doc}/:id` | Consulta uma emissão |
| `GET /v1/{doc}/:id/xml` | Baixa o XML autorizado |
| `POST /v1/{doc}/:id/cancelar` | Cancela |
| `POST /v1/{doc}/:id/consultar` | NF-e e NFC-e: consulta a SEFAZ e fecha uma emissão que ficou sem resposta |
| `POST /v1/nfe/:id/carta-correcao` | NF-e: registra uma carta de correção |
| `POST /v1/inutilizacoes` | NF-e e NFC-e: inutiliza uma faixa de numeração (extinta em SP, AC e BA) |
| `GET /v1/series` | Séries cadastradas e o próximo número de cada uma |
| `GET /v1/cofre` | Versão, atualização pendente, validade do certificado e ambientes liberados |
| `GET /v1/sefaz/status` | Status do serviço de autorização da UF |

### NF-e e NFC-e

- **O cofre não calcula imposto.** O seu sistema informa bases, alíquotas e valores de cada item; o cofre numera, monta o XML, soma os totais, assina, transmite e arquiva a nota com o protocolo.
- **Séries cadastradas.** A NF-e e a NFC-e só são emitidas em séries cadastradas no painel do cofre, onde se informa o número da próxima nota (para quem já emitia por outro sistema). O pedido escolhe a série; na NFC-e, o usual é uma série por caixa.
- **Sem lacunas por rejeição.** Nota rejeitada não existe para a SEFAZ: o número volta para a série.
- **UFs atendidas.** NF-e: SP e as UFs autorizadas pela SVRS (AC, AL, AP, CE, DF, ES, PA, PB, PI, RJ, RN, RO, RR, SC, SE, TO). NFC-e: SP. `GET /v1/cofre` devolve a lista da versão instalada.
- **Reforma tributária.** O grupo de IBS e CBS (`impostos.ibsCbs`) já é exigido do regime normal em homologação; o cofre o repassa como informado e soma os totais. Cobre alíquota reduzida, diferimento, devolução de tributo, tributação regular, compras governamentais, IBS e CBS do Simples Nacional, estorno de crédito e crédito presumido, além do Imposto Seletivo (`impostos.impostoSeletivo`). Ainda fora: regime monofásico (combustíveis), transferência de crédito, ajuste de competência e crédito presumido da Zona Franca de Manaus. O valor da nota (`vNF`) ainda não inclui IBS, CBS nem Imposto Seletivo.
- **Exportação e importação.** Na exportação, o destinatário vai com `idEstrangeiro` e endereço no exterior (`uf: "EX"`, `codigoMunicipio: "9999999"`, `codigoPais`), a nota leva `exportacao` (UF e local de embarque) e o item pode levar `exportacao` (drawback e exportação indireta). Na importação, o item leva `importacao` (a declaração de importação com as adições) e `impostos.ii`.
- **Ainda não há:** DANFE e DANFCE em PDF, contingência da NF-e (SVC) e eventos além de cancelamento e carta de correção.

### Contingência da NFC-e

Cobre o caso em que a SEFAZ não responde e a loja continua com internet. O certificado segue só no cofre: se a loja ficar sem internet, o caixa não alcança o cofre e não há emissão.

No pedido de NFC-e, `"contingencia": "automatica"` faz o cofre esperar até 20 segundos pela SEFAZ e, sem resposta conclusiva, emitir a nota em contingência offline (tipo de emissão 9). A resposta vem com `situacao: "contingencia"`, a chave, o QR Code offline e sem protocolo: é o que o caixa imprime.

- A nota em contingência usa um número novo. A nota normal que ficou sem resposta é conferida depois; se tiver sido autorizada, o cofre a cancela por substituição (evento 110112).
- Enquanto a SEFAZ segue fora, as vendas seguintes saem direto em contingência, sem esperar.
- A cada 5 minutos o cofre confere o status da SEFAZ e, quando ela volta, transmite as notas pendentes, o mesmo XML já assinado. `POST /v1/nfce/:id/consultar` tenta na hora, e `GET /v1/cofre` informa quantas notas aguardam.
- Se a SEFAZ rejeitar a nota na transmissão, ela fica `rejeitada` com o motivo e mantém o número. O sistema corrige e reenvia com a mesma referência; a nota sai com o mesmo número e a mesma data.
- `"contingencia": "forcada"` emite direto em contingência; o padrão, `"nunca"`, devolve 502.

Obrigações de quem emite em contingência, que ficam com o sistema do caixa: imprimir o DANFCE com os dizeres "EMITIDA EM CONTINGÊNCIA" e "Pendente de autorização", guardar a via do estabelecimento (ou o XML, conforme a regra da UF) e respeitar o prazo legal de transmissão, que é o fim do primeiro dia útil seguinte.

Um pedido de NFC-e:

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfce \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "ambiente": "homologacao",
    "referencia": "caixa1-venda-5001",
    "serie": 1,
    "naturezaOperacao": "Venda ao consumidor",
    "emitente": { "nome": "Loja Exemplo Ltda", "inscricaoEstadual": "111111111111", "regime": "simples_nacional",
      "endereco": { "logradouro": "Rua das Flores", "numero": "100", "bairro": "Centro",
        "codigoMunicipio": "3550308", "municipio": "São Paulo", "uf": "SP", "cep": "01001000" } },
    "itens": [ { "codigo": "789", "descricao": "Camiseta de algodão", "ncm": "61091000", "cfop": "5102",
      "unidade": "UN", "quantidade": 1, "valorUnitario": 59.9,
      "impostos": { "icms": { "origem": 0, "csosn": "102" } } } ],
    "pagamentos": [ { "forma": "01", "valor": 100 } ],
    "troco": 40.1
  }'
```

A resposta traz `chaveAcesso`, `protocolo`, `numero`, `valor` e, na NFC-e, `qrCode` e `urlConsulta`. Um exemplo de NF-e está no contrato.

### NFS-e

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfse \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{
    "ambiente": "homologacao",
    "referencia": "pedido-1001",
    "prestador": { "codigoMunicipio": "3550308", "regimeTributario": { "simplesNacional": "me_epp", "apuracaoSimples": 1 } },
    "tomador": { "cnpj": "99888777000166", "nome": "Cliente Ltda" },
    "servico": { "codigoMunicipioPrestacao": "3550308", "codigoTributacaoNacional": "010701", "descricao": "Suporte técnico" },
    "valores": { "servico": 1500 },
    "tributacao": { "issqn": { "aliquota": 2 }, "totalTributos": { "tipo": "percentual_simples", "percentual": 6 } }
  }'
```

- **`ambiente`**: `homologacao` (padrão) ou `producao`.
- **`referencia`**: o identificador do pedido no seu sistema. Reenviar a mesma referência nunca gera duas notas; se a primeira tentativa ficou sem resposta do governo, o cofre consulta antes de reenviar. A mesma referência com conteúdo diferente é recusada (`referencia_com_conteudo_diferente`); só uma nota rejeitada pode ser reenviada corrigida com a mesma referência. Vale para os três documentos.
- A numeração da DPS é controlada pelo cofre, por série. O emitente é sempre o titular do certificado instalado.
- Erros vêm como `{ "erro": { "codigo": "...", "mensagem": "..." } }`. Quando o governo rejeita a nota, o corpo traz também a emissão, com as mensagens recebidas.
- Uma chave criada como **somente homologação** nunca emite nem cancela em produção, mesmo com a produção liberada.

Cancelamento:

```bash
curl -X POST https://SEU-COFRE.workers.dev/v1/nfse/ID_DA_EMISSAO/cancelar \
  -H "Authorization: Bearer nfapi_SUA_CHAVE" \
  -H "Content-Type: application/json" \
  -d '{ "motivo": "erro_emissao", "justificativa": "Nota emitida com o valor incorreto" }'
```

Os campos aceitos estão no contrato; os schemas que os validam ficam em [`src/nfse/schema.ts`](src/nfse/schema.ts) e [`src/nfe/schema.ts`](src/nfe/schema.ts).

## Atualização

O governo muda regras, endereços e leiautes com frequência. As correções são publicadas no canal estável do NFapi (branch `cofre-estavel`), e o painel avisa quando há uma versão nova.

Para atualizar com um clique, crie o gatilho uma única vez:

1. No painel do Cloudflare, abra **Workers & Pages** e selecione o Worker do cofre.
2. Em **Configurações > Compilações > Ganchos de implantação** (em inglês, Settings > Builds > Deploy Hooks), clique em **Adicionar**, dê um nome ao gancho, escolha a branch `main` e salve.
3. Copie a URL que aparece abaixo do gancho e cole na seção **Atualização** do painel do cofre.

O botão **Atualizar** dispara um build no Cloudflare. No começo do build, [`tools/atualizar.mjs`](tools/atualizar.mjs) baixa a versão publicada e a instala por cima; o nome do Worker, o banco, o bucket e tudo o que está guardado neles são preservados. Sem o gatilho, o mesmo resultado se obtém refazendo o deploy pelo painel do Cloudflare.

A atualização instala código publicado em `Quevenapp/nfapi`, que é aberto e pode ser conferido antes. Ela só acontece quando você dispara. Quem mantém um fork próprio pode desligá-la com a variável de build `NFAPI_ATUALIZAR=0`, ou apontar para outro repositório com `NFAPI_REPO` e `NFAPI_CANAL`.

## Segurança

- O certificado é gravado cifrado (AES-GCM) com chave derivada do `VAULT_SECRET`; a senha do `.pfx` não é guardada.
- O cofre só assina documentos cujo emitente é o titular do certificado e só transmite para endereços `*.gov.br`.
- As chaves de API são guardadas como hash; o valor aparece uma única vez, na criação, e cada chave pode ser revogada no painel.
- Toda troca com o governo fica gravada no seu R2, e toda operação, na trilha de auditoria.
- A URL do gatilho de atualização fica cifrada no cofre.

## Desenvolvimento

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm dev
```

`pnpm testar-certificado caminho/certificado.pfx` verifica, nesta máquina, se um certificado A1 é aceito pelos serviços de homologação.
