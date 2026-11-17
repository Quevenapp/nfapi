# NFapi

Emissor open source de notas fiscais brasileiras — **NFS-e** (Sistema Nacional), **NF-e** e **NFC-e** — que roda inteiro na conta Cloudflare do próprio emitente.

Cada emitente instala um **cofre**: um Worker que guarda o certificado digital A1, expõe a API de emissão, fala com o governo e arquiva os XML. Não há serviço intermediário: os seus sistemas chamam o seu cofre, e o seu cofre chama o governo. Ninguém além de você recebe o certificado ou as notas.

> **Estado: em desenvolvimento.** A emissão e o cancelamento de NFS-e já foram validados com notas reais na SEFIN Nacional. A NF-e (emissão, carta de correção e cancelamento) e a NFC-e (emissão, cancelamento e emissão em contingência offline) já foram aceitas pela SEFAZ-SP em homologação, inclusive pela API de um cofre publicado no Cloudflare. Ainda sem teste contra uma SEFAZ de verdade: a inutilização, a fila de transmissão da contingência e o cancelamento por substituição. Ainda não há DANFE em PDF, contingência da NF-e nem notas de exportação e importação.

## Como funciona

```
Seu sistema (ERP, loja, Wabotia...)
        │  chave de API
        ▼
Cofre NFapi (na sua conta Cloudflare)
valida · numera · monta o XML · assina com o A1 · arquiva
        │  mTLS
        ▼
SEFAZ / NFS-e Nacional
```

O código do cofre é mantido neste repositório. Quando o governo muda uma regra, um endereço ou um leiaute, a correção é publicada no canal estável (branch `cofre-estavel`) e cada emitente a instala pelo botão **Atualizar** da tela do próprio cofre.

## Componentes

| Pasta | O que é |
|---|---|
| [`vault/`](vault) | O cofre: certificado, API de emissão, regras fiscais, transporte mTLS e arquivo. Instalável pelo botão Deploy to Cloudflare. |
| [`vault/docs/openapi.json`](vault/docs/openapi.json) | O contrato da API (OpenAPI 3.1), gerado dos mesmos schemas que validam os pedidos. |
| [`vault/schemas/`](vault/schemas) | Schemas XSD oficiais usados para validar os documentos nos testes. |
| [`apps/site/`](apps/site) | O site: apresentação e a página de instalação do cofre, com gerador de segredo. |
| [`tools/`](tools) | Scripts de apoio, como a emissão de uma NFS-e de teste a partir desta máquina. |

## Instalar o cofre

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/nfapi/tree/main/vault)

O passo a passo, com gerador do segredo do cofre, está em <https://nfapi.queven.app/instalar>. A referência da API e os detalhes de segurança estão no [README do cofre](vault/README.md).

## Desenvolvimento

Requer Node 22 ou mais novo e pnpm.

```bash
pnpm --dir vault install
```

```bash
pnpm test
```

## Licença

[MIT](LICENSE)
