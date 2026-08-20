# Política de Segurança

O paas é um painel que **administra uma VPS inteira** — segurança é levada a sério por aqui.
Se você encontrou uma vulnerabilidade, agradecemos o reporte responsável.

## Reportando uma vulnerabilidade

⚠️ **Não abra uma issue pública** para vulnerabilidades de segurança.

Envie um e-mail para:

**[contato@tws.tec.br](mailto:contato@tws.tec.br)**

Inclua, se possível:

- Descrição da vulnerabilidade e impacto potencial;
- Passos para reproduzir (ou prova de conceito);
- Versão/commit afetado e ambiente (SO, versão do Docker, etc.).

**O que esperar:**

- Confirmação de recebimento em até **72 horas**;
- Avaliação e, se confirmada, uma correção ou mitigação em até **90 dias** (antes disso,
  sempre que possível);
- Crédito ao pesquisador no anúncio da correção, se desejado;
- Pedimos que você não divulgue publicamente antes da correção estar disponível.

## Escopo

**Dentro do escopo:**

- O código deste repositório: `apps/server`, `apps/web`, `packages/*`, `scripts/*`;
- O instalador (`scripts/install.sh`) e os scripts de hardening (`scripts/hardening/`);
- O wizard de setup (autenticação por token, exposição da porta 9000);
- A API do painel (autenticação, autorização, injeção, path traversal, etc.).

**Fora do escopo:**

- Vulnerabilidades em dependências de terceiros sem prova de exploração através deste projeto
  (reporte ao upstream; nós atualizamos as dependências);
- Problemas que exigem acesso root/local à VPS (o painel assume o host como base de confiança);
- Configurações deliberadamente inseguras marcadas como "apenas para testes" em `examples/`;
- Negação de serviço por esgotamento de recursos da própria máquina.

## Práticas de segurança do projeto

- **Wizard protegido por token** de uso único (comparação em tempo constante), gerado pelo
  instalador com permissão 0600;
- **Nenhum shell arbitrário vindo da UI** — apenas ações pré-definidas e auditadas;
- **Docker socket nunca exposto via TCP**; acesso somente pelo socket local;
- **CORS same-origin** por padrão, headers de segurança (Helmet/CSP) e rate limiting;
- **Segredos em disco com modo 0600** e **redação de tokens/senhas nos logs**;
- **Auditoria** de todas as ações sensíveis (deploy, override de guardrail, hardening,
  alterações de e-mail e monitoramento);
- **Guardrails de deploy** que bloqueiam configurações perigosas (porta de banco exposta,
  credenciais fracas, container privilegiado) e exigem override explícito e auditado;
- **Hardening com rollback automático**: o usuário nunca perde acesso à máquina por causa
  de uma correção aplicada pelo painel.

## Versões suportadas

O projeto está em **beta** (`0.x`): apenas a branch `main` recebe correções de segurança.
Recomendamos sempre rodar a versão mais recente.
