# NFapi

API open source para emissão de notas fiscais brasileiras — **NFS-e** (Sistema Nacional), **NF-e** e **NFC-e** — no Cloudflare.

A ideia central: a API só emite. O certificado digital A1 e os documentos fiscais (XML) ficam em um **cofre** que cada emitente instala na própria conta Cloudflare. A API nunca recebe o certificado nem armazena as notas.

> **Estado: em desenvolvimento.** A emissão de NFS-e funciona nos testes automatizados, mas ainda não foi validada de ponta a ponta contra o governo. NF-e e NFC-e ainda não foram implementadas. Não use em produção.

## Como funciona

```
Seu sistema ──chave de API──▶ API NFapi
                               │ valida, monta o XML, numera
                               │ requisições assinadas (HMAC)
                               ▼
                    Cofre (na conta Cloudflare do emitente)
                    assina com o certificado A1 · arquiva os XML
                               │ mTLS
                               ▼
                    SEFAZ / NFS-e Nacional
```

## Componentes

| Pasta | O que é |
|---|---|
| [`vault/`](vault) | O cofre: certificado, assinatura, transporte mTLS e arquivo. Instalável pelo botão Deploy to Cloudflare. |
| [`apps/api/`](apps/api) | A API central: contas, chaves, emitentes, emissão e o painel de administração. |
| [`packages/nfse-nacional/`](packages/nfse-nacional) | Montagem da DPS e troca com a SEFIN Nacional. |
| [`packages/fiscal-data/`](packages/fiscal-data) | Dados que mudam por ato do governo: endereços, leiautes e schemas XSD oficiais. |
| [`packages/vault-client/`](packages/vault-client) | Cliente da API para falar com o cofre. |

## Instalar o cofre

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/nfapi/tree/main/vault)

Veja o [README do cofre](vault/README.md) para o passo a passo.

## Desenvolvimento

Requer Node 22 e pnpm.

```bash
pnpm install
pnpm --dir vault install
pnpm test
```

## Licença

[MIT](LICENSE)
